"""Read-only registered account directory; no DDL, telemetry or external I/O.

Production reads Auth under the existing private transaction and live admin check.
Training counters cover CURRENT authorized shared projections, never all training.
"""
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import (Table, Column, MetaData, String, DateTime, Boolean, select,
                        literal, union_all, false, true, case, func, or_, and_, text)
from app.team_workspace import _uid
from app.team_workspace_models import WorkspaceOwner, CoachApplication, Team, TeamMember, TeamGrant, TeamSession

_AUTH = Table("users", MetaData(), Column("id", String), Column("email", String),
    Column("phone", String), Column("created_at", DateTime(timezone=True)),
    Column("last_sign_in_at", DateTime(timezone=True)), Column("phone_confirmed_at", DateTime(timezone=True)),
    Column("banned_until", DateTime(timezone=True)), Column("deleted_at", DateTime(timezone=True)),
    Column("is_anonymous", Boolean), schema="auth")
AUTH_COLUMNS = tuple(c.name for c in _AUTH.c)
COVERAGE = "仅当前有效共享中已接收的训练；按账号和场次去重，不含未共享、本机或其他备份训练。"
ACTIVITY = "仅认证服务记录的最近登录与当前共享训练的接收时间；不代表在线状态、最近操作或实际练习时间。"
DURATION = "App 使用时长指前台可见且正在交互的累计时间；当前没有采集此数据，历史不可补算。"


def stamp(value):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def masked(value):
    if not value:
        return None
    if "@" in value:
        local, domain = value.rsplit("@", 1)
        return (local[:1] + "***@" + domain) if local and domain else "***"
    return "***" + value[-4:]


def invalid():
    raise HTTPException(422, "用户查询条件无效")


class AdminUserDirectoryMixin:
    def _accounts(self, db):
        dialect = db.get_bind().dialect.name
        if dialect == "postgresql":
            if self.test_directory is not None:
                raise HTTPException(503, "管理身份服务配置无效")
            # Fixed dependency list; no secret, contact, or caller value enters this check.
            ready = db.execute(text("""SELECT count(*) = 9 AND bool_and(
                has_column_privilege(current_user, 'auth.users', a.attname, 'SELECT'))
                FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = to_regclass('auth.users') AND NOT a.attisdropped
                AND a.attname IN ('id','email','phone','created_at','last_sign_in_at',
                    'phone_confirmed_at','banned_until','deleted_at','is_anonymous')""")).scalar_one()
            if ready is not True:
                raise HTTPException(503, "注册目录读取依赖尚未就绪")
            return _AUTH
        if dialect != "sqlite" or self.test_directory is None:
            raise HTTPException(503, "注册目录尚未接入")
        # Explicit synthetic fixture, never used with the production dialect.
        rows = []
        for uid, row in self.test_directory.items():
            values = {**row, "id": uid, "is_anonymous": row.get("is_anonymous", False)}
            for name in ("created_at", "last_sign_in_at", "phone_confirmed_at", "banned_until", "deleted_at"):
                values[name] = stamp(values.get(name))
            rows.append(select(*(literal(values.get(name)).label(name) for name in AUTH_COLUMNS)))
        if not rows:
            rows = [select(*(literal(None).label(name) for name in AUTH_COLUMNS)).where(false())]
        return union_all(*rows).subquery("synthetic_accounts") if len(rows) > 1 else rows[0].subquery("synthetic_accounts")

    def _account_query(self, db):
        u = self._accounts(db)
        now = self.now() if db.get_bind().dialect.name == "postgresql" else stamp(self.now())
        is_admin = WorkspaceOwner.user_id.is_not(None)
        is_coach = CoachApplication.status == "approved"
        state = case((u.c.banned_until > now, "banned"),
                     (or_(u.c.phone_confirmed_at.is_(None), u.c.phone.is_(None), u.c.phone == ""), "pending_verification"),
                     else_="active")
        return select(u.c.id.label("user_id"), u.c.email, u.c.phone,
            u.c.created_at, u.c.last_sign_in_at, u.c.phone_confirmed_at, u.c.banned_until,
            is_admin.label("is_admin"), case((is_coach, True), else_=False).label("is_coach"),
            CoachApplication.status.label("coach_status"), state.label("state")).select_from(
                u.outerjoin(WorkspaceOwner, and_(WorkspaceOwner.user_id == func.cast(u.c.id, String), WorkspaceOwner.slot == 1))
                 .outerjoin(CoachApplication, CoachApplication.user_id == func.cast(u.c.id, String))).where(
                    u.c.deleted_at.is_(None), u.c.is_anonymous.is_(False))

    @staticmethod
    def _account_json(row):
        roles = ["user"] + (["coach"] if row["is_coach"] else []) + (["admin"] if row["is_admin"] else [])
        return dict(userId=str(row["user_id"]), phoneMasked=masked(row["phone"]), emailMasked=masked(row["email"]),
            registeredAt=stamp(row["created_at"]), lastSignInAt=stamp(row["last_sign_in_at"]),
            phoneVerified=row["phone_confirmed_at"] is not None and bool(row["phone"]),
            bannedUntil=stamp(row["banned_until"]), roles=roles, coachStatus=row["coach_status"],
            state=row["state"])

    def users_search(self, actor, body):
        self.ready()
        if type(body) is not dict or set(body) != {"query", "page", "limit", "role", "state"}:
            invalid()
        q, page, limit, role, state = (body[k] for k in ("query", "page", "limit", "role", "state"))
        if (not isinstance(q, str) or len(q) > 120 or type(page) is not int or not 1 <= page <= 1000000
            or type(limit) is not int or not 1 <= limit <= 50 or role not in ("all", "user", "coach", "admin")
            or state not in ("all", "active", "pending_verification", "banned")):
            invalid()
        q = q.strip().lower()
        with self.transaction(actor) as db:
            self._admin(db, actor)
            base = self._account_query(db).cte("registered_accounts")
            conditions = []
            if q:
                pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                conditions.append(or_(*(func.lower(func.cast(base.c[name], String)).like(pattern, escape="\\")
                    for name in ("user_id", "email", "phone"))))
            if role == "coach": conditions.append(base.c.is_coach.is_(True))
            if role == "admin": conditions.append(base.c.is_admin.is_(True))
            if role == "user": conditions.append(and_(base.c.is_admin.is_(False), base.c.is_coach.is_(False)))
            if state != "all": conditions.append(base.c.state == state)
            filtered = select(base).where(*conditions).cte("matched_accounts")
            counts = select(select(func.count()).select_from(base).scalar_subquery().label("registered_total"),
                select(func.count()).select_from(base).where(base.c.state == "active").scalar_subquery().label("phone_verified_total"),
                select(func.count()).select_from(filtered).scalar_subquery().label("matched_total")).subquery()
            page_rows = select(filtered).order_by(filtered.c.created_at.desc().nulls_last(), filtered.c.user_id).limit(limit).offset((page-1)*limit).subquery()
            rows = db.execute(select(counts, page_rows).select_from(counts.outerjoin(page_rows, true()))
                .order_by(page_rows.c.created_at.desc().nulls_last(), page_rows.c.user_id)).mappings().all()
            first = rows[0]
            total = first["matched_total"]
            return dict(items=[self._account_json(r) for r in rows if r["user_id"] is not None],
                page=page, limit=limit, hasMore=page*limit < total, total=total,
                registeredTotal=first["registered_total"], phoneVerifiedTotal=first["phone_verified_total"],
                population="非匿名且未删除的 Auth 账户，含待手机验证和封禁账户；已验手机号数仅统计已验证且未封禁，不代表完成全部登录准入审核。",
                activityDefinition=ACTIVITY, generatedAt=self.stamp())

    def _shared_usage(self, db, uid):
        def unavailable():
            return dict(status="unavailable", sessions=None, arrows=None, latestReceivedAt=None, coverage=COVERAGE)
        # Read each scope once, then project only scalar aggregate inputs. Never
        # repeat a 5,000-ID grant for every training record in that grant.
        grants = db.scalars(select(TeamGrant)
            .join(TeamMember, and_(TeamMember.team_id == TeamGrant.team_id, TeamMember.id == TeamGrant.member_id))
            .join(Team, Team.id == TeamMember.team_id)
            .join(CoachApplication, and_(CoachApplication.user_id == Team.coach_id, CoachApplication.status == "approved"))
            .where(TeamMember.user_id == uid, TeamMember.status == "active", TeamGrant.active.is_(True),
                TeamGrant.recipient_id == Team.coach_id,
                or_(TeamGrant.expires_on.is_(None), TeamGrant.expires_on >= self.today()))
            .limit(33)).all()
        if len(grants) > 32 or sum(len(g.session_ids) for g in grants) > 20000:
            return unavailable()
        scopes = {(g.team_id, g.member_id): (set(g.session_ids), g.include_future, g.future_from) for g in grants}
        p = TeamSession.projection
        rows = db.execute(select(TeamSession.team_id, TeamSession.member_id, TeamSession.session_id,
                TeamSession.source_revision, TeamSession.source_hash,
                p["date"].as_string().label("day"), p["updatedAt"].as_string().label("received"),
                p["summary"]["arrows"].as_integer().label("arrows"))
            .where(or_(*(and_(TeamSession.team_id == tid, TeamSession.member_id == mid) for tid, mid in scopes)))
            .limit(10001)).mappings().all() if scopes else []
        if len(rows) > 10000:
            return unavailable()
        selected, conflicts, received_times = {}, set(), []
        for row in rows:
            sid, day = row["session_id"], row["day"]
            ids, include_future, future_from = scopes[(row["team_id"], row["member_id"])]
            if not (sid in ids or (include_future and future_from and day and day >= future_from)):
                continue
            if stamp(row["received"]): received_times.append(stamp(row["received"]))
            old = selected.get(sid)
            if old is None or row["source_revision"] > old["source_revision"]:
                selected[sid] = row
                conflicts.discard(sid)
            elif row["source_revision"] == old["source_revision"]:
                if row["source_hash"] != old["source_hash"]:
                    conflicts.add(sid)
                if (stamp(row["received"]) or "") > (stamp(old["received"]) or ""):
                    selected[sid] = row
        valid_arrows = all(type(r["arrows"]) is int and 0 <= r["arrows"] <= 30000 for r in selected.values())
        latest = max(received_times, default=None)
        return dict(status="conflicting" if conflicts or not valid_arrows else "available",
            sessions=len(selected), arrows=None if conflicts or not valid_arrows else sum(r["arrows"] for r in selected.values()),
            latestReceivedAt=latest, coverage=COVERAGE)

    def user_detail(self, actor, body):
        self.ready()
        if type(body) is not dict or set(body) != {"userId"}:
            invalid()
        uid = _uid(body["userId"])
        with self.transaction(actor) as db:
            self._admin(db, actor)
            accounts = self._account_query(db).subquery()
            row = db.execute(select(accounts).where(func.cast(accounts.c.user_id, String) == uid)).mappings().one_or_none()
            if row is None:
                raise HTTPException(404, "注册账号不存在")
            account = self._account_json(row)
            usage = self._shared_usage(db, uid)
            activity = max(filter(None, (account["lastSignInAt"], usage["latestReceivedAt"])), default=None)
            return dict(account=account, training=usage,
                activity=dict(lastObservedAt=activity, lastSignInAt=account["lastSignInAt"],
                    lastSharedReceiptAt=usage["latestReceivedAt"], definition=ACTIVITY),
                usageDuration=dict(status="not_collected", seconds=None, collectionStartedAt=None, definition=DURATION),
                generatedAt=self.stamp())

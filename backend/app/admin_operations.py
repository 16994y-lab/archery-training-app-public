"""Bounded product support and administrator operations. No startup DDL or I/O.

All authorization and mutations use the original TeamWorkspace transaction.
Published announcements are immutable snapshots until an explicit publish action.
Local tests inject synthetic accounts only into SQLite, never PostgreSQL.
"""
from copy import deepcopy
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.admin_user_directory import AdminUserDirectoryMixin
from app.admin_sms_usage import AdminSmsUsageMixin
from app.admin_provider_sms import AdminProviderSmsMixin
from app.team_workspace import TeamWorkspace, _TeamRoute, _uid, _string, team_actor
from app.team_workspace_models import CoachApplication, Team, TeamMember, WorkspaceOwner, TeamAudit
from app.admin_operations_models import (OperationsBase, ProductFeedback, DonationSubmission, OperationsIncident,
    ProductAnnouncement, OperationsRequest, OperationsAudit, BusinessMetricEvent, BusinessMetricStream)


def invalid():
    raise HTTPException(422, "填写内容或查询条件无效")


def conflict():
    raise HTTPException(409, "记录已变化，请读取最新状态后核对")


def exact(body, keys):
    if type(body) is not dict or set(body) != set(keys):
        invalid()


def integer(value, low=0, high=2**31-1):
    if type(value) is not int or not low <= value <= high:
        invalid()
    return value


def option(value, choices):
    if not isinstance(value, str) or value not in choices:
        invalid()
    return value


def page_args(body):
    return integer(body["page"], 1, 200), integer(body["limit"], 1, 50)


def safe_date(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        invalid()
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        invalid()
    return value


def mask(value, tail=2):
    if not value:
        return None
    value = str(value)
    return value[:min(2, max(1, len(value)-tail-1))] + "***" + (value[-tail:] if len(value) > tail+2 else "")


class AdminOperations(AdminProviderSmsMixin, AdminSmsUsageMixin, AdminUserDirectoryMixin, TeamWorkspace):
    def __init__(self, session_factory=None, clock=None, session_verifier=None, *, enabled=False, test_directory=None,
                 rewards=None, registration_profile=None, provider_reader=None):
        super().__init__(session_factory, clock, session_verifier)
        self.enabled = enabled is True
        self.test_directory = test_directory
        self.rewards = rewards
        self.registration_profile = registration_profile
        self.provider_reader = provider_reader

    @contextmanager
    def transaction(self, actor):
        with super().transaction(actor) as db:
            if db.get_bind().dialect.name == "postgresql":
                from app.rewards_installation import assert_rewards_ready
                assert_rewards_ready(db, model_metadata=OperationsBase.metadata, invitation_dependencies=False)
            yield db

    def ready(self):
        if not self.enabled:
            raise HTTPException(503, "反馈与管理服务尚未接入")

    def directory(self, db, uid):
        if db.get_bind().dialect.name == "postgresql":
            if self.test_directory is not None:
                raise HTTPException(503, "管理身份服务配置无效")
            row = db.execute(text("SELECT id::text AS id, phone, phone_confirmed_at FROM auth.users "
                "WHERE id=CAST(:uid AS uuid) AND deleted_at IS NULL AND is_anonymous IS FALSE "
                "AND (banned_until IS NULL OR banned_until<=CURRENT_TIMESTAMP)"), {"uid": uid}).mappings().one_or_none()
        elif db.get_bind().dialect.name == "sqlite" and self.test_directory is not None:
            row = self.test_directory.get(uid)
        else:
            raise HTTPException(503, "管理身份服务尚未接入")
        if not row:
            raise HTTPException(404, "账号不存在或当前不可管理")
        return row

    def new_record(self):
        stamp = self.stamp()
        return dict(id=str(uuid4()), version=1, created_at=stamp, updated_at=stamp)

    @staticmethod
    def base(row):
        return dict(id=row.id, version=row.version, createdAt=row.created_at, updatedAt=row.updated_at)

    def feedback_json(self, row, admin=False):
        value = {**self.base(row), "category": row.category, "text": row.text, "appVersion": row.app_version,
                 "page": row.page, "state": row.state}
        if admin:
            value.update(userId=row.user_id, source=row.source, internalNote=row.internal_note)
        return value

    def donation_json(self, row, admin=False):
        value = {**self.base(row), "amount": row.amount, "state": row.state}
        if admin:
            value.update(userId=row.user_id, reference=row.reference, sourceId=row.source_id)
        return value

    def incident_json(self, row, admin=False):
        value = {**self.base(row), "kind": row.kind, "state": row.state}
        if admin:
            value.update(userId=row.user_id, detail=row.detail, originalRequestId=row.original_request_id,
                         internalNote=row.internal_note)
        return value

    def announcement_json(self, row):
        return {**self.base(row), "draft": deepcopy(row.draft), "published": deepcopy(row.published), "state": row.state}

    @staticmethod
    def paged(db, query, page, limit, serializer):
        values = db.scalars(query.offset((page-1)*limit).limit(limit+1)).all()
        return dict(items=[serializer(row) for row in values[:limit]], page=page, limit=limit, hasMore=len(values)>limit)

    def limit_intake(self, db, model, actor, maximum):
        since = (self.now()-timedelta(days=1)).isoformat(timespec="microseconds")
        count = db.scalar(select(func.count()).select_from(model).where(model.user_id == actor, model.created_at >= since))
        if count >= maximum:
            raise HTTPException(429, "今天提交较多，请稍后再试或查看已有记录")

    def mutate(self, actor, body, operation, change, admin=False):
        self.ready()
        request_id = _uid(body["requestId"])
        digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.transaction(actor) as db:
            if admin:
                self._admin(db, actor)
            old = db.get(OperationsRequest, (str(actor), request_id))
            if old:
                if old.operation != operation or old.body_digest != digest:
                    conflict()
                return deepcopy(old.result)
            result, subject, version = change(db)
            db.add(OperationsRequest(actor_id=str(actor), request_id=request_id, operation=operation,
                body_digest=digest, result=result, at=self.stamp()))
            db.add(OperationsAudit(id=str(uuid4()), actor_id=str(actor), subject_id=subject, action=operation,
                result="success", reason=_string(body.get("reason", ""), 500), version=version, at=self.stamp()))
            db.flush()
            return result

    def request_read(self, actor, body, admin=False):
        self.ready()
        exact(body, ("requestId",))
        request_id = _uid(body["requestId"])
        with self.transaction(actor) as db:
            if admin:
                self._admin(db, actor)
            row = db.get(OperationsRequest, (str(actor), request_id))
            if row and row.operation.startswith("admin."):
                self._admin(db, actor)
            return {"found": bool(row), "result": deepcopy(row.result) if row else None}

    def feedback_create(self, actor, body, admin=False):
        exact(body, ("requestId", "userId", "category", "text", "source") if admin else
              ("requestId", "category", "text", "appVersion", "page"))
        category = option(body["category"], ("bug", "suggestion", "account", "other"))
        content = _string(body["text"], 4000, True)
        user = _uid(body["userId"]) if admin else str(actor)
        source = option(body["source"], ("qq", "manual")) if admin else "app"
        version = "" if admin else _string(body["appVersion"], 40)
        page = "other" if admin else option(body["page"], ("training", "review", "profile", "support", "other"))
        def change(db):
            if admin:
                self.directory(db, user)
            else:
                self.limit_intake(db, ProductFeedback, actor, 10)
            row = ProductFeedback(**self.new_record(), user_id=user, category=category, text=content,
                app_version=version, page=page, source=source, state="pending", internal_note="")
            db.add(row)
            return {"feedback": self.feedback_json(row, admin)}, row.id, row.version
        return self.mutate(actor, body, "admin.feedback.create" if admin else "feedback.create", change, admin)

    def donation_create(self, actor, body):
        exact(body, ("requestId", "amount", "reference"))
        amount = body["amount"]
        if not isinstance(amount, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?", amount):
            invalid()
        try:
            amount = format(Decimal(amount).quantize(Decimal("0.01")), "f")
            if Decimal(amount) <= 0:
                invalid()
        except InvalidOperation:
            invalid()
        reference = _string(body["reference"], 120, True)
        digest = hashlib.sha256(reference.encode()).hexdigest()
        def change(db):
            old = db.scalar(select(DonationSubmission).where(DonationSubmission.user_id == actor,
                                                            DonationSubmission.evidence_digest == digest))
            if old:
                raise HTTPException(409, "已有相同核对线索的申请，请先查看原记录")
            self.limit_intake(db, DonationSubmission, actor, 5)
            row = DonationSubmission(**self.new_record(), user_id=str(actor), amount=amount, reference=reference,
                evidence_digest=digest, state="pending", source_id=None)
            db.add(row)
            return {"donation": self.donation_json(row)}, row.id, row.version
        return self.mutate(actor, body, "donation.create", change)

    def incident_create(self, actor, body):
        exact(body, ("requestId", "kind", "originalRequestId", "detail"))
        kind = option(body["kind"], ("claim_unknown", "claim_dispute", "donation_duplicate", "contact_conflict", "other"))
        original = None if body["originalRequestId"] is None else _uid(body["originalRequestId"])
        detail = _string(body["detail"], 2000, True)
        def change(db):
            self.limit_intake(db, OperationsIncident, actor, 10)
            row = OperationsIncident(**self.new_record(), user_id=str(actor), kind=kind, original_request_id=original,
                detail=detail, state="pending", internal_note="")
            db.add(row)
            return {"incident": self.incident_json(row)}, row.id, row.version
        return self.mutate(actor, body, "incident.create", change)

    def records_search(self, actor, body, kind, admin=False):
        self.ready()
        exact(body, ("state", "query", "page", "limit") if admin else ("page", "limit"))
        model, states, serializer = {
            "feedback": (ProductFeedback, ("pending", "processing", "resolved"), self.feedback_json),
            "donations": (DonationSubmission, ("pending", "confirmed", "rejected"), self.donation_json),
            "incidents": (OperationsIncident, ("pending", "processing", "resolved", "dismissed"), self.incident_json),
        }[kind]
        page, limit = page_args(body)
        query = select(model)
        if admin:
            if body["state"] is not None:
                query = query.where(model.state == option(body["state"], states))
            term = _string(body["query"], 36)
            if term:
                _uid(term)
                query = query.where(or_(model.id == term, model.user_id == term))
        else:
            query = query.where(model.user_id == str(actor))
        with self.transaction(actor) as db:
            if admin:
                self._admin(db, actor)
            return self.paged(db, query.order_by(model.updated_at.desc(), model.id), page, limit,
                              lambda row: serializer(row, admin))

    def record_update(self, actor, body, kind):
        exact(body, ("requestId", "id", "version", "state", "sourceId", "reason") if kind == "donations" else
              ("requestId", "id", "version", "state", "internalNote", "reason"))
        key = _uid(body["id"])
        version = integer(body["version"], 1)
        _string(body["reason"], 500, True)
        model, states, serializer = {
            "feedback": (ProductFeedback, ("pending", "processing", "resolved"), self.feedback_json),
            "incidents": (OperationsIncident, ("pending", "processing", "resolved", "dismissed"), self.incident_json),
            "donations": (DonationSubmission, ("confirmed", "rejected"), self.donation_json),
        }[kind]
        state = option(body["state"], states)
        note = _string(body["internalNote"], 2000) if kind != "donations" else None
        source_id = (None if body["sourceId"] is None else _uid(body["sourceId"])) if kind == "donations" else None
        if kind == "donations" and ((state == "confirmed") != (source_id is not None)):
            invalid()
        def change(db):
            row = db.get(model, key)
            if not row:
                raise HTTPException(404, "记录不存在")
            if row.version != version:
                if kind == "feedback":
                    # Only this pre-write version mismatch confirms this new
                    # request did not commit. Idempotency collisions stay unknown.
                    raise HTTPException(409, "反馈已被更新，本次修改未保存。请重新查询后处理。")
                conflict()
            if kind == "donations":
                if row.state != "pending":
                    conflict()
                if source_id:
                    from app.rewards_models import RewardSource
                    source = db.get(RewardSource, source_id)
                    if (not source or self.rewards is None or source.service != self.rewards.service
                            or source.user_id != row.user_id or source.kind != "donation" or not source.active):
                        raise HTTPException(409, "请先核对真实赞赏并确认对应授予来源")
                    try:
                        if Decimal(source.details.get("amount", "0")) != Decimal(row.amount):
                            conflict()
                    except (InvalidOperation, TypeError):
                        conflict()
                    if db.scalar(select(DonationSubmission.id).where(DonationSubmission.source_id == source_id,
                                                                     DonationSubmission.id != row.id)):
                        raise HTTPException(409, "该赞赏来源已关联原申请，请核对重复申请")
                row.source_id = source_id
            else:
                row.internal_note = note
            row.state, row.version, row.updated_at = state, row.version+1, self.stamp()
            name = {"feedback": "feedback", "incidents": "incident", "donations": "donation"}[kind]
            return {name: serializer(row, True)}, row.id, row.version
        return self.mutate(actor, body, "admin."+kind+".update", change, True)

    def home(self, actor, body):
        self.ready()
        exact(body, ())
        items = []
        with self.transaction(actor) as db:
            self._admin(db, actor)
            for key, model, where in [
                ("coaches", CoachApplication, CoachApplication.status == "pending"),
                ("donations", DonationSubmission, DonationSubmission.state == "pending"),
                ("feedback", ProductFeedback, ProductFeedback.state != "resolved"),
                ("incidents", OperationsIncident, OperationsIncident.state.in_(("pending", "processing"))),
            ]:
                try:
                    with db.begin_nested():
                        count = db.scalar(select(func.count()).select_from(model).where(where))
                    items.append(dict(key=key, count=count, status="available"))
                except SQLAlchemyError:
                    items.append(dict(key=key, count=None, status="unavailable"))
        return {"generatedAt": self.stamp(), "items": items}

    def announcement_save(self, actor, body):
        exact(body, ("requestId", "id", "version", "title", "text", "kind", "target", "releaseVersion"))
        key = None if body["id"] is None else _uid(body["id"])
        expected = integer(body["version"])
        if (key is None) != (expected == 0):
            invalid()
        draft = dict(title=_string(body["title"], 100, True), text=_string(body["text"], 8000, True),
                     kind=option(body["kind"], ("announcement", "release")),
                     target=option(body["target"], ("user", "coach", "all")),
                     releaseVersion=_string(body["releaseVersion"], 40))
        if draft["kind"] == "release" and not draft["releaseVersion"]:
            invalid()
        def change(db):
            row = db.get(ProductAnnouncement, key) if key else None
            if key and not row:
                raise HTTPException(404, "公告不存在")
            if row and row.version != expected:
                conflict()
            if not row:
                row = ProductAnnouncement(**self.new_record(), state="draft", draft=draft,
                                          published=None, publication_revision=0)
                db.add(row)
            else:
                row.draft, row.version, row.updated_at = draft, row.version+1, self.stamp()
            return {"announcement": self.announcement_json(row)}, row.id, row.version
        return self.mutate(actor, body, "admin.announcement.save", change, True)

    def announcement_transition(self, actor, body, publish):
        exact(body, ("requestId", "id", "version", "reason"))
        key, expected = _uid(body["id"]), integer(body["version"], 1)
        _string(body["reason"], 500, True)
        def change(db):
            row = db.get(ProductAnnouncement, key)
            if not row:
                raise HTTPException(404, "公告不存在")
            if row.version != expected:
                conflict()
            if publish:
                row.publication_revision += 1
                row.published = {**deepcopy(row.draft), "id": row.id, "publishedAt": self.stamp(),
                                 "revision": row.publication_revision}
                row.state = "published"
            else:
                if row.state != "published":
                    conflict()
                row.state = "withdrawn"
            row.version, row.updated_at = row.version+1, self.stamp()
            return {"announcement": self.announcement_json(row)}, row.id, row.version
        return self.mutate(actor, body, "admin.announcement."+("publish" if publish else "withdraw"), change, True)

    def announcements_search(self, actor, body):
        self.ready()
        exact(body, ("state", "page", "limit"))
        page, limit = page_args(body)
        query = select(ProductAnnouncement)
        if body["state"] is not None:
            query = query.where(ProductAnnouncement.state == option(body["state"], ("draft", "published", "withdrawn")))
        with self.transaction(actor) as db:
            self._admin(db, actor)
            return self.paged(db, query.order_by(ProductAnnouncement.updated_at.desc(), ProductAnnouncement.id),
                              page, limit, self.announcement_json)

    def announcements_read(self, actor, body):
        self.ready()
        exact(body, ("target",))
        target = option(body["target"], ("user", "coach"))
        with self.transaction(actor) as db:
            if target == "coach":
                self._coach(db, actor)
            rows = db.scalars(select(ProductAnnouncement).where(ProductAnnouncement.state == "published",
                ProductAnnouncement.published["target"].as_string().in_((target, "all")))
                .order_by(ProductAnnouncement.updated_at.desc(), ProductAnnouncement.id).limit(50)).all()
            items = [deepcopy(row.published) for row in rows if row.published and row.published["target"] in (target, "all")][:50]
        return {"items": items, "generatedAt": self.stamp()}

    def profile(self, actor, body):
        self.ready()
        exact(body, ("userId",))
        uid = _uid(body["userId"])
        with self.transaction(actor) as db:
            self._admin(db, actor)
            user = self.directory(db, uid)
            coach = db.get(CoachApplication, uid)
            owner = db.get(WorkspaceOwner, 1)
            roles = ["user"] + (["coach"] if coach and coach.status == "approved" else [])
            if owner and owner.user_id == uid:
                roles.append("admin")
            teams = []
            for row in db.scalars(select(Team).where(Team.coach_id == uid)).all():
                teams.append(dict(id=row.id, name=row.name, memberStatus=None, role="coach"))
            for member, team in db.execute(select(TeamMember, Team).join(Team, Team.id == TeamMember.team_id)
                                          .where(TeamMember.user_id == uid)).all():
                teams.append(dict(id=team.id, name=team.name, memberStatus=member.status, role="member"))
            phone = user.get("phone") if user.get("phone_confirmed_at") else None
            if phone and re.fullmatch(r"(?:86|\+86)?1[3-9][0-9]{9}", phone):
                phone = phone[-11:]
            contacts = dict(phoneMasked=mask(phone, 4), qqMasked=None, status="unavailable")
            rewards = {"status": "unavailable", "items": []}
            invitations = {"inviterId": None, "invitees": [], "status": "unavailable"}
            if self.rewards is not None:
                try:
                    with db.begin_nested():
                        summary = self.rewards.admin_profile_summary(db, actor, uid)
                    contacts = {"phoneMasked": summary["phoneMasked"], "qqMasked": summary["qqMasked"], "status": "available"}
                    rewards = {"status": "available", "items": summary["rewards"],
                               "sourceCount": summary["sourceCount"], "activeSourceCount": summary["activeSourceCount"]}
                except (SQLAlchemyError, HTTPException):
                    pass
            if self.registration_profile is not None:
                try:
                    with db.begin_nested():
                        invitations = self.registration_profile(db, uid)
                except (SQLAlchemyError, HTTPException):
                    pass
            return dict(userId=uid, roles=roles, coachStatus=coach.status if coach else None, teams=teams,
                        contacts=contacts, rewards=rewards, invitations=invitations, generatedAt=self.stamp())

    def audits_search(self, actor, body):
        self.ready()
        exact(body, ("query", "action", "result", "from", "to", "page", "limit"))
        page, limit = page_args(body)
        term = _string(body["query"], 36)
        if term:
            _uid(term)
        action = body["action"]
        if action is not None and (not isinstance(action, str) or not re.fullmatch(r"[a-z][a-z_.-]{0,59}", action)):
            invalid()
        result = body["result"]
        if result is not None:
            option(result, ("success", "failure", "unknown"))
        start, end = safe_date(body["from"]), safe_date(body["to"])
        if start and end and start > end:
            invalid()
        with self.transaction(actor) as db:
            self._admin(db, actor)
            models = [(OperationsAudit, "operations"), (TeamAudit, "team")]
            try:
                from app.rewards_models import RewardAudit
                models.append((RewardAudit, "rewards"))
            except ImportError:
                pass
            items, unavailable = [], []
            for model, source in models:
                query = select(model)
                if term:
                    query = query.where(or_(model.actor_id == term, model.subject_id == term))
                if action:
                    query = query.where(model.action == action)
                if start:
                    query = query.where(model.at >= start+"T00:00:00")
                if end:
                    after = (datetime.strptime(end, "%Y-%m-%d")+timedelta(days=1)).date().isoformat()
                    query = query.where(model.at < after+"T00:00:00")
                if source == "operations":
                    if result:
                        query = query.where(model.result == result)
                elif result not in (None, "success"):
                    continue
                if source == "rewards" and self.rewards:
                    query = query.where(model.service == self.rewards.service)
                try:
                    with db.begin_nested():
                        rows = db.scalars(query.order_by(model.at.desc(), model.id.desc()).limit(page*limit+1)).all()
                        items.extend(dict(id=row.id, actorId=row.actor_id, subjectId=row.subject_id,
                            action=row.action, result=row.result if source == "operations" else "success",
                            reason=getattr(row, "reason", ""), at=row.at,
                            version=row.version, source=source) for row in rows)
                except SQLAlchemyError:
                    unavailable.append(source)
            items.sort(key=lambda value: (value["at"], value["source"], value["id"]), reverse=True)
            return dict(items=items[(page-1)*limit:page*limit], page=page, limit=limit,
                        hasMore=len(items)>page*limit, unavailableSources=unavailable)

    def metrics(self, actor, body):
        self.ready()
        exact(body, ("hours",))
        hours = integer(body["hours"], 24, 168)
        if hours not in (24, 168):
            invalid()
        now, streams = self.now(), []
        start = now-timedelta(hours=hours)
        stamp = now.isoformat(timespec="microseconds")
        with self.transaction(actor) as db:
            self._admin(db, actor)
            for key in ("registration", "claim", "sharing"):
                stream = db.get(BusinessMetricStream, key)
                empty = dict(key=key, status="not_connected", collectionStartedAt=None, latestAt=None,
                             success=None, failure=None, unknown=None, buckets=[], errors=[])
                if not stream:
                    streams.append(empty)
                    continue
                empty.update(collectionStartedAt=stream.started_at, latestAt=stream.refreshed_at)
                if stream.state != "active":
                    empty["status"] = "unknown"
                    streams.append(empty)
                    continue
                # Aggregation occurs in the database; individual events never leave it.
                totals = {name: 0 for name in ("success", "failure", "unknown")}
                since = start.isoformat(timespec="microseconds")
                conditions = (BusinessMetricEvent.stream == key, BusinessMetricEvent.at >= since,
                              BusinessMetricEvent.at <= stamp)
                for outcome, count in db.execute(select(BusinessMetricEvent.outcome, func.count())
                        .where(*conditions).group_by(BusinessMetricEvent.outcome)).all():
                    totals[outcome] = count
                errors = [dict(code=code, count=count) for code, count in db.execute(
                    select(BusinessMetricEvent.code, func.count()).where(*conditions, BusinessMetricEvent.outcome == "failure")
                    .group_by(BusinessMetricEvent.code).order_by(func.count().desc(), BusinessMetricEvent.code).limit(8)).all()]
                buckets = []
                width = timedelta(hours=hours/7 if hours == 168 else 4)
                edge = start
                while edge < now:
                    until = min(now, edge+width)
                    left, right = edge.isoformat(timespec="microseconds"), until.isoformat(timespec="microseconds")
                    counts = dict(success=0, failure=0, unknown=0)
                    for outcome, count in db.execute(select(BusinessMetricEvent.outcome, func.count()).where(
                            BusinessMetricEvent.stream == key, BusinessMetricEvent.at >= left,
                            (BusinessMetricEvent.at <= right if until == now else BusinessMetricEvent.at < right))
                            .group_by(BusinessMetricEvent.outcome)).all():
                        counts[outcome] = count
                    buckets.append({"from": left, "to": right, **counts})
                    edge = until
                stale = datetime.fromisoformat(stream.refreshed_at) < now-timedelta(hours=24)
                status = "stale" if stale else ("current" if sum(totals.values()) else "no_activity")
                streams.append({**empty, **totals, "status": status, "buckets": buckets, "errors": errors})
        return {"generatedAt": stamp, "from": start.isoformat(timespec="microseconds"), "streams": streams}

    def observe_failure(self, actor, operation, body, status, params=None):
        """Best-effort safe evidence after the failed business transaction rolls back.

        Never changes the original response or records success. Missing telemetry
        leaves its stream stale/unknown; raw exceptions and request data are omitted.
        """
        if not self.enabled or status not in (400, 403, 404, 409, 422, 429):
            return
        try:
            request_id = body.get("requestId") or body.get("registrationId")
            if request_id:
                _uid(request_id)
            admin = operation.startswith("admin.") or operation in ("issue", "revoke_claim", "donation", "refund", "revoke_source_admin", "contact_save", "admin_update")
            if not admin and operation != "upload":
                return
            with self.transaction(actor) as db:
                if admin:
                    self._admin(db, actor)
                code = {400: "invalid", 403: "forbidden", 404: "unavailable", 409: "conflict", 422: "invalid", 429: "rate_limited"}[status]
                if admin:
                    subject = body.get("id") or body.get("userId") or body.get("sourceId") or body.get("claimId") or str(actor)
                    _uid(subject)
                    stable = request_id or hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
                    audit_id = str(uuid5(NAMESPACE_URL, str(actor)+"|"+operation+"|"+stable+"|failure"))
                    if not db.get(OperationsAudit, audit_id):
                        db.add(OperationsAudit(id=audit_id, actor_id=str(actor), subject_id=subject,
                            action=operation, result="failure", reason=code, version=0, at=self.stamp()))
                elif operation == "upload":
                    from app.operations_telemetry import record_business_result
                    key = hashlib.sha256(json.dumps([params, body], sort_keys=True).encode()).hexdigest()
                    record_business_result(db, "sharing", str(actor), "failed:"+key, "failure", code, self.stamp())
        except (HTTPException, SQLAlchemyError, TypeError, ValueError, KeyError):
            # No private request values/driver errors; do not disguise failed evidence as zero.
            return


async def operations_body(request):
    if request.query_params or request.headers.get("content-type", "").split(";")[0].lower().strip() != "application/json":
        invalid()
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 32768:
            raise HTTPException(413, "请求内容过长")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                invalid()
            result[key] = value
        return result
    def reject_constant(_):
        invalid()
    try:
        body = json.loads(data, object_pairs_hook=unique, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        invalid()
    if type(body) is not dict:
        invalid()
    return body


def create_operations_router(session_factory=None, clock=None, session_verifier=None, *, enabled=False,
                             test_directory=None, rewards=None, registration_profile=None, service_instance=None):
    service = service_instance or AdminOperations(session_factory, clock, session_verifier, enabled=enabled,
        test_directory=test_directory, rewards=rewards, registration_profile=registration_profile)
    router = APIRouter(prefix="/api/team", tags=["product-operations"], route_class=_TeamRoute)
    @router.post('/admin/operations/sms/provider/summary')
    async def provider_summary(request: Request, actor: str = Depends(team_actor)):
        value = await service.provider_sms_summary(actor, await operations_body(request))
        return JSONResponse(value, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    routes = {
        "/operations/feedback/create": lambda a, b: service.feedback_create(a, b),
        "/operations/feedback/search": lambda a, b: service.records_search(a, b, "feedback"),
        "/operations/donations/create": service.donation_create,
        "/operations/donations/search": lambda a, b: service.records_search(a, b, "donations"),
        "/operations/incidents/create": service.incident_create,
        "/operations/announcements/read": service.announcements_read,
        "/operations/requests/read": service.request_read,
        "/admin/operations/home": service.home,
        "/admin/operations/sms/summary": service.sms_summary,
        "/admin/operations/users/search": service.users_search,
        "/admin/operations/users/detail": service.user_detail,
        "/admin/operations/profile": service.profile,
        "/admin/operations/feedback/create": lambda a, b: service.feedback_create(a, b, True),
        "/admin/operations/announcements/search": service.announcements_search,
        "/admin/operations/announcements/save": service.announcement_save,
        "/admin/operations/announcements/publish": lambda a, b: service.announcement_transition(a, b, True),
        "/admin/operations/announcements/withdraw": lambda a, b: service.announcement_transition(a, b, False),
        "/admin/operations/audits/search": service.audits_search,
        "/admin/operations/metrics": service.metrics,
        "/admin/operations/requests/read": lambda a, b: service.request_read(a, b, True),
    }
    for kind in ("feedback", "donations", "incidents"):
        routes[f"/admin/operations/{kind}/search"] = lambda a, b, k=kind: service.records_search(a, b, k, True)
        routes[f"/admin/operations/{kind}/update"] = lambda a, b, k=kind: service.record_update(a, b, k)
    def endpoint(operation, path):
        async def handle(request: Request, actor: str = Depends(team_actor)):
            body = await operations_body(request)
            try:
                value = await run_in_threadpool(operation, actor, body)
            except HTTPException as error:
                if path.startswith('/admin/') and path.rsplit('/', 1)[-1] in ('create', 'update', 'save', 'publish', 'withdraw'):
                    await run_in_threadpool(service.observe_failure, actor, path.strip('/').replace('/', '.'), body, error.status_code)
                raise
            except (TypeError, ValueError, KeyError, OverflowError, RecursionError):
                invalid()
            return JSONResponse(value, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        return handle
    for path, operation in routes.items():
        router.add_api_route(path, endpoint(operation, path), methods=["POST"])
    return router

"""Opt-in, text-only community API; production is disabled by default."""
import base64
import binascii
import hashlib
import json
import os
import time
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

from app.auth import current_user_id
from app.db import SessionLocal, database_url
from app.community_models import (
    CommunityComment, CommunityModerator, CommunityPost, CommunityProfile,
    CommunityRateWindow, CommunityReport,
)

router = APIRouter(prefix="/api/community", tags=["community"])


def community_get_db():
    with SessionLocal() as db:
        yield db


def community_actor_id(user_id: str = Depends(current_user_id)) -> str:
    # The legacy development auth returns a shared local-dev identity. It is
    # never acceptable for a multi-account community, even on localhost.
    if os.getenv("AUTH_MODE", "development") != "supabase" or user_id == "local-dev":
        raise HTTPException(503, "社区需经验证的独立账号；开发占位身份不可写入")
    if os.getenv("GONGXINGJI_SERVERLESS_DB") == "1":
        allowed = test_user_ids()
        if len(allowed) not in {2, 3}:
            raise HTTPException(503, "社区测试账号尚未配置完成")
        if user_id not in allowed:
            raise HTTPException(403, "此账号未获准参与社区测试")
    return user_id


def test_user_ids() -> set[str]:
    """Keep A/B fixed; admit one canonical third subject only while explicitly enabled."""
    values = os.getenv("COMMUNITY_TEST_ALLOWED_USER_IDS", "").split(",")
    if len(values) != 2:
        return set()
    try:
        parsed = [str(UUID(value.strip())) for value in values]
    except (ValueError, AttributeError):
        return set()
    if not all(raw.strip() == item for raw, item in zip(values, parsed)) or len(set(parsed)) != 2:
        return set()
    allowed = set(parsed)
    temporary_enabled = os.getenv("COMMUNITY_TEST_THIRD_ENABLED", "0")
    if temporary_enabled == "0":
        return allowed
    if temporary_enabled != "1":
        return set()
    third = os.getenv("COMMUNITY_TEST_THIRD_USER_ID", "").strip()
    try:
        canonical = str(UUID(third))
    except (ValueError, AttributeError):
        return set()
    return allowed | {third} if third == canonical and third not in allowed else set()


def local_gate(request: Request) -> None:
    """Allow the isolated fixture or an explicitly configured PostgreSQL API."""
    url = database_url()
    explicit = os.getenv("DATABASE_URL", "")
    try:
        parsed = make_url(explicit) if explicit else None
    except ArgumentError:
        parsed = None
    if os.getenv("COMMUNITY_MODE") == "production":
        try:
            origin = make_url(os.getenv("COMMUNITY_PUBLIC_ORIGIN", ""))
        except ArgumentError:
            origin = None
        bound_engine = SessionLocal.kw.get("bind")
        deployment_host = os.getenv("VERCEL_URL", "").lower().rstrip(".")
        protected_stage = (os.getenv("GONGXINGJI_SERVERLESS_DB") == "1"
                           and deployment_host.startswith("gongxingji-community-test-")
                           and deployment_host.endswith("-gong-xj.vercel.app")
                           and request.url.hostname == deployment_host)
        if (os.getenv("COMMUNITY_PRODUCTION_ENABLED") != "1"
                or os.getenv("AUTH_MODE") != "supabase"
                or parsed is None or parsed.get_backend_name() != "postgresql"
                or url != explicit or bound_engine is None or bound_engine.url != parsed
                or origin is None or origin.drivername != "https"
                or origin.username or origin.password or origin.query
                or origin.database not in (None, "", "/")
                or not origin.host or (request.url.hostname != origin.host and not protected_stage)):
            raise HTTPException(503, "社区正式服务未完成授权配置")
        return
    isolated_file = Path(parsed.database).resolve() if parsed and parsed.database else None
    temporary_root = Path(tempfile.gettempdir()).resolve()
    client_ok = (request.client is not None and request.client.host in {"127.0.0.1", "::1"}) or (
        request.client is None and request.url.hostname in {"testserver", "testclient"}
        and os.getenv("COMMUNITY_ASGI_TEST") == "1")
    if (os.getenv("COMMUNITY_MODE") != "isolated-local"
            or parsed is None or parsed.drivername != "sqlite"
            or parsed.query or not parsed.database or not Path(parsed.database).is_absolute()
            or isolated_file is None or not isolated_file.is_relative_to(temporary_root)
            or not isolated_file.name.startswith("community-") or isolated_file.suffix != ".sqlite"
            or os.getenv("COMMUNITY_LOCAL_DATABASE_URL") != explicit
            or url != explicit
            or request.url.hostname not in {"127.0.0.1", "localhost", "testserver", "testclient"}
            or not client_ok):
        raise HTTPException(503, "社区仅在明确配置的本机隔离环境开放")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    # SQLite drops timezone metadata even for DateTime(timezone=True).
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _clean(value: str, low: int, high: int, label: str) -> str:
    value = value.strip()
    # FastAPI's default validation error echoes invalid input and cannot UTF-8
    # encode a lone surrogate. Raise a safe HTTP error before that path.
    if any(unicodedata.category(c) == "Cs" for c in value):
        raise HTTPException(422, f"{label}不能含无效 Unicode 字符")
    if not low <= len(value) <= high or any(unicodedata.category(c) in {"Cc", "Cf"} and c not in "\n\t" for c in value):
        raise ValueError(f"{label}需为 {low}–{high} 字且不能含控制字符")
    return value


class NicknameInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nickname: str

    @field_validator("nickname")
    @classmethod
    def valid_nickname(cls, value: str) -> str:
        value = _clean(value, 2, 20, "昵称")
        if any(c in "\n\t" or unicodedata.category(c) in {"Zl", "Zp"} for c in value):
            raise ValueError("昵称不能换行")
        if len(unicodedata.normalize("NFKC", value).casefold()) > 80:
            raise ValueError("昵称归一化后过长")
        return value


class BodyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str

    @field_validator("body")
    @classmethod
    def valid_body(cls, value: str) -> str:
        return _clean(value, 1, 500, "正文")


class CommentInput(BodyInput):
    @field_validator("body")
    @classmethod
    def valid_comment(cls, value: str) -> str:
        return _clean(value, 1, 300, "评论")


class ReportInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_kind: Literal["post", "comment"]
    target_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    reason: Literal["spam", "abuse", "privacy", "other"]


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["hide", "dismiss"]


def _key(value: str | None) -> str:
    if not value or not 8 <= len(value) <= 128 or not value.isascii() or not all(c.isalnum() or c in "-_" for c in value):
        raise HTTPException(428, "发布必须提供 8–128 位 Idempotency-Key")
    return value


def _hash(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _revision(value: str | None) -> int:
    if value is None:
        raise HTTPException(428, "删除必须携带 If-Match 修订号")
    try:
        number = int(value.strip('"'))
    except ValueError as error:
        raise HTTPException(400, "If-Match 修订号无效") from error
    if number < 1:
        raise HTTPException(400, "If-Match 修订号无效")
    return number


def _profile(db: Session, owner: str) -> CommunityProfile:
    profile = db.get(CommunityProfile, owner)
    if profile is None:
        raise HTTPException(409, "请先设置社区昵称")
    return profile


def _nicknames(db: Session, owners: set[str]) -> dict[str, str]:
    if not owners:
        return {}
    return dict(db.execute(select(CommunityProfile.owner_id, CommunityProfile.nickname).where(CommunityProfile.owner_id.in_(owners))).all())


def _post_value(item: CommunityPost, actor: str, names: dict[str, str], comment_count: int = 0) -> dict:
    return {"id": item.id, "nickname": names.get(item.owner_id, "已注销用户"), "body": item.body,
            "createdAt": _as_utc(item.created_at).isoformat(), "revision": item.revision,
            "mine": item.owner_id == actor, "status": item.status, "commentCount": comment_count}


def _comment_value(item: CommunityComment, actor: str, names: dict[str, str]) -> dict:
    return {"id": item.id, "postId": item.post_id, "nickname": names.get(item.owner_id, "已注销用户"),
            "body": item.body, "createdAt": _as_utc(item.created_at).isoformat(), "revision": item.revision,
            "mine": item.owner_id == actor, "status": item.status}


def _cursor(value: str | None) -> tuple[datetime, str] | None:
    if value is None:
        return None
    if len(value) > 256:
        raise HTTPException(400, "分页游标无效")
    try:
        raw = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        date = datetime.fromisoformat(raw[0])
        if not isinstance(raw[1], str) or len(raw[1]) != 36:
            raise ValueError()
        return _as_utc(date), raw[1]
    except (ValueError, TypeError, IndexError, KeyError, OverflowError, UnicodeDecodeError, binascii.Error) as error:
        raise HTTPException(400, "分页游标无效") from error


def _next(items: list) -> str | None:
    if not items:
        return None
    raw = json.dumps([_as_utc(items[-1].created_at).isoformat(), items[-1].id]).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _consume(db: Session, owner: str, kind: str, duration: int, maximum: int) -> None:
    bucket = int(time.time() // duration)
    changed = db.execute(update(CommunityRateWindow).where(
        CommunityRateWindow.owner_id == owner, CommunityRateWindow.kind == kind,
        CommunityRateWindow.bucket == bucket, CommunityRateWindow.uses < maximum,
    ).values(uses=CommunityRateWindow.uses + 1)).rowcount
    if changed:
        return
    existing = db.get(CommunityRateWindow, (owner, kind, bucket))
    if existing:
        raise HTTPException(429, "操作过于频繁，请稍后再试")
    db.add(CommunityRateWindow(owner_id=owner, kind=kind, bucket=bucket, uses=1))
    db.flush()


def _write_once(db: Session, model, owner: str, key: str, request_hash: str, make):
    existing = db.scalar(select(model).where(model.owner_id == owner, model.idempotency_key == key))
    if existing:
        if existing.request_hash != request_hash:
            raise HTTPException(409, "同一请求标识对应不同内容")
        return existing, False
    try:
        record = make()
        db.add(record)
        db.commit()
        db.refresh(record)
        return record, True
    except IntegrityError as error:
        db.rollback()
        existing = db.scalar(select(model).where(model.owner_id == owner, model.idempotency_key == key))
        if existing and existing.request_hash == request_hash:
            return existing, False
        if existing:
            raise HTTPException(409, "同一请求标识对应不同内容") from error
        # A simultaneous rate-window insertion failed closed; the caller may retry.
        raise HTTPException(503, "并发写入未完成，请使用同一请求标识重试") from error


@router.get("/profile", dependencies=[Depends(local_gate)])
def get_profile(db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    profile = db.get(CommunityProfile, actor)
    return {"nickname": profile.nickname if profile else None}


@router.put("/profile", dependencies=[Depends(local_gate)])
def put_profile(value: NicknameInput, db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    profile = db.get(CommunityProfile, actor)
    if profile and profile.nickname == value.nickname:
        return {"nickname": profile.nickname}
    nickname_key = unicodedata.normalize("NFKC", value.nickname).casefold()
    taken = db.scalar(select(CommunityProfile.owner_id).where(CommunityProfile.nickname_key == nickname_key))
    if taken and taken != actor:
        raise HTTPException(409, "此昵称已被使用，请换一个")
    _consume(db, actor, "profile", 86400, 5)
    if profile:
        profile.nickname, profile.nickname_key, profile.updated_at = value.nickname, nickname_key, _now()
    else:
        profile = CommunityProfile(owner_id=actor, nickname=value.nickname, nickname_key=nickname_key, updated_at=_now())
        db.add(profile)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "昵称已被使用或并发更新未完成") from error
    return {"nickname": profile.nickname}


@router.get("/posts", dependencies=[Depends(local_gate)])
def list_posts(limit: int = Query(default=20, ge=1, le=50), cursor: str | None = None,
               db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    query = select(CommunityPost).where(or_(CommunityPost.status == "visible",
                                            and_(CommunityPost.owner_id == actor, CommunityPost.status == "hidden")))
    before = _cursor(cursor)
    if before:
        query = query.where(or_(CommunityPost.created_at < before[0],
                                and_(CommunityPost.created_at == before[0], CommunityPost.id < before[1])))
    items = list(db.scalars(query.order_by(CommunityPost.created_at.desc(), CommunityPost.id.desc()).limit(limit + 1)))
    page, more = items[:limit], len(items) > limit
    names = _nicknames(db, {item.owner_id for item in page})
    counts = dict(db.execute(select(CommunityComment.post_id, func.count()).where(
        CommunityComment.post_id.in_([item.id for item in page]), CommunityComment.status == "visible",
    ).group_by(CommunityComment.post_id)).all()) if page else {}
    return {"items": [_post_value(item, actor, names, counts.get(item.id, 0)) for item in page],
            "nextCursor": _next(page) if more else None}


@router.post("/posts", status_code=201, dependencies=[Depends(local_gate)])
def create_post(value: BodyInput, response: Response, idempotency_key: str | None = Header(default=None),
                db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    key = _key(idempotency_key)
    _profile(db, actor)
    digest = _hash({"body": value.body})

    def make():
        _consume(db, actor, "post", 600, 3)
        now = _now()
        return CommunityPost(id=str(uuid4()), owner_id=actor, body=value.body, status="visible", revision=1,
                             idempotency_key=key, request_hash=digest, created_at=now, updated_at=now)

    item, created = _write_once(db, CommunityPost, actor, key, digest, make)
    if not created:
        response.status_code = 200
    return _post_value(item, actor, _nicknames(db, {item.owner_id}))


@router.get("/posts/{post_id}", dependencies=[Depends(local_gate)])
def get_post(post_id: str, db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    item = db.get(CommunityPost, post_id)
    if not item or item.status == "deleted" or (item.status == "hidden" and item.owner_id != actor):
        raise HTTPException(404, "帖子不存在")
    return _post_value(item, actor, _nicknames(db, {item.owner_id}))


@router.delete("/posts/{post_id}", status_code=204, dependencies=[Depends(local_gate)])
def delete_post(post_id: str, if_match: str | None = Header(default=None),
                db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    revision = _revision(if_match)
    item = db.get(CommunityPost, post_id)
    if not item or item.owner_id != actor or item.status == "deleted":
        raise HTTPException(404, "帖子不存在或不属于当前账号")
    changed = db.execute(update(CommunityPost).where(CommunityPost.id == post_id,
        CommunityPost.owner_id == actor, CommunityPost.revision == revision, CommunityPost.status != "deleted")
        .values(status="deleted", body="", request_hash="", revision=CommunityPost.revision + 1, updated_at=_now())).rowcount
    if not changed:
        db.rollback()
        raise HTTPException(409, "帖子已改变，请刷新后重试")
    db.execute(update(CommunityComment).where(CommunityComment.post_id == post_id,
        CommunityComment.status != "deleted").values(status="deleted", body="", request_hash="", revision=CommunityComment.revision + 1, updated_at=_now()))
    db.commit()
    return Response(status_code=204)


@router.get("/posts/{post_id}/comments", dependencies=[Depends(local_gate)])
def list_comments(post_id: str, limit: int = Query(default=30, ge=1, le=50), cursor: str | None = None,
                  db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    post = db.get(CommunityPost, post_id)
    if not post or post.status != "visible":
        raise HTTPException(404, "帖子不存在")
    query = select(CommunityComment).where(CommunityComment.post_id == post_id, CommunityComment.status == "visible")
    before = _cursor(cursor)
    if before:
        query = query.where(or_(CommunityComment.created_at < before[0],
                                and_(CommunityComment.created_at == before[0], CommunityComment.id < before[1])))
    items = list(db.scalars(query.order_by(CommunityComment.created_at.desc(), CommunityComment.id.desc()).limit(limit + 1)))
    page, more = items[:limit], len(items) > limit
    names = _nicknames(db, {entry.owner_id for entry in page})
    return {"items": [_comment_value(item, actor, names) for item in page],
            "nextCursor": _next(page) if more else None}


@router.post("/posts/{post_id}/comments", status_code=201, dependencies=[Depends(local_gate)])
def create_comment(post_id: str, value: CommentInput, response: Response,
                   idempotency_key: str | None = Header(default=None),
                   db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    key = _key(idempotency_key)
    _profile(db, actor)
    digest = _hash({"postId": post_id, "body": value.body})

    def make():
        post = db.get(CommunityPost, post_id)
        if not post or post.status != "visible":
            raise HTTPException(404, "帖子不存在")
        _consume(db, actor, "comment", 600, 10)
        now = _now()
        return CommunityComment(id=str(uuid4()), post_id=post_id, owner_id=actor, body=value.body,
                                status="visible", revision=1, idempotency_key=key, request_hash=digest,
                                created_at=now, updated_at=now)

    item, created = _write_once(db, CommunityComment, actor, key, digest, make)
    if not created:
        response.status_code = 200
    return _comment_value(item, actor, _nicknames(db, {item.owner_id}))


@router.delete("/comments/{comment_id}", status_code=204, dependencies=[Depends(local_gate)])
def delete_comment(comment_id: str, if_match: str | None = Header(default=None),
                   db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    revision = _revision(if_match)
    item = db.get(CommunityComment, comment_id)
    if not item or item.owner_id != actor or item.status == "deleted":
        raise HTTPException(404, "评论不存在或不属于当前账号")
    changed = db.execute(update(CommunityComment).where(CommunityComment.id == comment_id,
        CommunityComment.owner_id == actor, CommunityComment.revision == revision, CommunityComment.status != "deleted")
        .values(status="deleted", body="", request_hash="", revision=CommunityComment.revision + 1, updated_at=_now())).rowcount
    if not changed:
        db.rollback()
        raise HTTPException(409, "评论已改变，请刷新后重试")
    db.commit()
    return Response(status_code=204)


@router.post("/reports", status_code=201, dependencies=[Depends(local_gate)])
def report(value: ReportInput, response: Response, db: Session = Depends(community_get_db),
           actor: str = Depends(community_actor_id)):
    model = CommunityPost if value.target_kind == "post" else CommunityComment
    target = db.get(model, value.target_id)
    if not target or target.status != "visible":
        raise HTTPException(404, "举报对象不存在")
    if target.owner_id == actor:
        raise HTTPException(400, "不能举报自己的内容")
    existing = db.scalar(select(CommunityReport).where(CommunityReport.reporter_id == actor,
        CommunityReport.target_kind == value.target_kind, CommunityReport.target_id == value.target_id))
    if existing:
        response.status_code = 200
        return {"id": existing.id, "status": existing.status}
    _consume(db, actor, "report", 86400, 5)
    item = CommunityReport(id=str(uuid4()), reporter_id=actor, target_kind=value.target_kind,
                           target_id=value.target_id, reason=value.reason, status="pending", created_at=_now())
    db.add(item)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        existing = db.scalar(select(CommunityReport).where(CommunityReport.reporter_id == actor,
            CommunityReport.target_kind == value.target_kind, CommunityReport.target_id == value.target_id))
        if existing:
            response.status_code = 200
            return {"id": existing.id, "status": existing.status}
        raise HTTPException(503, "举报并发写入未完成，请稍后重试") from error
    return {"id": item.id, "status": item.status}


def _moderator(db: Session, actor: str) -> None:
    member = db.get(CommunityModerator, actor)
    if not member or not member.active:
        raise HTTPException(403, "无社区审核权限")


@router.get("/moderation/reports", dependencies=[Depends(local_gate)])
def pending_reports(limit: int = Query(default=50, ge=1, le=100),
                    db: Session = Depends(community_get_db), actor: str = Depends(community_actor_id)):
    _moderator(db, actor)
    items = db.scalars(select(CommunityReport).where(CommunityReport.status == "pending")
                       .order_by(CommunityReport.created_at, CommunityReport.id).limit(limit)).all()
    targets = [(item, db.get(CommunityPost if item.target_kind == "post" else CommunityComment, item.target_id)) for item in items]
    names = _nicknames(db, {target.owner_id for _, target in targets if target})
    return {"items": [{"id": item.id, "targetKind": item.target_kind, "targetId": item.target_id,
                       "reason": item.reason, "createdAt": _as_utc(item.created_at).isoformat(),
                       "body": target.body if target else "", "nickname": names.get(target.owner_id, "已注销用户") if target else "已删除内容",
                       "targetStatus": target.status if target else "missing"} for item, target in targets]}


@router.patch("/moderation/reports/{report_id}", dependencies=[Depends(local_gate)])
def review_report(report_id: str, value: ReviewInput, db: Session = Depends(community_get_db),
                  actor: str = Depends(community_actor_id)):
    _moderator(db, actor)
    item = db.get(CommunityReport, report_id)
    if not item:
        raise HTTPException(404, "举报不存在")
    if item.status != "pending":
        raise HTTPException(409, "举报已经处理")
    model = CommunityPost if item.target_kind == "post" else CommunityComment
    target = db.get(model, item.target_id)
    if value.decision == "hide" and target and target.status == "visible":
        target.status, target.revision, target.updated_at = "hidden", target.revision + 1, _now()
    changed = db.execute(update(CommunityReport).where(CommunityReport.id == report_id,
        CommunityReport.status == "pending").values(status="reviewed", decision=value.decision,
        moderator_id=actor, reviewed_at=_now())).rowcount
    if not changed:
        db.rollback()
        raise HTTPException(409, "举报已经处理")
    db.commit()
    return {"id": item.id, "status": "reviewed", "decision": value.decision}

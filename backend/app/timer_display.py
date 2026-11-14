"""Short-lived, account-free controller and read-only timer display pairing."""

import hashlib
import re
import secrets
import time
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import (JSON, BigInteger, Boolean, Column, Index, MetaData, String, Table,
                        case, cast, delete, extract, func, insert, or_, select, text, update)
from sqlalchemy.exc import SQLAlchemyError
from starlette.responses import JSONResponse, Response


ROOM_TTL_MS = 10 * 60 * 1000
MAX_LIFETIME_MS = 2 * 60 * 60 * 1000
CLOSED_TTL_MS = 30 * 1000
FRAME_TTL_MS = 2500
MIN_FRAME_INTERVAL_MS = 100
VIEW_INTERVAL_MS = 1000
MAX_BODY = 2048
TOKEN_PATTERN = r"^[A-Za-z0-9_-]{43}$"
TOKEN = re.compile(TOKEN_PATTERN)
NO_STORE = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}

ROOMS = Table(
    "timer_display_rooms", MetaData(),
    Column("display_hash", String(64), primary_key=True),
    Column("pair_hash", String(64), unique=True),
    Column("control_hash", String(64), unique=True),
    Column("expires_at", BigInteger, nullable=False),
    Column("max_expires_at", BigInteger, nullable=False),
    Column("closed", Boolean, nullable=False),
    Column("seq", BigInteger, nullable=False),
    Column("frame_at", BigInteger),
    Column("last_view_at", BigInteger),
    Column("frame", JSON(none_as_null=True)),
    schema="public",
)
Index("ix_timer_display_rooms_expires_at", ROOMS.c.expires_at)


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class PairInput(ClosedModel):
    pairCode: str = Field(pattern=TOKEN_PATTERN)


class ClockFrame(ClosedModel):
    name: Literal["A 方", "B 方", "剩余时间"]
    time: str = Field(pattern=r"^[0-9]{2}:[0-5][0-9]$")
    active: bool


class Signal(ClosedModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    kind: Literal["prepare", "shoot", "warning", "stop", "scoring"]


class Frame(ClosedModel):
    stage: Literal["ready", "prepare", "shoot", "warning", "stopped", "scoring"]
    label: Literal["等待开始", "准备上场", "可以发射", "最后 30 秒", "停止发射", "计分取箭", "A 方发射", "B 方发射"]
    clocks: list[ClockFrame] = Field(min_length=1, max_length=2)
    signal: Signal | None = None


class FrameInput(ClosedModel):
    seq: int = Field(ge=1, le=1_000_000)
    frame: Frame


class TimerDisplayRoute(APIRoute):
    """Limit request bodies and keep validation errors free of capabilities."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def route(request: Request):
            content_length = request.headers.get("content-length")
            if content_length is not None and (
                not content_length.isascii() or not content_length.isdigit() or len(content_length) > 4
                or int(content_length) > MAX_BODY
            ):
                return JSONResponse({"detail": "请求过大"}, status_code=413, headers=NO_STORE)

            size = 0

            async def bounded_receive():
                nonlocal size
                message = await request.receive()
                size += len(message.get("body", b""))
                if size > MAX_BODY:
                    raise HTTPException(413, "请求过大")
                return message

            try:
                response = await handler(Request(request.scope, receive=bounded_receive))
            except RequestValidationError:
                return JSONResponse({"detail": "请求格式无效"}, status_code=422, headers=NO_STORE)
            except HTTPException as error:
                return JSONResponse({"detail": error.detail}, status_code=error.status_code, headers=NO_STORE)
            except SQLAlchemyError:
                return JSONResponse({"detail": "在线大屏暂不可用"}, status_code=503, headers=NO_STORE)
            response.headers.update(NO_STORE)
            return response

        return route


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("ascii")).hexdigest()


def _bearer(header: str | None) -> str:
    scheme, separator, value = (header or "").partition(" ")
    if scheme.lower() != "bearer" or not separator or not TOKEN.fullmatch(value):
        raise HTTPException(401, "请提供配对凭据")
    return _hash(value)


def _unavailable():
    return HTTPException(404, "配对已失效，请重新连接")


def create_timer_display_router(session_factory, *, clock=None, max_rooms=64, max_waiting=24):
    """Use the existing direct DB role. The router is mounted only when enabled."""
    router = APIRouter(prefix="/api/timer-display", route_class=TimerDisplayRoute)
    room = ROOMS.c

    def now_ms(db):
        if db.bind.dialect.name == "postgresql":
            db.execute(text("SET LOCAL statement_timeout = '1500ms'"))
            db.execute(text("SET LOCAL lock_timeout = '750ms'"))
            if clock is None:
                return db.scalar(select(cast(extract("epoch", func.clock_timestamp()) * 1000, BigInteger)))
        return (clock or (lambda: time.time_ns() // 1_000_000))()

    def deadline(now, ttl):
        target = now + ttl
        return case((room.max_expires_at < target, room.max_expires_at), else_=target)

    @router.get("/status")
    def status():
        with session_factory.begin() as db:
            now_ms(db)
            if db.bind.dialect.name == "postgresql":
                # The timer table intentionally has no browser/runtime-role policies.
                # Require a direct server role with grants that bypasses table RLS.
                if not db.scalar(text(
                    "SELECT bool_and(has_table_privilege(current_user,"
                    " 'public.timer_display_rooms', permission))"
                    " AND NOT row_security_active('public.timer_display_rooms')"
                    " FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privileges(permission)"
                )):
                    raise HTTPException(503, "在线大屏暂不可用")
            db.execute(select(room.display_hash).limit(1))
        return {"ready": True}

    @router.post("/rooms", status_code=201)
    def create_room():
        display_key, pair_code = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with session_factory.begin() as db:
            now = now_ms(db)
            if db.bind.dialect.name == "postgresql":
                # Serialize admissions across independent Vercel instances, not reads or publishes.
                db.execute(text("SELECT pg_advisory_xact_lock(1196968532, 1229800786)"))
            db.execute(delete(ROOMS).where(room.expires_at <= now))
            count, waiting = db.execute(
                select(func.count(), func.count().filter(room.pair_hash.is_not(None))).select_from(ROOMS)
            ).one()
            if count >= max_rooms or waiting >= max_waiting:
                raise HTTPException(503, "在线大屏暂时已满，请稍后重试")
            db.execute(insert(ROOMS).values(
                display_hash=_hash(display_key), pair_hash=_hash(pair_code),
                expires_at=now + ROOM_TTL_MS, max_expires_at=now + MAX_LIFETIME_MS,
                closed=False, seq=0,
            ))
        return {"displayKey": display_key, "pairCode": pair_code}

    @router.post("/claim")
    def claim_room(data: PairInput):
        control_key = secrets.token_urlsafe(32)
        with session_factory.begin() as db:
            now = now_ms(db)
            claimed = db.execute(update(ROOMS).where(
                room.pair_hash == _hash(data.pairCode), room.expires_at > now, room.closed.is_(False),
            ).values(pair_hash=None, control_hash=_hash(control_key), expires_at=deadline(now, ROOM_TTL_MS))
                .returning(room.display_hash)).scalar_one_or_none()
            if claimed is None:
                raise _unavailable()
        return {"controlKey": control_key}

    @router.get("/state")
    def display_state(authorization: str | None = Header(None)):
        display_hash = _bearer(authorization)
        with session_factory.begin() as db:
            now = now_ms(db)
            identity = (room.display_hash == display_hash, room.expires_at > now)
            fields = (room.control_hash.is_not(None), room.closed, room.seq, room.frame_at, room.frame)
            saved = db.execute(update(ROOMS).where(
                *identity, room.closed.is_(False),
                or_(room.last_view_at.is_(None), room.last_view_at <= now - VIEW_INTERVAL_MS),
            ).values(last_view_at=now).returning(*fields)).one_or_none()
            if saved is None:
                saved = db.execute(select(*fields).where(*identity)).one_or_none()
        if saved is None:
            raise _unavailable()
        claimed, closed, seq, frame_at, frame = saved
        connected = claimed and not closed
        fresh = connected and frame_at is not None and 0 <= now - frame_at < FRAME_TTL_MS
        return {"connected": connected, "frame": frame if fresh else None, "seq": seq}

    @router.put("/frame")
    def put_frame(data: FrameInput, authorization: str | None = Header(None)):
        control_hash = _bearer(authorization)
        frame = data.frame.model_dump()
        with session_factory.begin() as db:
            now = now_ms(db)
            active = (room.control_hash == control_hash, room.expires_at > now, room.closed.is_(False))
            saved = db.execute(update(ROOMS).where(
                *active, room.seq < data.seq,
                or_(room.frame_at.is_(None), room.frame_at <= now - MIN_FRAME_INTERVAL_MS),
            ).values(
                seq=data.seq, frame=frame, frame_at=now, expires_at=deadline(now, ROOM_TTL_MS),
            ).returning(room.last_view_at)).one_or_none()
            if saved is None:
                current = db.execute(select(room.seq, room.frame, room.last_view_at).where(*active)).one_or_none()
                if current is None:
                    raise _unavailable()
                if current.seq == data.seq and current.frame == frame:
                    last_view = current.last_view_at
                elif current.seq >= data.seq:
                    raise HTTPException(409, "计时状态版本已更新")
                else:
                    raise HTTPException(429, "计时状态更新过快")
            else:
                last_view = saved.last_view_at
        return {"displayOnline": last_view is not None and 0 <= now - last_view < FRAME_TTL_MS}

    @router.delete("/connection", status_code=204)
    def close_room(authorization: str | None = Header(None)):
        capability = _bearer(authorization)
        with session_factory.begin() as db:
            now = now_ms(db)
            identity = (or_(room.display_hash == capability, room.control_hash == capability), room.expires_at > now)
            closed = db.execute(update(ROOMS).where(*identity, room.closed.is_(False)).values(
                closed=True, pair_hash=None, frame=None, frame_at=None, last_view_at=None,
                expires_at=case(
                    (room.expires_at < now + CLOSED_TTL_MS, room.expires_at),
                    else_=now + CLOSED_TTL_MS,
                ),
            ).returning(room.display_hash)).scalar_one_or_none()
            if closed is None and db.scalar(select(room.display_hash).where(*identity)) is None:
                raise _unavailable()
        return Response(status_code=204)

    return router

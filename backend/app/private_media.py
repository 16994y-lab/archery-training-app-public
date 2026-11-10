"""Private media candidate: no provider calls, no public links, no deletion.

Wire the router only after additive tables and a protected persistent adapter are
reviewed. The default dependency always fails closed; tests inject a local store.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.auth import current_user_id
from app.private_media_models import PrivateMediaAccess, PrivateMediaConsentEvent, PrivateMediaObject, PrivateMediaOwner

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$"
TRAINING_LIMIT = "撤回停止未来选取；已产生的模型影响未建立可移除机制，不能承诺模型忘记。当前模块不执行训练或授予研究者读取权限。"


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: bytes):
    return hashlib.sha256(value).hexdigest()


class SaveConsent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal["media-save/v1"]
    accepted: StrictBool


class TrainingConsent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal["media-training/v1"] = "media-training/v1"
    accepted: StrictBool = False
    purpose: Literal["archery-assist-research/v1"] | None = None
    accessors: list[Literal["approved-researcher", "approved-annotator"]] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def separate_scope(self):
        if self.accepted and (self.purpose is None or not self.accessors or len(set(self.accessors)) != len(self.accessors)):
            raise ValueError("训练同意须明确用途和访问者")
        if not self.accepted and (self.purpose is not None or self.accessors):
            raise ValueError("未同意训练不能附带训练用途或访问者")
        return self


class MediaIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    clientObjectId: str = Field(pattern=ID_PATTERN)
    selectionId: str = Field(pattern=ID_PATTERN)
    kind: Literal["photo", "video", "avatar"]
    mime: Literal["image/png", "image/jpeg", "image/webp", "video/mp4"]
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    bytes: StrictInt = Field(gt=0, le=50 * 1024 * 1024)
    idempotencyKey: str = Field(pattern=ID_PATTERN)
    saveConsent: SaveConsent
    trainingConsent: TrainingConsent = Field(default_factory=TrainingConsent)

    @model_validator(mode="after")
    def kind_matches_mime(self):
        if (self.kind == "video") != (self.mime == "video/mp4"):
            raise ValueError("对象类型与MIME不一致")
        return self


@dataclass(frozen=True)
class MediaPolicy:
    enabled: bool = False
    max_bytes: int = 100 * 1024 * 1024
    max_object_bytes: int = 50 * 1024 * 1024
    intent_seconds: int = 300
    access_seconds: int = 90
    max_attempts: int = 3

    def __post_init__(self):
        if not (0 < self.max_object_bytes <= self.max_bytes and 1 <= self.intent_seconds <= 3600
                and 1 <= self.access_seconds <= 300 and 1 <= self.max_attempts <= 5):
            raise ValueError("媒体容量或有限时限无效")


class LocalPrivateMediaStore:
    """Immutable file adapter. No public/static mount; no removal method.

    protection_verified is an operator attestation, not a client field. Windows
    ACLs/persistent storage require separate deployment evidence. False closes writes.
    """
    mode = "local-protected-candidate"

    def __init__(self, root: Path, *, protection_verified=False):
        if not Path(root).is_absolute():
            raise ValueError("私有存储须为绝对目录")
        self.root = Path(root)
        self.protection_verified = protection_verified
        self._check_tree(self.root)

    @staticmethod
    def _check_tree(path):
        for component in (path, *path.parents):
            if component.is_symlink() or (hasattr(component, "is_junction") and component.is_junction()):
                raise ValueError("私有存储不能通过符号链接或目录联接")

    def path_for(self, object_id):
        if not re.fullmatch(r"[0-9a-f]{32}", object_id):
            raise ValueError("对象标识无效")
        path = self.root / "objects" / object_id[:2] / object_id
        self._check_tree(path)
        return path

    def exists(self, object_id):
        return self.path_for(object_id).exists()

    def put(self, object_id, content):
        if not self.protection_verified:
            raise HTTPException(503, "私有存储保护尚未核验")
        path = self.path_for(object_id)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._check_tree(path)
        try:
            with path.open("xb") as stream:
                os.chmod(path, 0o600)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            if self.read(object_id, len(content)) != content:
                raise HTTPException(409, "已有私有对象不一致；未覆盖") from None
        except OSError:
            raise HTTPException(503, "私有对象写入失败；本机资料应保留") from None

    def read(self, object_id, expected_size):
        path = self.path_for(object_id)
        try:
            if path.stat().st_size != expected_size:
                raise HTTPException(409, "私有对象大小损坏；未返回内容")
            with path.open("rb") as stream:
                value = stream.read(expected_size + 1)
            if len(value) != expected_size:
                raise HTTPException(409, "私有对象大小损坏；未返回内容")
            return value
        except OSError:
            raise HTTPException(409, "私有对象缺失或不可读；未返回内容") from None


def validate_mime(content: bytes, mime: str):
    """Check actual container signatures/structure, never trusting file suffixes.

    This does not claim image decode quality or video playback validation.
    """
    valid = False
    if mime == "image/png" and content.startswith(b"\x89PNG\r\n\x1a\n"):
        offset, kinds = 8, []
        while offset + 12 <= len(content):
            size = int.from_bytes(content[offset:offset + 4], "big")
            kind = content[offset + 4:offset + 8]
            end = offset + size + 12
            if end > len(content) or zlib.crc32(content[offset + 4:end - 4]) != int.from_bytes(content[end - 4:end], "big"):
                break
            kinds.append(kind)
            if len(kinds) == 1:
                if kind != b"IHDR" or size != 13:
                    break
                width = int.from_bytes(content[offset + 8:offset + 12], "big")
                height = int.from_bytes(content[offset + 12:offset + 16], "big")
                if width < 1 or height < 1 or width * height > 40_000_000:
                    break
            offset = end
            if kind == b"IEND":
                valid = size == 0 and offset == len(content) and b"IDAT" in kinds and kinds.count(b"IHDR") == 1
                break
    elif mime == "image/jpeg" and content.startswith(b"\xff\xd8"):
        offset, saw_frame, saw_scan = 2, False, False
        while offset < len(content) and content[offset] == 255:
            while offset < len(content) and content[offset] == 255:
                offset += 1
            if offset >= len(content):
                break
            marker = content[offset]; offset += 1
            if marker == 0xD9:
                valid = offset == len(content) and saw_frame and saw_scan
                break
            if marker in (0, 0xD8) or 0xD0 <= marker <= 0xD7 or offset + 2 > len(content):
                break
            size = int.from_bytes(content[offset:offset + 2], "big")
            if size < 2 or offset + size > len(content):
                break
            segment = content[offset + 2:offset + size]
            offset += size
            if marker in (0xC0, 0xC1, 0xC2):
                if len(segment) < 6:
                    break
                height, width = int.from_bytes(segment[1:3], "big"), int.from_bytes(segment[3:5], "big")
                channels = segment[5]
                if not (width > 0 and height > 0 and width * height <= 40_000_000
                        and channels in (1, 3, 4) and len(segment) == 6 + channels * 3):
                    break
                saw_frame = True
            if marker == 0xDA:
                if not segment or not (1 <= segment[0] <= 4 and len(segment) == 4 + segment[0] * 2):
                    break
                scan_start = offset
                while offset < len(content):
                    if content[offset] != 255:
                        offset += 1
                    elif offset + 1 < len(content) and (content[offset + 1] == 0 or 0xD0 <= content[offset + 1] <= 0xD7):
                        offset += 2
                    else:
                        break
                saw_scan = saw_scan or offset > scan_start
    elif mime == "image/webp" and len(content) >= 20 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        offset, image_chunk = 12, False
        if int.from_bytes(content[4:8], "little") + 8 == len(content):
            while offset + 8 <= len(content):
                kind, size = content[offset:offset + 4], int.from_bytes(content[offset + 4:offset + 8], "little")
                end = offset + 8 + size
                if end + size % 2 > len(content):
                    break
                body = content[offset + 8:end]
                if kind == b"VP8L":
                    image_chunk = len(body) >= 5 and body[0] == 0x2F
                elif kind == b"VP8 ":
                    image_chunk = len(body) >= 10 and body[3:6] == b"\x9d\x01\x2a"
                offset = end + size % 2
            valid = offset == len(content) and image_chunk
    elif mime == "video/mp4":
        offset, boxes, brand_ok, media_nonempty = 0, [], False, False
        while offset + 8 <= len(content):
            size = int.from_bytes(content[offset:offset + 4], "big")
            kind = content[offset + 4:offset + 8]
            if size == 0:
                size = len(content) - offset
            if size < 8 or offset + size > len(content):
                break
            if not boxes:
                brand_ok = kind == b"ftyp" and size >= 16 and content[offset + 8:offset + 12] in (
                    b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"qt  ", b"M4V ", b"MSNV", b"3gp6")
            media_nonempty = media_nonempty or kind == b"mdat" and size > 8
            boxes.append(kind)
            offset += size
        valid = offset == len(content) and brand_ok and media_nonempty and b"moov" in boxes
    if not valid:
        raise HTTPException(422, "媒体实际容器与MIME不符或结构损坏；未保存")


class PrivateMediaService:
    def __init__(self, session_factory, store: LocalPrivateMediaStore, policy=MediaPolicy(), clock=time.time):
        self.factory, self.store, self.policy, self.clock = session_factory, store, policy, clock

    def require_enabled(self):
        if not self.policy.enabled or not self.store.protection_verified:
            raise HTTPException(503, "私有媒体未启用或保护未核验")

    def _object(self, db, owner, object_id, *, lock=False):
        statement = select(PrivateMediaObject).where(PrivateMediaObject.id == object_id, PrivateMediaObject.owner_id == owner)
        if lock:
            statement = statement.with_for_update()
        row = db.scalar(statement)
        if row is None:
            raise HTTPException(404, "私有对象不可用")
        return row

    @staticmethod
    def describe(row):
        return {"id": row.id, "ownerId": row.owner_id, "clientObjectId": row.client_object_id,
                "selectionId": row.selection_id, "kind": row.kind, "mime": row.mime,
                "sha256": row.sha256, "bytes": row.byte_size, "status": row.status,
                "createdAt": row.created_at, "storedAt": row.stored_at, "expiresAt": row.expires_at,
                "saveConsent": row.save_consent, "trainingConsent": row.training_consent,
                "trainingWithdrawalLimit": TRAINING_LIMIT}

    def _expire(self, db, owner):
        now = int(self.clock())
        pending = db.scalars(select(PrivateMediaObject).where(PrivateMediaObject.owner_id == owner,
                          PrivateMediaObject.status == "pending",
                          or_(PrivateMediaObject.expires_at <= now,
                              PrivateMediaObject.attempts >= self.policy.max_attempts)).with_for_update()).all()
        for row in pending:
            expired = row.expires_at <= now
            # Reconcile bytes already written under this owner's original explicit
            # consent. No new upload, ownership change, deletion or overwrite occurs.
            try:
                exists = self.store.exists(row.id)
            except HTTPException as error:
                if error.status_code != 503:
                    raise
                # Unknown presence (including provider permission/404 ambiguity)
                # is local to this row. Keep its status and full quota reservation;
                # other healthy objects and bounded new intents remain usable.
                continue
            if type(exists) is not bool:
                continue  # A malformed adapter result cannot prove absence.
            if exists:
                try:
                    content = self.store.read(row.id, row.byte_size)
                    if len(content) != row.byte_size or digest(content) != row.sha256:
                        raise HTTPException(409, "Interrupted object size or digest mismatch")
                    validate_mime(content, row.mime)
                    changed = db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner,
                              PrivateMediaOwner.reserved_bytes >= row.byte_size).values(
                              reserved_bytes=PrivateMediaOwner.reserved_bytes - row.byte_size,
                              used_bytes=PrivateMediaOwner.used_bytes + row.byte_size))
                    if changed.rowcount != 1:
                        raise HTTPException(409, "Interrupted object quota mismatch")
                    row.status, row.stored_at = "stored", now
                except HTTPException as error:
                    if not expired and error.status_code not in (409, 422):
                        # An unavailable read does not prove an active object damaged.
                        continue
                    # Keep damaged/unavailable bytes and quota visible for a bounded
                    # operator repair rather than silently releasing storage quota.
                    row.status = "repair-required"
            else:
                if not expired:
                    # A capped attempt still owns its unexpired reservation.
                    continue
                row.status = "expired"
                db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner,
                           PrivateMediaOwner.reserved_bytes >= row.byte_size).values(
                           reserved_bytes=PrivateMediaOwner.reserved_bytes - row.byte_size))

    def list(self, owner):
        self.require_enabled()
        with self.factory.begin() as db:
            # Serialize quota expiry with reservations, including SQLite writers.
            db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner).values(
                       reserved_bytes=PrivateMediaOwner.reserved_bytes))
            self._expire(db, owner)
            rows = db.scalars(select(PrivateMediaObject).where(PrivateMediaObject.owner_id == owner)
                              .order_by(PrivateMediaObject.created_at, PrivateMediaObject.id)).all()
            quota = db.get(PrivateMediaOwner, owner)
            return {"objects": [self.describe(row) for row in rows], "quota": {
                "usedBytes": quota.used_bytes if quota else 0, "reservedBytes": quota.reserved_bytes if quota else 0,
                "maxBytes": self.policy.max_bytes}, "storageMode": self.store.mode}

    def create_intent(self, owner, value: MediaIntent):
        self.require_enabled()
        if not value.saveConsent.accepted:
            raise HTTPException(403, "须对明确选择的对象同意云保存；训练不是保存条件")
        if value.bytes > self.policy.max_object_bytes:
            raise HTTPException(413, "媒体超过单对象容量；未保存")
        body = value.model_dump()
        intent_hash = digest(canonical_bytes(body))
        now = int(self.clock())
        try:
            with self.factory.begin() as db:
                if db.get(PrivateMediaOwner, owner) is None:
                    db.add(PrivateMediaOwner(owner_id=owner, used_bytes=0, reserved_bytes=0))
                    db.flush()
                db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner).values(
                           reserved_bytes=PrivateMediaOwner.reserved_bytes))
                self._expire(db, owner)
                existing = db.scalar(select(PrivateMediaObject).where(PrivateMediaObject.owner_id == owner,
                                     PrivateMediaObject.idempotency_key == value.idempotencyKey))
                if existing:
                    if existing.intent_digest != intent_hash:
                        raise HTTPException(409, "幂等标识已用于不同对象；未覆盖")
                    return self._intent_receipt(existing)
                reserved = db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner,
                                      PrivateMediaOwner.used_bytes + PrivateMediaOwner.reserved_bytes + value.bytes <= self.policy.max_bytes)
                                      .values(reserved_bytes=PrivateMediaOwner.reserved_bytes + value.bytes))
                if reserved.rowcount != 1:
                    raise HTTPException(413, "私有媒体配额不足；本机对象保留")
                row = PrivateMediaObject(id=uuid4().hex, owner_id=owner, client_object_id=value.clientObjectId,
                      selection_id=value.selectionId, kind=value.kind, mime=value.mime, sha256=value.sha256,
                      byte_size=value.bytes, idempotency_key=value.idempotencyKey, intent_digest=intent_hash,
                      status="pending", attempts=0, created_at=now, expires_at=now + self.policy.intent_seconds,
                      save_consent={**body["saveConsent"], "acceptedAt": now, "selectionId": value.selectionId},
                      training_consent={**body["trainingConsent"], "acceptedAt": now if value.trainingConsent.accepted else None})
                db.add(row)
                db.flush()
                for scope, consent in (("save", row.save_consent), ("training", row.training_consent)):
                    db.add(PrivateMediaConsentEvent(id=uuid4().hex, owner_id=owner, object_id=row.id,
                                                   happened_at=now, scope=scope, consent=consent))
                return self._intent_receipt(row)
        except IntegrityError:
            # First-owner/identical-key races roll back reservation; retry reads winner.
            with self.factory() as db:
                existing = db.scalar(select(PrivateMediaObject).where(PrivateMediaObject.owner_id == owner,
                                     PrivateMediaObject.idempotency_key == value.idempotencyKey))
                if existing and existing.intent_digest == intent_hash:
                    return self._intent_receipt(existing)
            raise HTTPException(409, "对象登记发生并发冲突；请回读清单") from None
        except SQLAlchemyError:
            raise HTTPException(503, "私有媒体登记暂时不可用；本机对象保留") from None

    def _intent_receipt(self, row):
        return {"object": self.describe(row), "uploadPath": f"/api/private-media/{row.id}/content",
                "expiresAt": row.expires_at, "maxAttempts": self.policy.max_attempts}

    def begin_upload(self, owner, object_id):
        self.require_enabled()
        # Committed before body reads: malformed lengths, interrupted streams and
        # failed digests all consume a finite attempt across process restarts.
        with self.factory.begin() as db:
            changed = db.execute(update(PrivateMediaObject).where(PrivateMediaObject.id == object_id,
                    PrivateMediaObject.owner_id == owner, PrivateMediaObject.status == "pending",
                    PrivateMediaObject.expires_at > int(self.clock()), PrivateMediaObject.attempts < self.policy.max_attempts)
                    .values(attempts=PrivateMediaObject.attempts + 1))
            row = self._object(db, owner, object_id, lock=True)
            if changed.rowcount != 1 and row.status != "stored":
                if row.status != "pending" or row.expires_at <= int(self.clock()):
                    raise HTTPException(410, "上传选择已过期或需人工修复；本机对象保留")
                raise HTTPException(429, "本对象有限上传次数已用尽；请重新确认对象", headers={"Retry-After": "300"})
            return row.byte_size, row.sha256, row.mime

    def upload(self, owner, object_id, content, mime, *, _reserved=None):
        self.require_enabled()
        expected = _reserved if _reserved is not None else self.begin_upload(owner, object_id)
        if len(content) != expected[0] or digest(content) != expected[1]:
            raise HTTPException(422, "媒体大小或SHA-256不一致；未保存")
        if mime.split(";", 1)[0].strip().lower() != expected[2]:
            raise HTTPException(422, "上传MIME与所选对象不一致；未保存")
        validate_mime(content, expected[2])
        try:
            with self.factory.begin() as db:
                # Serialize finalization with expiry/other finalizations.
                db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner).values(
                           reserved_bytes=PrivateMediaOwner.reserved_bytes))
                row = self._object(db, owner, object_id, lock=True)
                if row.status not in ("pending", "stored") or (row.status == "pending" and row.expires_at <= int(self.clock())):
                    raise HTTPException(410, "对象已过期；未写入")
                self.store.put(object_id, content)
                if row.status == "pending":
                    changed = db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner,
                              PrivateMediaOwner.reserved_bytes >= row.byte_size).values(
                              reserved_bytes=PrivateMediaOwner.reserved_bytes - row.byte_size,
                              used_bytes=PrivateMediaOwner.used_bytes + row.byte_size))
                    if changed.rowcount != 1:
                        raise HTTPException(503, "对象配额需修复；原内容保留")
                    row.status, row.stored_at = "stored", int(self.clock())
                return {"object": self.describe(row), "verified": True}
        except SQLAlchemyError:
            raise HTTPException(503, "媒体确认暂时失败；请回读清单，原内容不删除") from None

    def verified_content(self, owner, object_id):
        self.require_enabled()
        with self.factory() as db:
            row = self._object(db, owner, object_id)
            if row.status != "stored":
                raise HTTPException(409, "私有对象尚未确认保存")
            descriptor = self.describe(row)
        content = self.store.read(object_id, descriptor["bytes"])
        if digest(content) != descriptor["sha256"]:
            raise HTTPException(409, "私有对象摘要损坏；未返回内容")
        validate_mime(content, descriptor["mime"])
        return descriptor, content

    def access(self, owner, object_id):
        self.verified_content(owner, object_id)
        token, expires = secrets.token_urlsafe(32), int(self.clock()) + self.policy.access_seconds
        with self.factory.begin() as db:
            db.add(PrivateMediaAccess(token_hash=digest(token.encode()), owner_id=owner, object_id=object_id, expires_at=expires))
        return {"accessToken": token, "expiresAt": expires, "readPath": f"/api/private-media/{object_id}/content",
                "requiresAuthentication": True}

    def read(self, owner, object_id, access_token):
        self.require_enabled()
        if not access_token or len(access_token) > 128:
            raise HTTPException(404, "短期访问不可用")
        with self.factory() as db:
            permission = db.get(PrivateMediaAccess, digest(access_token.encode()))
            if (permission is None or permission.owner_id != owner or permission.object_id != object_id
                    or permission.expires_at <= int(self.clock())):
                raise HTTPException(404, "短期访问不可用或已过期")
        return self.verified_content(owner, object_id)

    def training_consent(self, owner, object_id, value: TrainingConsent):
        self.require_enabled()
        now = int(self.clock())
        with self.factory.begin() as db:
            db.execute(update(PrivateMediaObject).where(PrivateMediaObject.id == object_id,
                       PrivateMediaObject.owner_id == owner).values(attempts=PrivateMediaObject.attempts))
            row = self._object(db, owner, object_id, lock=True)
            row.training_consent = {**value.model_dump(), "acceptedAt": now if value.accepted else None, "changedAt": now}
            db.add(PrivateMediaConsentEvent(id=uuid4().hex, owner_id=owner, object_id=object_id,
                                           happened_at=now, scope="training", consent=row.training_consent))
            return {"object": self.describe(row), "withdrawalLimit": TRAINING_LIMIT, "trainingExecuted": False}


def get_private_media_service() -> PrivateMediaService:
    # No env-only auto activation, no unreviewed provider/storage construction.
    raise HTTPException(503, "私有媒体候选尚未接入受保护持久服务")


router = APIRouter(prefix="/api/private-media", tags=["private-media"])


@router.get("")
def list_media(response: Response, owner=Depends(current_user_id), service=Depends(get_private_media_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.list(owner)


@router.post("/intents")
def create_intent(value: MediaIntent, response: Response, owner=Depends(current_user_id), service=Depends(get_private_media_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.create_intent(owner, value)


@router.put("/{object_id}/content")
async def upload_media(object_id: str, request: Request, owner=Depends(current_user_id), service=Depends(get_private_media_service)):
    reserved = service.begin_upload(owner, object_id)
    limit = reserved[0]
    if request.headers.get("content-encoding", "identity") != "identity":
        raise HTTPException(415, "不接受压缩媒体请求")
    length = request.headers.get("content-length")
    if length is not None and (not length.isdigit() or int(length) != limit):
        raise HTTPException(413, "上传长度与对象清单不一致；未保存")
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > limit:
            raise HTTPException(413, "媒体流超过已批准对象大小；未保存")
        content.extend(chunk)
    result = service.upload(owner, object_id, bytes(content), request.headers.get("content-type", ""), _reserved=reserved)
    return Response(canonical_bytes(result), media_type="application/json", headers={"Cache-Control": "no-store"})


@router.get("/{object_id}/access")
def media_access(object_id: str, response: Response, owner=Depends(current_user_id), service=Depends(get_private_media_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.access(owner, object_id)


@router.get("/{object_id}/content")
def read_media(object_id: str, x_media_access: str | None = Header(default=None), owner=Depends(current_user_id), service=Depends(get_private_media_service)):
    descriptor, content = service.read(owner, object_id, x_media_access)
    return Response(content, media_type=descriptor["mime"], headers={"Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment",
                    "X-Media-Sha256": descriptor["sha256"]})


@router.post("/{object_id}/training-consent")
@router.patch("/{object_id}/training-consent")
def change_training_consent(object_id: str, value: TrainingConsent, response: Response,
                            owner=Depends(current_user_id), service=Depends(get_private_media_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.training_consent(owner, object_id, value)


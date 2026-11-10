"""Protected archive/restore candidate. No cleanup or cloud-deletion operation."""
from __future__ import annotations

import json
import io
import secrets
import os
import re
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.auth import current_user_id
from app.private_media import ID_PATTERN, LocalPrivateMediaStore, PrivateMediaService, canonical_bytes, digest, get_private_media_service, validate_mime
from app.private_media_models import MediaArchiveRecord, PrivateMediaOwner, PrivateMediaAccess
from app.supabase_archive_object_store import ARCHIVE_CHUNK_BYTES


class ArchiveConsent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(pattern=r"^media-archive/v1$")
    accepted: StrictBool


class ArchiveLookup(BaseModel):
    model_config=ConfigDict(extra="forbid")
    idempotencyKey:str=Field(pattern=ID_PATTERN)


class ArchiveSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    objectIds: list[str] = Field(min_length=1, max_length=100)
    idempotencyKey: str = Field(pattern=ID_PATTERN)
    archiveConsent: ArchiveConsent


@dataclass(frozen=True)
class ArchivePolicy:
    enabled: bool = False
    protection_verified: bool = False
    persistent_copy_root: Path | None = None
    persistence_verified: bool = False
    retention_policy_id: str | None = None
    retention_policy_verified: bool = False
    object_storage: bool = False

    def __post_init__(self):
        if self.retention_policy_verified and not self.retention_policy_id:
            raise ValueError("保留政策须指定已核实版本")
        if self.persistence_verified and self.persistent_copy_root is None and not self.object_storage:
            raise ValueError("持久副本须指定独立受保护目录")


class MediaArchiveService:
    def __init__(self, media: PrivateMediaService, root: Path | None, policy=ArchivePolicy(), clock=time.time,
                 *, archive_storage=None, lease_expires_at=None, lease_scope="local-archive"):
        self.media,self.factory,self.policy,self.clock = media,media.factory,policy,clock
        self.archive_storage=archive_storage
        self.lease_expires_at,self.lease_scope=lease_expires_at,lease_scope
        if archive_storage is not None:
            if root is not None or policy.object_storage is not True:
                raise ValueError("Object archives require explicit object storage policy, no volume path")
            self.root=None
            return
        if policy.object_storage:
            raise ValueError("Object archive adapter missing")
        self.root=Path(root)
        if not self.root.is_absolute():
            raise ValueError("归档须指定受保护绝对目录")
        LocalPrivateMediaStore._check_tree(self.root)
        if policy.persistent_copy_root is not None:
            copy_root = Path(policy.persistent_copy_root)
            if (not copy_root.is_absolute() or copy_root.resolve() == self.root.resolve()
                    or self.root.resolve() in copy_root.resolve().parents or copy_root.resolve() in self.root.resolve().parents):
                raise ValueError("持久副本须为独立绝对目录")
            LocalPrivateMediaStore._check_tree(copy_root)

    def require_enabled(self):
        self.media.require_enabled()
        if not self.policy.enabled or not self.policy.protection_verified:
            raise HTTPException(503, "受保护归档尚未启用或保护未核实")
        if self.archive_storage is not None and not self.archive_storage.protection_verified:
            raise HTTPException(503,"Archive object facts unavailable; originals retained")

    @staticmethod
    def _safe_id(identity):
        if not re.fullmatch(r"[0-9a-f]{32}", identity):
            raise HTTPException(404, "归档不可用")
        return identity

    def path_for(self, archive_id):
        if self.archive_storage is not None:raise HTTPException(503,"Object archive has no filesystem path")
        path = self.root / "archives" / f"{self._safe_id(archive_id)}.zip"
        LocalPrivateMediaStore._check_tree(path)
        return path

    def _record(self, db, owner, archive_id, *, lock=False):
        self._safe_id(archive_id)
        statement = select(MediaArchiveRecord).where(MediaArchiveRecord.id == archive_id, MediaArchiveRecord.owner_id == owner)
        row = db.scalar(statement.with_for_update() if lock else statement)
        if row is None:
            raise HTTPException(404, "归档不可用")
        return row

    def describe(self, row, *, collected=None):
        complete = bool(row.restore_receipt) and row.restore_receipt.get("state", "complete") == "complete"
        if complete:
            # A durable receipt is evidence of an earlier restore, not current
            # file integrity. Every completed display reads the existing copy;
            # this path cannot create, repair or replace any object or receipt.
            if collected is None:
                collected = self._verified_archive(row)
            self._verify_restore_copy(row, row.restore_receipt, collected)
        self._verify_existing_persistent_copy(row)
        return {"id": row.id, "ownerId": row.owner_id, "manifest": row.manifest,
                "manifestSha256": row.manifest_sha256, "archiveSha256": row.archive_sha256,
                "bytes": row.byte_size, "status": row.status, "createdAt": row.created_at,
                "restoreReceipt": self._public_restore_receipt(row.restore_receipt) if complete else None,
                "restoreProgress": None if complete or not row.restore_receipt else {key: row.restore_receipt.get(key) for key in ("state", "restoreId", "attempts", "reservedBytes", "leaseUntil")},
                "gate": {"restoreVerified": complete,
                         "durableCopyVerified": row.durable_copy_verified,
                         "retentionPolicyVerified": bool(row.retention_policy_id),
                         "retentionPolicyId": row.retention_policy_id,
                         "cleanupEligible": False, "deletionAuthorized": False,
                         "reason": "下载或恢复成功不授权删除；云端及本机源对象均保留，清理需要另行明确对象和授权。"}}

    @staticmethod
    def _public_restore_receipt(receipt):
        return {k:v for k,v in receipt.items() if k not in {"storageBinding","objectWrites","copyWriteAttempted","operation"}}

    def _archive_bytes(self,row):
        if self.archive_storage is not None:
            return self.archive_storage.read_archive(row.owner_id,row.id,row.byte_size)
        path=self.path_for(row.id)
        if path.stat().st_size!=row.byte_size:raise HTTPException(409,"Archive size differs")
        return path.read_bytes()

    @staticmethod
    def _remote_zip(manifest,collected):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,"w",compression=zipfile.ZIP_STORED,allowZip64=False) as bundle:
            bundle.writestr("manifest.json",canonical_bytes(manifest))
            for descriptor,content in collected:bundle.writestr(f"objects/{descriptor['id']}",content)
        return stream.getvalue()

    def _reconcile_archive(self,owner,archive_id,selection_hash):
        # Unknown initial writes are only read at the original immutable key.
        with self.factory.begin() as db:
            db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id==owner).values(used_bytes=PrivateMediaOwner.used_bytes))
            row=self._record(db,owner,archive_id,lock=True)
            if row.selection_digest!=selection_hash:raise HTTPException(409,"Archive selection changed")
            collected=self._verified_archive(row,allow_pending=True)
            row.status="stored"
            return self.describe(row,collected=collected)

    @staticmethod
    def _stored_zip_bytes(manifest):
        # This writer uses seekable ZIP_STORED, ASCII names, no extras or ZIP64:
        # each file has 30 local + 46 central header bytes, and EOCD is 22.
        entries = [("manifest.json", len(canonical_bytes(manifest))),
                   *[(item["path"], item["bytes"]) for item in manifest["objects"]]]
        return 22 + sum(76 + 2 * len(name.encode("ascii")) + size for name, size in entries)

    @staticmethod
    def _archive_reserved_bytes(row):
        # Retain interrupted reservations. Old pending rows with size zero are
        # unknown; do not silently treat unmeasured copies as free capacity.
        if row.status not in ("pending", "stored") or type(row.byte_size) is not int or row.byte_size < 1:
            raise HTTPException(503, "已有ZIP预约容量未知；原资料保留，未新增归档")
        return row.byte_size

    def create(self, owner, value: ArchiveSelection):
        self.require_enabled()
        if not value.archiveConsent.accepted:
            raise HTTPException(403, "须明确同意所选对象的受保护本地归档")
        if len(set(value.objectIds)) != len(value.objectIds) or any(not re.fullmatch(r"[0-9a-f]{32}", item) for item in value.objectIds):
            raise HTTPException(422, "归档对象标识重复或无效")
        selection_binding={"objectIds":sorted(value.objectIds),"consent":value.archiveConsent.model_dump()}
        if self.archive_storage is not None:selection_binding["storageBinding"]=self.archive_storage.binding_id
        selection_hash=digest(canonical_bytes(selection_binding))
        with self.factory() as db:
            existing = db.scalar(select(MediaArchiveRecord).where(MediaArchiveRecord.owner_id == owner,
                                 MediaArchiveRecord.idempotency_key == value.idempotencyKey))
            if existing:
                if existing.selection_digest != selection_hash:
                    raise HTTPException(409, "归档幂等标识对应其它对象；未覆盖")
                if self.archive_storage is not None and existing.status=="pending":
                    return self._reconcile_archive(owner,existing.id,selection_hash)
                # Verify archive contents on every replay; never report a damaged copy as complete.
                collected = self._verified_archive(existing)
                return self.describe(existing, collected=collected)
        collected = [self.media.verified_content(owner, identity) for identity in sorted(value.objectIds)]
        archive_id, now = uuid4().hex, int(self.clock())
        manifest = {"schema": "private-media-archive/v1", "archiveId": archive_id, "ownerId": owner,
                    "createdAt": now, "archiveConsent": value.archiveConsent.model_dump(),
                    "totalBytes": sum(len(content) for _, content in collected),
                    "objects": [{"id": descriptor["id"], "ownerId": owner,
                        "path": f"objects/{descriptor['id']}", "sha256": descriptor["sha256"],
                        "bytes": descriptor["bytes"], "mime": descriptor["mime"], "kind": descriptor["kind"],
                        "restoreRelation": {"clientObjectId": descriptor["clientObjectId"], "selectionId": descriptor["selectionId"]},
                        "saveConsent": descriptor["saveConsent"], "trainingConsentSnapshot": descriptor["trainingConsent"]}
                        for descriptor, _ in collected],
                    "restoreSemantics": ("核对后恢复独立受保护对象副本，不覆盖训练记录，不重授训练同意，不删除任何源资产。" if self.archive_storage is not None else
                        "核对后恢复独立本地副本，不覆盖训练记录，不重授训练同意，不删除任何源资产。") }
        record = MediaArchiveRecord(id=archive_id, owner_id=owner, idempotency_key=value.idempotencyKey,
                 selection_digest=selection_hash, status="pending", manifest=manifest,
                 manifest_sha256=digest(canonical_bytes(manifest)), archive_sha256="0" * 64,
                 byte_size=self._stored_zip_bytes(manifest), created_at=now, durable_copy_verified=False, retention_policy_id=None,
                 restore_receipt=None)
        archive_content=self._remote_zip(manifest,collected) if self.archive_storage is not None else None
        if archive_content is not None:
            if len(archive_content)>50*1024*1024:raise HTTPException(413,"ZIP exceeds50MiB; no reservation or write")
            record.archive_sha256=digest(archive_content)
        path=self.path_for(archive_id) if self.archive_storage is None else None
        try:
            # The existing owner fence serializes all initial ZIP reservations.
            # Exact bytes are committed before any filesystem write; failures
            # retain their pending charge, and a fresh key cannot bypass it.
            with self.factory.begin() as db:
                locked = db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner)
                                    .values(used_bytes=PrivateMediaOwner.used_bytes))
                if locked.rowcount != 1:
                    raise HTTPException(503, "所属账号ZIP预约围栏未知；未归档")
                existing = db.scalar(select(MediaArchiveRecord).where(MediaArchiveRecord.owner_id == owner,
                                     MediaArchiveRecord.idempotency_key == value.idempotencyKey))
                if existing:
                    if existing.selection_digest != selection_hash:
                        raise HTTPException(409, "归档幂等标识对应其它对象；未覆盖")
                    return self.describe(existing, collected=self._verified_archive(existing))
                used = sum(self._archive_reserved_bytes(saved) for saved in db.scalars(
                           select(MediaArchiveRecord).where(MediaArchiveRecord.owner_id == owner)).all())
                if used + record.byte_size > self.media.policy.max_bytes:
                    raise HTTPException(413, "独立ZIP累计预约容量不足；未新增归档")
                db.add(record)
                db.flush()
                db.expunge(record)
            if self.archive_storage is not None:
                self.archive_storage.put_archive(owner,archive_id,archive_content)
            else:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                LocalPrivateMediaStore._check_tree(path)
                with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_STORED, allowZip64=False) as bundle:
                    os.chmod(path, 0o600)
                    bundle.writestr("manifest.json", canonical_bytes(manifest))
                    for descriptor, content in collected:
                        bundle.writestr(f"objects/{descriptor['id']}", content)
                with path.open("r+b") as stream:
                    os.fsync(stream.fileno())
                archive_content = path.read_bytes()
            if len(archive_content) != record.byte_size:
                raise HTTPException(409, "实际ZIP大小与耐久预约不一致；原预约和资料保留")
            record.archive_sha256, record.status = digest(archive_content), "stored"
            # Verify real ZIP entries before committing any completion receipt.
            self._verified_archive(record)
            with self.factory.begin() as db:
                if self.archive_storage is not None:
                    db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id==owner).values(used_bytes=PrivateMediaOwner.used_bytes))
                    saved=self._record(db,owner,archive_id,lock=True)
                    if (saved.idempotency_key!=value.idempotencyKey or saved.selection_digest!=selection_hash
                        or saved.manifest_sha256!=record.manifest_sha256 or saved.archive_sha256!=record.archive_sha256
                        or saved.byte_size!=record.byte_size or saved.status not in ("pending","stored")):
                        raise HTTPException(409,"Original archive registration changed; late result rejected")
                    # Never merge detached completion over later restore/attempt metadata.
                    saved.status="stored"
                else:saved=db.merge(record)
                db.flush()
                return self.describe(saved)
        except IntegrityError:
            # Retain extra immutable file rather than deleting unreviewed assets.
            with self.factory() as db:
                existing = db.scalar(select(MediaArchiveRecord).where(MediaArchiveRecord.owner_id == owner,
                                     MediaArchiveRecord.idempotency_key == value.idempotencyKey))
                if existing and existing.selection_digest == selection_hash:
                    collected = self._verified_archive(existing)
                    return self.describe(existing, collected=collected)
            raise HTTPException(409, "归档登记并发冲突；原对象保留") from None
        except (OSError, SQLAlchemyError, zipfile.BadZipFile):
            raise HTTPException(503, "归档写入或登记失败；原对象保留，未报成功") from None

    def _verified_archive(self, record, *, allow_pending=False):
        if self.archive_storage is not None:
            expected=digest(canonical_bytes({"objectIds":sorted(item["id"] for item in record.manifest["objects"]),
                "consent":record.manifest["archiveConsent"],"storageBinding":self.archive_storage.binding_id}))
            if record.selection_digest!=expected:raise HTTPException(409,"Original ZIP storage binding changed; no read or replay")
        if record.status != "stored" and not (allow_pending and self.archive_storage is not None and record.status=="pending" and record.archive_sha256!="0"*64):
            raise HTTPException(409, "归档未完成或中断待修复；源对象保留")
        if (record.manifest.get("schema") != "private-media-archive/v1"
                or record.manifest.get("ownerId") != record.owner_id or record.manifest.get("archiveId") != record.id):
            raise HTTPException(409, "Archive owner or schema mismatch")
        try:
            if self.archive_storage is not None and record.manifest.get("restoreSemantics")!="核对后恢复独立受保护对象副本，不覆盖训练记录，不重授训练同意，不删除任何源资产。":
                raise HTTPException(409,"Archive object semantics differ")
            content=self._archive_bytes(record)
            if len(content)!=record.byte_size:raise HTTPException(409,"Archive actual size differs")
            if digest(content) != record.archive_sha256 or digest(canonical_bytes(record.manifest)) != record.manifest_sha256:
                raise HTTPException(409, "归档或清单摘要不一致；未恢复")
            collected = []
            with zipfile.ZipFile(io.BytesIO(content)) as bundle:
                names = bundle.namelist()
                expected = ["manifest.json", *[item["path"] for item in record.manifest["objects"]]]
                if len(set(names)) != len(names) or set(names) != set(expected):
                    raise HTTPException(409, "归档含多余、重复或缺失对象；未恢复")
                info = bundle.getinfo("manifest.json")
                if info.file_size > 1024 * 1024:
                    raise HTTPException(409, "归档清单超过容量；未恢复")
                raw_manifest = bundle.read("manifest.json")
                if raw_manifest != canonical_bytes(record.manifest):
                    raise HTTPException(409, "归档清单与登记不一致；未恢复")
                total = 0
                for item in record.manifest["objects"]:
                    if item["ownerId"] != record.owner_id or item["path"] != f"objects/{self._safe_id(item['id'])}":
                        raise HTTPException(409, "归档归属或恢复关系无效；未恢复")
                    info = bundle.getinfo(item["path"])
                    if info.file_size != item["bytes"] or info.file_size > self.media.policy.max_object_bytes:
                        raise HTTPException(409, "归档对象大小不一致；未恢复")
                    total += info.file_size
                    if total > self.media.policy.max_bytes:
                        raise HTTPException(409, "归档展开超过容量；未恢复")
                    value = bundle.read(item["path"])
                    if digest(value) != item["sha256"]:
                        raise HTTPException(409, "归档对象摘要损坏；未恢复")
                    validate_mime(value, item["mime"])
                    collected.append((item, value))
                if total != record.manifest["totalBytes"]:
                    raise HTTPException(409, "归档总大小不一致；未恢复")
            return collected
        except (OSError, KeyError, ValueError, zipfile.BadZipFile, RuntimeError):
            raise HTTPException(409, "归档缺失或结构损坏；未恢复") from None

    def lookup(self,owner,value:ArchiveLookup):
        self.require_enabled()
        with self.factory() as db:
            row=db.scalar(select(MediaArchiveRecord).where(MediaArchiveRecord.owner_id==owner,
                MediaArchiveRecord.idempotency_key==value.idempotencyKey))
            if row is None:raise HTTPException(404,"Original archive request unavailable; no write or replay")
            archive_id,selection_hash,status=row.id,row.selection_digest,row.status
        if self.archive_storage is not None and status=="pending":
            return self._reconcile_archive(owner,archive_id,selection_hash)
        return self.get(owner,archive_id)

    def get(self, owner, archive_id):
        self.require_enabled()
        with self.factory.begin() as db:
            row = self._record(db, owner, archive_id)
            if self.archive_storage is not None and row.restore_receipt and row.restore_receipt.get("state")=="pending":
                # Same original reservation, even after attempt three: GET objects only.
                locked=db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id==owner).values(used_bytes=PrivateMediaOwner.used_bytes))
                if locked.rowcount!=1:raise HTTPException(503,"Archive owner fence unavailable")
                row=self._record(db,owner,archive_id,lock=True)
                collected=self._verified_archive(row)
                self._remote_restore_reconcile(row,collected)
            else:collected=self._verified_archive(row)
            return self.describe(row, collected=collected)

    def download(self, owner, archive_id, *, maximum=None):
        self.require_enabled()
        with self.factory() as db:
            row = self._record(db, owner, archive_id)
            if maximum is not None and row.byte_size>maximum:raise HTTPException(413,"Use bounded ZIP lease chunks")
            self._verified_archive(row)
            content = self._archive_bytes(row)
            if len(content) != row.byte_size or digest(content) != row.archive_sha256:
                raise HTTPException(409, "Archive changed during download; no bytes returned")
            return content, row.archive_sha256

    def _lease_hash(self,token,row):
        return digest(canonical_bytes({"purpose":"archive-read/v1","scope":self.lease_scope,"token":token,
            "archiveId":row.id,"archiveSha256":row.archive_sha256,"manifestSha256":row.manifest_sha256,"bytes":row.byte_size}))

    def download_lease(self,owner,archive_id):
        self.require_enabled()
        with self.factory.begin() as db:
            row=self._record(db,owner,archive_id)
            self._verified_archive(row)
            now=int(self.clock());expires=now+60
            if self.lease_expires_at is not None:expires=min(expires,int(self.lease_expires_at))
            if expires<=now+1:raise HTTPException(503,"Archive lease window expired")
            token=secrets.token_urlsafe(32)
            db.add(PrivateMediaAccess(token_hash=self._lease_hash(token,row),owner_id=owner,object_id=row.id,expires_at=expires))
            return {"archiveId":row.id,"archiveSha256":row.archive_sha256,"manifestSha256":row.manifest_sha256,
                "bytes":row.byte_size,"leaseToken":token,"expiresAt":expires,"chunkBytes":ARCHIVE_CHUNK_BYTES}

    def _lease(self,db,owner,row,token):
        if type(token) is not str or re.fullmatch(r"[A-Za-z0-9_-]{16,128}",token) is None:
            raise HTTPException(404,"Archive download lease unavailable")
        grant=db.scalar(select(PrivateMediaAccess).where(PrivateMediaAccess.token_hash==self._lease_hash(token,row)).execution_options(populate_existing=True))
        if grant is None or grant.owner_id!=owner or grant.object_id!=row.id or grant.expires_at<=int(self.clock()):
            raise HTTPException(404,"Archive download lease unavailable")
        return grant

    def download_chunk(self,owner,archive_id,token,offset,length):
        self.require_enabled()
        with self.factory() as db:
            row=self._record(db,owner,archive_id)
            self._lease(db,owner,row,token)
            if row.status!="stored" or type(offset) is not int or type(length) is not int or offset<0 or not 1<=length<=ARCHIVE_CHUNK_BYTES or offset+length>row.byte_size:
                raise HTTPException(422,"Archive chunk does not match the fixed object")
            if self.archive_storage is not None:
                value=self.archive_storage.read_archive_range(owner,row.id,row.byte_size,offset,length)
            else:
                self._verified_archive(row);value=self._archive_bytes(row)[offset:offset+length]
            self.require_enabled();self._lease(db,owner,row,token)
            if len(value)!=length:raise HTTPException(409,"Archive chunk actual length differs")
            return value,row.archive_sha256

    def revoke_download(self,owner,archive_id,token):
        self.require_enabled()
        with self.factory.begin() as db:
            row=self._record(db,owner,archive_id)
            self._lease(db,owner,row,token).expires_at=0
        return {"revoked":True,"sourceAssetsRetained":True}

    def _restore_root(self, receipt):
        root = self.root / "restored" / self._safe_id(receipt["restoreId"])
        LocalPrivateMediaStore._check_tree(root)
        return root

    @staticmethod
    def _restore_bytes(row):
        receipt = row.restore_receipt
        if receipt is None:
            return 0
        if not isinstance(receipt, dict):
            raise HTTPException(503, "恢复预约账不可读；未新增副本")
        size = receipt.get("reservedBytes")
        if size is None and "state" not in receipt and receipt.get("restoredObjects"):
            # Existing completed v1 copies are retained and charged, never recreated.
            size = row.manifest["totalBytes"] + (row.byte_size if row.durable_copy_verified else 0)
        if type(size) is not int or size < 1:
            raise HTTPException(503, "恢复预约容量未知；未新增副本")
        return size

    def _verify_restore_copy(self, row, receipt, collected):
        if (receipt.get("ownerId") != row.owner_id or receipt.get("archiveId") != row.id
                or receipt.get("archiveSha256") != row.archive_sha256):
            raise HTTPException(409, "恢复回执归属或版本无效；未新增副本")
        if self.archive_storage is not None:
            if receipt.get("storageBinding")!=self.archive_storage.binding_id:raise HTTPException(409,"Restore storage binding changed")
            restored=[]
            # The contract is the fixed manifest target set, not a bucket/prefix listing.
            for item,_ in collected:
                actual=self.archive_storage.read_restored(row.owner_id,receipt["restoreId"],item["id"],item["bytes"],item["mime"])
                if len(actual)!=item["bytes"] or digest(actual)!=item["sha256"]:raise HTTPException(409,"Restored object differs; retained")
                validate_mime(actual,item["mime"])
                restored.append({"id":item["id"],"bytes":len(actual),"sha256":digest(actual),"restoreRelation":item["restoreRelation"],"ownerId":row.owner_id,"trainingConsentRestored":False,"newTrainingConsentRequired":True})
            if receipt.get("state","complete")=="complete" and receipt.get("restoredObjects")!=restored:raise HTTPException(409,"Restore receipt differs from actual objects")
            return restored
        root = self._restore_root(receipt)
        try:
            expected = {item["id"] for item, _ in collected}
            if not root.is_dir() or {path.name for path in root.iterdir()} != expected:
                raise HTTPException(409, "已有恢复副本缺件或多件；原资料保留")
            restored = []
            for item, _ in collected:
                path = root / self._safe_id(item["id"])
                LocalPrivateMediaStore._check_tree(path)
                if path.stat().st_size != item["bytes"]:
                    raise HTTPException(409, "恢复副本大小不一致；未覆盖或另建副本")
                actual = path.read_bytes()
                if len(actual) != item["bytes"] or digest(actual) != item["sha256"]:
                    raise HTTPException(409, "已有恢复副本损坏；未覆盖或另建副本")
                restored.append({"id": item["id"], "bytes": len(actual), "sha256": digest(actual),
                                 "restoreRelation": item["restoreRelation"], "ownerId": row.owner_id,
                                 "trainingConsentRestored": False, "newTrainingConsentRequired": True})
            if receipt.get("state", "complete") == "complete" and receipt.get("restoredObjects") != restored:
                raise HTTPException(409, "恢复回执与实际对象不一致；未报成功")
            return restored
        except (OSError, KeyError, ValueError):
            raise HTTPException(409, "已有恢复副本不可核验；未新增副本") from None

    def _remote_restore_write(self,owner,archive_id,reservation,collected):
        for item,content in collected:
            with self.factory.begin() as db:
                row=self._record(db,owner,archive_id,lock=True);current=row.restore_receipt
                if not current or current.get("operation")!=reservation["operation"] or current.get("storageBinding")!=self.archive_storage.binding_id:
                    raise HTTPException(409,"Restore operation or storage changed")
                writes=dict(current.get("objectWrites",{}));fresh=item["id"] not in writes
                if not fresh and writes[item["id"]]!=item["sha256"]:raise HTTPException(409,"Restore write ledger differs")
                if fresh:
                    writes[item["id"]]=item["sha256"]
                    row.restore_receipt={**current,"objectWrites":writes}
            # Intent is durable before POST; an attempted original is only read.
            if fresh:self.archive_storage.put_restored(owner,reservation["restoreId"],item["id"],content,item["mime"])
            else:
                actual=self.archive_storage.read_restored(owner,reservation["restoreId"],item["id"],item["bytes"],item["mime"])
                if len(actual)!=len(content) or digest(actual)!=item["sha256"]:raise HTTPException(409,"Original restore bytes differ")

    def _remote_restore_reconcile(self,row,collected):
        prior=row.restore_receipt
        if not prior or prior.get("state")!="pending" or prior.get("storageBinding")!=self.archive_storage.binding_id:return False
        reservation_key=digest(canonical_bytes({"owner":row.owner_id,"archive":row.id,"manifestSha256":row.manifest_sha256}))
        if (prior.get("version")!="media-restore/v2" or prior.get("idempotencyKey")!=reservation_key
            or prior.get("restoreId")!=reservation_key[:32] or prior.get("ownerId")!=row.owner_id
            or prior.get("archiveId")!=row.id or prior.get("archiveSha256")!=row.archive_sha256
            or self._restore_bytes(row)!=row.manifest["totalBytes"]+(row.byte_size if self.policy.persistence_verified else 0)
            or type(prior.get("attempts")) is not int or not 1<=prior["attempts"]<=3
            or type(prior.get("leaseUntil")) is not int):raise HTTPException(409,"Original restore reservation differs")
        expected={item["id"]:item["sha256"] for item,_ in collected}
        if prior.get("objectWrites")!=expected or (self.policy.persistence_verified and prior.get("copyWriteAttempted") is not True):return False
        restored=self._verify_restore_copy(row,prior,collected)
        if self.policy.persistence_verified:
            value=self.archive_storage.read_copy(row.owner_id,row.id,row.byte_size)
            if len(value)!=row.byte_size or digest(value)!=row.archive_sha256:raise HTTPException(409,"Original durable ZIP differs")
        receipt={k:v for k,v in prior.items() if k!="operation"}
        receipt.update({"state":"complete","leaseUntil":0,"verifiedAt":int(self.clock()),"restoredObjects":restored})
        row.restore_receipt=receipt;row.durable_copy_verified=self.policy.persistence_verified
        row.retention_policy_id=self.policy.retention_policy_id if self.policy.retention_policy_verified else None
        return True

    def verify_restore(self, owner, archive_id):
        self.require_enabled()
        # The existing per-owner row serializes all restore reservations (including
        # different archives). No new table, schema migration or silent quota reset.
        try:
            with self.factory.begin() as db:
                self._record(db, owner, archive_id)  # Authorization first; missing foreign objects remain 404.
                locked = db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner)
                                    .values(used_bytes=PrivateMediaOwner.used_bytes))
                if locked.rowcount != 1:
                    raise HTTPException(503, "所属账号预约围栏未知；未恢复")
                row = self._record(db, owner, archive_id, lock=True)
                collected = self._verified_archive(row)
                archive_hash = row.archive_sha256
                now = int(self.clock())  # Lease starts after owner lock and archive verification.
                prior = row.restore_receipt
                if prior and prior.get("state", "complete") == "complete":
                    # Lost replies and reopen are read-only: stable receipt/path,
                    # actual bytes checked each time, no new persistent ZIP either.
                    return self.describe(row, collected=collected)
                reserved_bytes = row.manifest["totalBytes"] + (row.byte_size if self.policy.persistence_verified else 0)
                reservation_key = digest(canonical_bytes({"owner": owner, "archive": archive_id,
                                                        "manifestSha256": row.manifest_sha256}))
                if prior:
                    if (prior.get("version") != "media-restore/v2" or prior.get("state") != "pending"
                            or prior.get("idempotencyKey") != reservation_key or prior.get("ownerId") != owner
                            or prior.get("archiveId") != archive_id or prior.get("archiveSha256") != archive_hash
                            or prior.get("restoreId") != reservation_key[:32]
                            or self._restore_bytes(row) != reserved_bytes):
                        raise HTTPException(409, "原恢复预约不匹配；原资料保留")
                    if (type(prior.get("attempts")) is not int or not 1 <= prior["attempts"] <= 3
                            or type(prior.get("leaseUntil")) is not int):
                        raise HTTPException(503, "恢复尝试账未知；未恢复")
                    if self.archive_storage is not None and self._remote_restore_reconcile(row,collected):
                        return self.describe(row,collected=collected)
                    if prior["leaseUntil"] > now:
                        raise HTTPException(409, "已有恢复预约尚在执行窗口；稍后只核对原副本")
                    if prior["attempts"] >= 3:
                        raise HTTPException(409, "恢复尝试已达3次；原预约和资料保留，不另建副本")
                else:
                    used = sum(self._restore_bytes(saved) for saved in db.scalars(
                               select(MediaArchiveRecord).where(MediaArchiveRecord.owner_id == owner)).all())
                    if used + reserved_bytes > self.media.policy.max_bytes:
                        raise HTTPException(413, "独立恢复累计预约容量不足；未新增副本")
                reservation = {"version": "media-restore/v2", "state": "pending",
                               "idempotencyKey": reservation_key, "restoreId": reservation_key[:32],
                               "archiveId": archive_id, "ownerId": owner, "archiveSha256": archive_hash,
                               "reservedBytes": reserved_bytes, "attempts": prior["attempts"] + 1 if prior else 1,
                               "leaseUntil": now + 30, "operation": uuid4().hex, "sourceAssetsRetained": True}
                if self.archive_storage is not None:
                    if prior and prior.get("storageBinding")!=self.archive_storage.binding_id:raise HTTPException(409,"Restore storage binding changed")
                    reservation.update({"storageBinding":self.archive_storage.binding_id,"objectWrites":dict(prior.get("objectWrites",{})) if prior else {},"copyWriteAttempted":prior.get("copyWriteAttempted",False) if prior else False})
                row.restore_receipt = reservation
                row.durable_copy_verified = False
                row.retention_policy_id = None
            # The reservation is durable before any directory/object write.
            if self.archive_storage is not None:
                self._remote_restore_write(owner,archive_id,reservation,collected)
            else:
                root = self._restore_root(reservation)
                root.mkdir(parents=True, exist_ok=True, mode=0o700)
                expected = {item["id"] for item, _ in collected}
                if not {path.name for path in root.iterdir()}.issubset(expected):
                    raise HTTPException(409, "恢复目录含其它对象；未覆盖或另建目录")
                for item, content in collected:
                    path = root / self._safe_id(item["id"])
                    LocalPrivateMediaStore._check_tree(path)
                    try:
                        with path.open("xb") as stream:
                            os.chmod(path, 0o600)
                            stream.write(content)
                            stream.flush()
                            os.fsync(stream.fileno())
                    except FileExistsError:
                        # Resume exact files only. Partial/corrupt bytes are retained;
                        # this operation has no repair, overwrite or deletion authority.
                        pass
                    if path.stat().st_size != item["bytes"]:
                        raise HTTPException(409, "恢复副本大小不一致；未覆盖或另建副本")
                    actual = path.read_bytes()
                    if len(actual) != item["bytes"] or digest(actual) != item["sha256"]:
                        raise HTTPException(409, "恢复副本实际校验失败；未覆盖或另建副本")
            persistent_verified = self._persistent_copy(archive_id, archive_hash, owner=owner, operation=reservation["operation"])
            with self.factory.begin() as db:
                db.execute(update(PrivateMediaOwner).where(PrivateMediaOwner.owner_id == owner)
                           .values(used_bytes=PrivateMediaOwner.used_bytes))
                row = self._record(db, owner, archive_id, lock=True)
                current = row.restore_receipt
                if (not current or current.get("state") != "pending"
                        or current.get("operation") != reservation["operation"]):
                    raise HTTPException(409, "恢复预约已变化；迟到结果未采用，原副本保留")
                restored = self._verify_restore_copy(row, current, collected)
                receipt = {key: value for key, value in current.items() if key != "operation"}
                receipt.update({"state": "complete", "leaseUntil": 0,
                                "verifiedAt": int(self.clock()), "restoredObjects": restored})
                row.restore_receipt = receipt
                row.durable_copy_verified = persistent_verified
                row.retention_policy_id = self.policy.retention_policy_id if self.policy.retention_policy_verified else None
                return self.describe(row, collected=collected)
        except (OSError, SQLAlchemyError):
            raise HTTPException(503, "恢复写入或登记失败；耐久预约及原对象保留，不报成功") from None

    def _verify_existing_persistent_copy(self, row):
        if not row.durable_copy_verified:
            return
        if self.archive_storage is not None:
            if not self.policy.persistence_verified or row.restore_receipt.get("storageBinding")!=self.archive_storage.binding_id:raise HTTPException(409,"Durable copy facts/binding unavailable")
            value=self.archive_storage.read_copy(row.owner_id,row.id,row.byte_size)
            if len(value)!=row.byte_size or digest(value)!=row.archive_sha256:raise HTTPException(409,"Durable copy actual bytes differ")
            return
        if not self.policy.persistence_verified or self.policy.persistent_copy_root is None:
            raise HTTPException(409, "持久副本当前保护事实未知；未继续报告通过")
        path = Path(self.policy.persistent_copy_root) / f"{self._safe_id(row.id)}.zip"
        LocalPrivateMediaStore._check_tree(path)
        try:
            if path.stat().st_size != row.byte_size:
                raise HTTPException(409, "已有持久副本大小不一致；未覆盖或另建副本")
            content = path.read_bytes()
            if len(content) != row.byte_size or digest(content) != row.archive_sha256:
                raise HTTPException(409, "已有持久副本摘要损坏；未继续报告通过")
        except OSError:
            raise HTTPException(409, "已有持久副本缺失或不可读；未新增副本") from None

    def _persistent_copy(self, archive_id, expected_hash, *, owner=None, operation=None):
        if self.archive_storage is not None:
            if not self.policy.persistence_verified:return False
            with self.factory() as db:
                row=self._record(db,owner,archive_id);current=row.restore_receipt
                if not current or current.get("operation")!=operation or current.get("storageBinding")!=self.archive_storage.binding_id:raise HTTPException(409,"ZIP copy operation changed")
                fresh=current.get("copyWriteAttempted") is not True;size=row.byte_size
            if fresh:
                value=self.archive_storage.read_archive(owner,archive_id,size)
                if len(value)!=size or digest(value)!=expected_hash:raise HTTPException(409,"ZIP copy source differs")
                # Source read failure is not a copy write attempt. Recheck under lock.
                with self.factory.begin() as db:
                    row=self._record(db,owner,archive_id,lock=True);current=row.restore_receipt
                    if not current or current.get("operation")!=operation or current.get("storageBinding")!=self.archive_storage.binding_id or row.byte_size!=size:raise HTTPException(409,"ZIP copy operation changed")
                    fresh=current.get("copyWriteAttempted") is not True
                    if fresh:row.restore_receipt={**current,"copyWriteAttempted":True}
                if fresh:self.archive_storage.put_copy(owner,archive_id,value)
            actual=self.archive_storage.read_copy(owner,archive_id,size)
            if len(actual)!=size or digest(actual)!=expected_hash:raise HTTPException(409,"Independent ZIP actual bytes differ")
            return True
        if not self.policy.persistence_verified or self.policy.persistent_copy_root is None:
            return False
        root = Path(self.policy.persistent_copy_root)
        LocalPrivateMediaStore._check_tree(root)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = root / f"{self._safe_id(archive_id)}.zip"
        LocalPrivateMediaStore._check_tree(path)
        value = self.path_for(archive_id).read_bytes()
        if digest(value) != expected_hash:
            raise HTTPException(409, "持久副本来源摘要不一致")
        try:
            with path.open("xb") as stream:
                os.chmod(path, 0o600)
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            pass
        actual = path.read_bytes()
        if len(actual) != len(value) or digest(actual) != expected_hash:
            raise HTTPException(409, "独立持久副本实际核验失败；源对象不删除")
        return True


def get_media_archive_service():
    raise HTTPException(503, "受保护归档候选尚未接入持久服务")


router = APIRouter(prefix="/api/media-archives", tags=["media-archives"])


@router.post("")
def create_archive(value: ArchiveSelection, response: Response, owner=Depends(current_user_id), service=Depends(get_media_archive_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.create(owner, value)


@router.post("/lookup")
def lookup_archive(value:ArchiveLookup,owner:str=Depends(current_user_id),service:MediaArchiveService=Depends(get_media_archive_service)):
    return service.lookup(owner,value)


@router.get("/{archive_id}")
def get_archive(archive_id: str, response: Response, owner=Depends(current_user_id), service=Depends(get_media_archive_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.get(owner, archive_id)


@router.get("/{archive_id}/content")
def download_archive(archive_id: str, owner=Depends(current_user_id), service=Depends(get_media_archive_service)):
    content, sha = service.download(owner, archive_id, maximum=4_000_000)
    return Response(content, media_type="application/zip", headers={"Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff", "X-Archive-Sha256": sha,
                    "Content-Disposition": f'attachment; filename="private-media-{archive_id}.zip"'})


@router.post("/{archive_id}/verify-restore")
def restore_archive(archive_id: str, response: Response, owner=Depends(current_user_id), service=Depends(get_media_archive_service)):
    response.headers["Cache-Control"] = "no-store"
    return service.verify_restore(owner, archive_id)



class ArchiveChunkRequest(BaseModel):
    model_config=ConfigDict(extra="forbid")
    leaseToken: str=Field(pattern=r"^[A-Za-z0-9_-]{16,128}$")
    offset: StrictInt=Field(ge=0)
    bytes: StrictInt=Field(gt=0,le=ARCHIVE_CHUNK_BYTES)

class ArchiveLeaseRevoke(BaseModel):
    model_config=ConfigDict(extra="forbid")
    leaseToken: str=Field(pattern=r"^[A-Za-z0-9_-]{16,128}$")

@router.post("/{archive_id}/download-lease")
def archive_download_lease(archive_id:str,response:Response,owner=Depends(current_user_id),service=Depends(get_media_archive_service)):
    response.headers["Cache-Control"]="no-store"
    return service.download_lease(owner,archive_id)

@router.post("/{archive_id}/content-chunk")
def archive_download_chunk(archive_id:str,value:ArchiveChunkRequest,owner=Depends(current_user_id),service=Depends(get_media_archive_service)):
    content,sha=service.download_chunk(owner,archive_id,value.leaseToken,value.offset,value.bytes)
    return Response(content,media_type="application/zip",headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Archive-Sha256":sha})

@router.post("/{archive_id}/revoke-download")
def archive_revoke_download(archive_id:str,value:ArchiveLeaseRevoke,response:Response,owner=Depends(current_user_id),service=Depends(get_media_archive_service)):
    response.headers["Cache-Control"]="no-store"
    return service.revoke_download(owner,archive_id,value.leaseToken)

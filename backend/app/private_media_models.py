"""Additive private-media metadata; importing never creates tables or assets."""
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.db import Base


class PrivateMediaOwner(Base):
    __tablename__ = "private_media_owners"
    __table_args__ = (CheckConstraint("used_bytes >= 0 AND reserved_bytes >= 0", name="ck_private_media_quota_nonnegative"),)
    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    used_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    reserved_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)


class PrivateMediaObject(Base):
    __tablename__ = "private_media_objects"
    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key", name="uq_private_media_idempotency"),
        CheckConstraint("byte_size > 0 AND attempts >= 0", name="ck_private_media_object_size"),
        CheckConstraint("status IN ('pending','stored','expired','repair-required')", name="ck_private_media_object_status"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    client_object_id: Mapped[str] = mapped_column(String(160), nullable=False)
    selection_id: Mapped[str] = mapped_column(String(160), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    mime: Mapped[str] = mapped_column(String(64), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    intent_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    stored_at: Mapped[int | None] = mapped_column(BigInteger)
    save_consent: Mapped[dict] = mapped_column(JSON, nullable=False)
    training_consent: Mapped[dict] = mapped_column(JSON, nullable=False)


class PrivateMediaConsentEvent(Base):
    __tablename__ = "private_media_consent_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    object_id: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    happened_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    consent: Mapped[dict] = mapped_column(JSON, nullable=False)


class PrivateMediaAccess(Base):
    __tablename__ = "private_media_access"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), nullable=False)
    object_id: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class MediaArchiveRecord(Base):
    __tablename__ = "media_archive_records"
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key", name="uq_media_archive_idempotency"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    selection_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    manifest: Mapped[dict] = mapped_column(JSON, nullable=False)
    manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    archive_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    restore_receipt: Mapped[dict | None] = mapped_column(JSON)
    durable_copy_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    retention_policy_id: Mapped[str | None] = mapped_column(String(160))

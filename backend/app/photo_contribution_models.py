"""Independent metadata; importing does not connect, create tables or upload."""
from sqlalchemy import Boolean, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class ContributionBase(DeclarativeBase):
    pass


class ContributionChoice(ContributionBase):
    __tablename__ = 'photo_contribution_choices'
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    choice: Mapped[str] = mapped_column(String(16), nullable=False)
    policy_version: Mapped[str] = mapped_column(String(40), nullable=False)
    epoch: Mapped[str | None] = mapped_column(String(36))
    effective_at: Mapped[str] = mapped_column(String(35), nullable=False)


class ContributionReceipt(ContributionBase):
    __tablename__ = 'photo_contribution_receipts'
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation: Mapped[str] = mapped_column(String(16), nullable=False)
    body_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    sample_id: Mapped[str | None] = mapped_column(String(36))
    at: Mapped[str] = mapped_column(String(35), nullable=False)
    # Choice event contains only choice/revision/epoch/policy; no user profile.
    event: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class ContributionSample(ContributionBase):
    __tablename__ = 'photo_contribution_samples'
    __table_args__ = (UniqueConstraint('service','user_id','image_sha256', name='uq_contribution_owner_image'),
        Index('ix_contribution_due','service','storage_scope','delete_after'),)
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sample_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    epoch: Mapped[str] = mapped_column(String(36), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    # Null legacy rows are not assumed to belong to the new dedicated prefix.
    storage_scope: Mapped[str | None] = mapped_column(String(32))
    object_id: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    image_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    image_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    upload_request: Mapped[str | None] = mapped_column(String(36))
    manifest: Mapped[dict | None] = mapped_column(JSON)
    received_at: Mapped[str | None] = mapped_column(String(35))
    created_at: Mapped[str] = mapped_column(String(35), nullable=False)
    delete_after: Mapped[str] = mapped_column(String(35), nullable=False)
    retention_policy: Mapped[str] = mapped_column(String(80), nullable=False)


class ContributionDeletion(ContributionBase):
    """Durable fence; object/hash/size/version are erased after verified removal.

    The account-lifetime tombstone is only owner/service + opaque sample/request
    IDs and state. Account erasure removes it with the owner's choice records.
    """
    __tablename__ = 'photo_contribution_deletions'
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sample_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    state: Mapped[str] = mapped_column(String(24), nullable=False)
    object_id: Mapped[str | None] = mapped_column(String(32))
    image_sha256: Mapped[str | None] = mapped_column(String(64))
    image_bytes: Mapped[int | None] = mapped_column(Integer)
    version: Mapped[str | None] = mapped_column(String(80))
    settled: Mapped[bool | None] = mapped_column(Boolean)
    upload_attempted: Mapped[bool | None] = mapped_column(Boolean)
    delete_attempted: Mapped[bool | None] = mapped_column(Boolean)
    checked_at: Mapped[str | None] = mapped_column(String(35))

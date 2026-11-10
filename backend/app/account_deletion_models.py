"""Private deletion receipts; importing this module never performs DDL."""
from sqlalchemy import Integer, String, JSON, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class DeletionBase(DeclarativeBase):
    pass


class AccountDeletionRequest(DeletionBase):
    __tablename__ = 'account_deletion_requests'
    __table_args__ = (UniqueConstraint('owner_digest'), UniqueConstraint('barrier_digest'))
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False)
    owner: Mapped[str | None] = mapped_column(String(36))
    owner_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    barrier_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    capability_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    scope_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False)
    stage: Mapped[str] = mapped_column(String(24), nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)


class AccountDeletionObject(DeletionBase):
    __tablename__ = 'account_deletion_objects'
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    target: Mapped[dict] = mapped_column(JSON, nullable=False)
    observed_version: Mapped[str | None] = mapped_column(String(1024))
    state: Mapped[str] = mapped_column(String(24), nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)

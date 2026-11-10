"""Local-first text community tables; no media or training data projection."""
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class CommunityProfile(Base):
    __tablename__ = "community_profiles"

    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    nickname: Mapped[str] = mapped_column(String(20), nullable=False)
    nickname_key: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CommunityPost(Base):
    __tablename__ = "community_posts"
    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key", name="uq_community_post_idempotency"),
        CheckConstraint("revision >= 1", name="ck_community_post_revision"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    body: Mapped[str] = mapped_column(Text(), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="visible")
    revision: Mapped[int] = mapped_column(Integer(), nullable=False, default=1)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CommunityComment(Base):
    __tablename__ = "community_comments"
    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key", name="uq_community_comment_idempotency"),
        CheckConstraint("revision >= 1", name="ck_community_comment_revision"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    post_id: Mapped[str] = mapped_column(ForeignKey("community_posts.id"), nullable=False, index=True)
    owner_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    body: Mapped[str] = mapped_column(Text(), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="visible")
    revision: Mapped[int] = mapped_column(Integer(), nullable=False, default=1)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CommunityReport(Base):
    __tablename__ = "community_reports"
    __table_args__ = (UniqueConstraint("reporter_id", "target_kind", "target_id", name="uq_community_report_target"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    reporter_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    target_kind: Mapped[str] = mapped_column(String(12), nullable=False)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    decision: Mapped[str | None] = mapped_column(String(12), nullable=True)
    moderator_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CommunityModerator(Base):
    __tablename__ = "community_moderators"

    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    active: Mapped[bool] = mapped_column(Boolean(), nullable=False, default=True)


class CommunityRateWindow(Base):
    __tablename__ = "community_rate_windows"
    __table_args__ = (CheckConstraint("uses >= 1", name="ck_community_rate_uses"),)

    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(12), primary_key=True)
    bucket: Mapped[int] = mapped_column(Integer(), primary_key=True)
    uses: Mapped[int] = mapped_column(Integer(), nullable=False)

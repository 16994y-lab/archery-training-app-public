from datetime import datetime
from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class TargetType(StrEnum):
    WA_10_RING = "WA_10_RING"
    WA_VERTICAL_3_SPOT = "WA_VERTICAL_3_SPOT"
    CUSTOM_SCORE_ONLY = "CUSTOM_SCORE_ONLY"


class PlanStatus(StrEnum):
    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"


class BlockType(StrEnum):
    WARMUP = "WARMUP"
    TECHNIQUE = "TECHNIQUE"
    SCORING = "SCORING"
    COOLDOWN_REVIEW = "COOLDOWN_REVIEW"


class SessionStatus(StrEnum):
    DRAFT = "DRAFT"
    IN_PROGRESS = "IN_PROGRESS"
    PENDING_CONFIRMATION = "PENDING_CONFIRMATION"
    CONFIRMED = "CONFIRMED"
    DISCARDED = "DISCARDED"


class EndStatus(StrEnum):
    DRAFT = "DRAFT"
    CONFIRMED = "CONFIRMED"


class ArrowSource(StrEnum):
    MANUAL_NUMBER = "MANUAL_NUMBER"
    MANUAL_TARGET = "MANUAL_TARGET"
    VISION_CONFIRMED = "VISION_CONFIRMED"


class TargetDefinition(Base):
    __tablename__ = "target_definitions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    scoring_mode: Mapped[str] = mapped_column(String(20), nullable=False)
    face_count: Mapped[int] = mapped_column(Integer, nullable=False)
    allowed_score_codes: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    ring_rules: Mapped[list[dict] | None] = mapped_column(JSON)
    diameter_cm: Mapped[float | None]
    is_built_in: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class TrainingPlan(Base):
    __tablename__ = "training_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # Supabase Auth 的 subject；不保存密码或个人资料。
    owner_id: Mapped[str] = mapped_column(String(36), nullable=False, default="local-dev", index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    bow_type: Mapped[str] = mapped_column(String(20), nullable=False)
    distance_m: Mapped[float] = mapped_column(nullable=False)
    target_definition_id: Mapped[str] = mapped_column(ForeignKey("target_definitions.id"), nullable=False)
    default_arrows_per_end: Mapped[int] = mapped_column(Integer, nullable=False)
    default_end_count: Mapped[int] = mapped_column(Integer, nullable=False)
    equipment_note: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(12), nullable=False, default=PlanStatus.ACTIVE)
    source_plan_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    blocks: Mapped[list["PlanBlock"]] = relationship(back_populates="training_plan")
    __table_args__ = (CheckConstraint("distance_m > 0"), CheckConstraint("default_arrows_per_end BETWEEN 1 AND 12"), CheckConstraint("default_end_count BETWEEN 1 AND 200"))


class PlanBlock(Base):
    __tablename__ = "plan_blocks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    training_plan_id: Mapped[str] = mapped_column(ForeignKey("training_plans.id"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    block_type: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(80), nullable=False)
    instructions: Mapped[str | None] = mapped_column(Text)
    end_count: Mapped[int | None] = mapped_column(Integer)
    arrows_per_end: Mapped[int | None] = mapped_column(Integer)
    duration_minutes: Mapped[int | None] = mapped_column(Integer)
    is_scored: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    training_plan: Mapped[TrainingPlan] = relationship(back_populates="blocks")
    __table_args__ = (UniqueConstraint("training_plan_id", "position"), CheckConstraint("position >= 1"))


class TrainingSession(Base):
    __tablename__ = "training_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(36), nullable=False, default="local-dev", index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    training_plan_id: Mapped[str | None] = mapped_column(ForeignKey("training_plans.id"))
    plan_snapshot: Mapped[dict | None] = mapped_column(JSON)
    target_definition_id: Mapped[str] = mapped_column(ForeignKey("target_definitions.id"), nullable=False)
    target_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    bow_type: Mapped[str] = mapped_column(String(20), nullable=False)
    distance_m: Mapped[float] = mapped_column(nullable=False)
    planned_end_count: Mapped[int] = mapped_column(Integer, nullable=False)
    arrows_per_end: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default=SessionStatus.DRAFT)
    completion_mode: Mapped[str | None] = mapped_column(String(12))
    equipment_note: Mapped[str | None] = mapped_column(String(500))
    note: Mapped[str | None] = mapped_column(String(2000))
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    ends: Mapped[list["End"]] = relationship(back_populates="training_session")


class End(Base):
    __tablename__ = "ends"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    training_session_id: Mapped[str] = mapped_column(ForeignKey("training_sessions.id"), nullable=False)
    plan_block_id: Mapped[str | None] = mapped_column(ForeignKey("plan_blocks.id"))
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    expected_arrow_count: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default=EndStatus.DRAFT)
    note: Mapped[str | None] = mapped_column(String(1000))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    training_session: Mapped[TrainingSession] = relationship(back_populates="ends")
    arrows: Mapped[list["Arrow"]] = relationship(back_populates="end")
    __table_args__ = (UniqueConstraint("training_session_id", "sequence"), CheckConstraint("sequence >= 1"), CheckConstraint("expected_arrow_count BETWEEN 1 AND 12"))


class Arrow(Base):
    __tablename__ = "arrows"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    end_id: Mapped[str] = mapped_column(ForeignKey("ends.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    score_code: Mapped[str] = mapped_column(String(2), nullable=False)
    x_norm: Mapped[float | None]
    y_norm: Mapped[float | None]
    plot_x_norm: Mapped[float | None]
    plot_y_norm: Mapped[float | None]
    target_face_index: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    end: Mapped[End] = relationship(back_populates="arrows")
    __table_args__ = (
        UniqueConstraint("end_id", "sequence"),
        CheckConstraint("sequence >= 1"),
        CheckConstraint("score_code IN ('X','10','9','8','7','6','5','4','3','2','1','M')"),
        CheckConstraint("(x_norm IS NULL AND y_norm IS NULL) OR (x_norm BETWEEN 0 AND 1 AND y_norm BETWEEN 0 AND 1)"),
        CheckConstraint("(plot_x_norm IS NULL AND plot_y_norm IS NULL) OR (plot_x_norm BETWEEN 0 AND 1 AND plot_y_norm BETWEEN 0 AND 1)"),
        CheckConstraint("(source = 'MANUAL_NUMBER' AND x_norm IS NULL AND y_norm IS NULL AND plot_x_norm IS NULL AND plot_y_norm IS NULL) OR (source = 'MANUAL_TARGET' AND plot_x_norm IS NOT NULL AND plot_y_norm IS NOT NULL) OR source = 'VISION_CONFIRMED'"),
    )

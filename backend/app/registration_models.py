"""Private registration receipts; imports never perform DDL."""
from sqlalchemy import Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.rewards_models import RewardsBase


class RegistrationIntent(RewardsBase):
    __tablename__ = 'reward_registration_intents'
    __table_args__ = (UniqueConstraint('service', 'capability_digest'),)
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False)
    capability_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    phone_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    invitation_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)
    registration_id: Mapped[str | None] = mapped_column(String(36))


class RegistrationReceipt(RewardsBase):
    __tablename__ = 'reward_registration_receipts'
    __table_args__ = (UniqueConstraint('service', 'user_id'), UniqueConstraint('service', 'hook_event_digest'))
    registration_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    phone_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    hook_event_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    invitation_digest: Mapped[str] = mapped_column(String(64), nullable=False, default='')
    intent_id: Mapped[str | None] = mapped_column(String(36))
    state: Mapped[str] = mapped_column(String(32), nullable=False, default='pending')
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    completed_at: Mapped[int | None] = mapped_column(Integer)


class RegistrationPair(RewardsBase):
    __tablename__ = 'reward_registration_pairs'
    __table_args__ = (UniqueConstraint('service', 'invitee_id'),)
    registration_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False)
    inviter_id: Mapped[str] = mapped_column(String(36), nullable=False)
    invitee_id: Mapped[str] = mapped_column(String(36), nullable=False)
    inviter_source_id: Mapped[str] = mapped_column(String(36), nullable=False)
    invitee_source_id: Mapped[str] = mapped_column(String(36), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

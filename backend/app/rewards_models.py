"""Independent reward tables. Import has no database connection or DDL side effect."""
from datetime import datetime
from sqlalchemy import Boolean, DateTime, Integer, JSON, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class RewardsBase(DeclarativeBase):
    pass


class AccountInvitationCode(RewardsBase):
    """Original invitation-store shape, retained for stable existing codes."""
    __tablename__ = 'account_invitation_codes'
    owner: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    code_digest: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AccountInvitationAttribution(RewardsBase):
    __tablename__ = 'account_invitation_attributions'
    invitee: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    inviter: Mapped[str] = mapped_column(Uuid(as_uuid=False), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class RewardIdentity(RewardsBase):
    __tablename__ = 'reward_identities'
    __table_args__ = (UniqueConstraint('service', 'invite_code', name='uq_reward_identity_code'),)
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    invite_code: Mapped[str] = mapped_column(String(32), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class RewardSource(RewardsBase):
    __tablename__ = 'reward_sources'
    __table_args__ = (UniqueConstraint('service', 'kind', 'source_key', name='uq_reward_source_fact'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    reward: Mapped[str] = mapped_column(String(16), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[str] = mapped_column(String(35), nullable=False)
    revoked_at: Mapped[str | None] = mapped_column(String(35), nullable=True)
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class RewardClaim(RewardsBase):
    __tablename__ = 'reward_claims'
    __table_args__ = (UniqueConstraint('service', 'token_digest', name='uq_reward_claim_digest'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    issuer_id: Mapped[str] = mapped_column(String(36), nullable=False)
    token_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[str] = mapped_column(String(35), nullable=False)
    expires_at: Mapped[str] = mapped_column(String(35), nullable=False)
    redeemed_at: Mapped[str | None] = mapped_column(String(35), nullable=True)
    revoked_at: Mapped[str | None] = mapped_column(String(35), nullable=True)
    source_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)


class RewardRequest(RewardsBase):
    __tablename__ = 'reward_requests'
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation: Mapped[str] = mapped_column(String(24), nullable=False)
    body_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(String(35), nullable=False)


class RewardAttempt(RewardsBase):
    __tablename__ = 'reward_claim_attempts'
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    window_started: Mapped[str] = mapped_column(String(35), nullable=False)
    failures: Mapped[int] = mapped_column(Integer, nullable=False)


class RewardContact(RewardsBase):
    __tablename__ = 'reward_contacts'
    service: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    qq_cipher: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(35), nullable=False)


class RewardAudit(RewardsBase):
    __tablename__ = 'reward_audit'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    service: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(36), nullable=False)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(36), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    at: Mapped[str] = mapped_column(String(35), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default='')

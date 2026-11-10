"""Independent team tables. Importing this module never creates or migrates tables."""
from sqlalchemy import Boolean, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class TeamBase(DeclarativeBase):
    pass


class WorkspaceOwner(TeamBase):
    __tablename__ = "team_workspace_owner"
    slot: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)


class CoachApplication(TeamBase):
    __tablename__ = "team_coach_applications"
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    organisation: Mapped[str] = mapped_column(String(120), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    updated_at: Mapped[str] = mapped_column(String(35), nullable=False)


class Team(TeamBase):
    __tablename__ = "team_workspaces"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    coach_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)


class TeamMember(TeamBase):
    __tablename__ = "team_workspace_members"
    __table_args__ = (UniqueConstraint("team_id", "user_id", name="uq_team_member_uid"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    team_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    category: Mapped[str] = mapped_column(String(12), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)


class TeamInvitation(TeamBase):
    __tablename__ = "team_workspace_invitations"
    __table_args__ = (UniqueConstraint("team_id", "request_id", name="uq_team_invite_request"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    team_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    member_id: Mapped[str] = mapped_column(String(36), nullable=False)
    request_id: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[str] = mapped_column(String(35), nullable=False)
    accepted_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class TeamGrant(TeamBase):
    __tablename__ = "team_workspace_grants"
    team_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    recipient_id: Mapped[str] = mapped_column(String(36), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    session_ids: Mapped[list] = mapped_column(JSON, nullable=False)
    include_future: Mapped[bool] = mapped_column(Boolean, nullable=False)
    future_from: Mapped[str | None] = mapped_column(String(10), nullable=True)
    expires_on: Mapped[str | None] = mapped_column(String(10), nullable=True)


class TeamSession(TeamBase):
    __tablename__ = "team_workspace_sessions"
    team_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    source_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    source: Mapped[dict] = mapped_column(JSON, nullable=False)
    projection: Mapped[dict] = mapped_column(JSON, nullable=False)


class TeamGroup(TeamBase):
    __tablename__ = "team_workspace_groups"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    team_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False)


class TeamNote(TeamBase):
    __tablename__ = "team_workspace_notes"
    team_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    member_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    coach_id: Mapped[str] = mapped_column(String(36), nullable=False)
    value: Mapped[dict] = mapped_column(JSON, nullable=False)


class TeamAudit(TeamBase):
    __tablename__ = "team_workspace_audits"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(36), nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(100), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    at: Mapped[str] = mapped_column(String(35), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="")

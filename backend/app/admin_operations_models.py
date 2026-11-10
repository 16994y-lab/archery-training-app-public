"""Private management records; import never creates tables or publishes content."""
from sqlalchemy import Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class OperationsBase(DeclarativeBase):
    pass


class Record:
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[str] = mapped_column(String(35), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(35), nullable=False)


class ProductFeedback(Record, OperationsBase):
    __tablename__ = "product_feedback"
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    app_version: Mapped[str] = mapped_column(String(40), nullable=False)
    page: Mapped[str] = mapped_column(String(30), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    internal_note: Mapped[str] = mapped_column(Text, nullable=False)


class DonationSubmission(Record, OperationsBase):
    __tablename__ = "product_donation_submissions"
    __table_args__ = (UniqueConstraint("user_id", "evidence_digest", name="uq_donation_submission_evidence"),
                      UniqueConstraint("source_id", name="uq_donation_submission_source"))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    amount: Mapped[str] = mapped_column(String(24), nullable=False)
    reference: Mapped[str] = mapped_column(String(120), nullable=False)
    evidence_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    source_id: Mapped[str | None] = mapped_column(String(36))


class OperationsIncident(Record, OperationsBase):
    __tablename__ = "product_operations_incidents"
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    original_request_id: Mapped[str | None] = mapped_column(String(36))
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    internal_note: Mapped[str] = mapped_column(Text, nullable=False)


class ProductAnnouncement(Record, OperationsBase):
    __tablename__ = "product_announcements"
    state: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    draft: Mapped[dict] = mapped_column(JSON, nullable=False)
    published: Mapped[dict | None] = mapped_column(JSON)
    publication_revision: Mapped[int] = mapped_column(Integer, nullable=False)


class OperationsRequest(OperationsBase):
    __tablename__ = "product_operations_requests"
    actor_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation: Mapped[str] = mapped_column(String(60), nullable=False)
    body_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict] = mapped_column(JSON, nullable=False)
    at: Mapped[str] = mapped_column(String(35), nullable=False)


class OperationsAudit(OperationsBase):
    __tablename__ = "product_operations_audits"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    subject_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    result: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    at: Mapped[str] = mapped_column(String(35), nullable=False, index=True)


class BusinessMetricStream(OperationsBase):
    __tablename__ = "product_metric_streams"
    key: Mapped[str] = mapped_column(String(20), primary_key=True)
    started_at: Mapped[str] = mapped_column(String(35), nullable=False)
    refreshed_at: Mapped[str] = mapped_column(String(35), nullable=False)
    state: Mapped[str] = mapped_column(String(20), nullable=False)


class BusinessMetricEvent(OperationsBase):
    __tablename__ = "product_metric_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    stream: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    outcome: Mapped[str] = mapped_column(String(10), nullable=False)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    at: Mapped[str] = mapped_column(String(35), nullable=False, index=True)

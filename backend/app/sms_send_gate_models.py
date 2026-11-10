"""Persistent, minimal SMS reservation ledger. It never stores phone numbers or OTPs."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class SmsSendReservation(Base):
    __tablename__ = "sms_send_reservations"
    __table_args__ = (
        Index("ix_sms_send_reservations_day", "utc_day"),
        Index("ix_sms_send_reservations_phone_time", "phone_digest", "reserved_at"),
    )

    webhook_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    phone_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    utc_day: Mapped[date] = mapped_column(Date(), nullable=False)
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # NULL is unclassified historical evidence, never an inferred success/failure.
    # The existing total/month reservation cost boundaries still include it.
    outcome: Mapped[str | None] = mapped_column(String(24), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

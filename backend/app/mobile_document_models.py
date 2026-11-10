"""Additive mobile archive model; deliberately independent of legacy ends/arrows."""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class MobileDocument(Base):
    __tablename__ = "mobile_documents"
    __table_args__ = (CheckConstraint("revision >= 1", name="ck_mobile_documents_revision"),)

    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

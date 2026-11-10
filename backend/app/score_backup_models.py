"""Owner-isolated, score-only backups; separate from the legacy full archive."""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ScoreBackup(Base):
    __tablename__ = "score_backups"
    __table_args__ = (CheckConstraint("revision >= 1", name="ck_score_backups_revision"),)

    owner_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

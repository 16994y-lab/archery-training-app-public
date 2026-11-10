import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


def database_url() -> str:
    return os.getenv("DATABASE_URL", "sqlite:///./archery.db")


def create_database_engine():
    url = database_url()
    if os.getenv("GONGXINGJI_SERVERLESS_DB") == "1":
        if not url.startswith("postgresql+psycopg://"):
            raise RuntimeError("Serverless community requires PostgreSQL")
        return create_engine(url, hide_parameters=True, pool_size=1, max_overflow=0, pool_pre_ping=True,
                             connect_args={"prepare_threshold": None})
    return create_engine(url, hide_parameters=True, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {})


SessionLocal = sessionmaker(bind=create_database_engine(), autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass

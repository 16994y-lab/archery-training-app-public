from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.db import Base, database_url
import app.models  # noqa: F401
import app.mobile_document_models  # noqa: F401
import app.score_backup_models  # noqa: F401
import app.sms_send_gate_models  # noqa: F401
import app.community_models  # noqa: F401
import app.private_media_models  # noqa: F401

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
# Alembic stores options through ConfigParser, where '%' is interpolation syntax.
# Database passwords must keep their URL-encoded percent escapes intact.
config.set_main_option("sqlalchemy.url", database_url().replace("%", "%%"))


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

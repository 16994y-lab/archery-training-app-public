"""Provision and check the dedicated database for the public training web app."""

import os
import re
import sys
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError


CORE_REVISION = "20260904_0003"
TRAINING_TABLES = ("training_plans", "plan_blocks", "training_sessions", "ends", "arrows")
READ_ONLY_TABLES = ("target_definitions", "alembic_version")
CORE_TABLES = TRAINING_TABLES + READ_ONLY_TABLES


def postgres_url(name):
    try:
        url = make_url(os.environ.get(name, ""))
    except (SQLAlchemyError, ValueError):
        raise RuntimeError(f"{name} must be a PostgreSQL connection URL") from None
    if url.drivername != "postgresql+psycopg" or not all((url.host, url.database, url.username, url.password)):
        raise RuntimeError(f"{name} requires postgresql+psycopg and a dedicated database login")
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", url.username):
        raise RuntimeError(f"{name} requires a lowercase PostgreSQL role name")
    if url.host not in {"localhost", "127.0.0.1", "::1"} and url.query.get("sslmode") != "verify-full":
        raise RuntimeError(f"{name} requires sslmode=verify-full for a remote database")
    # Disallow settings which could redirect the connection or override its role/schema.
    if set(url.query) - {"sslmode", "sslrootcert"}:
        raise RuntimeError(f"{name} contains unsupported connection options")
    return url


def database_engine(url):
    return create_engine(
        url, hide_parameters=True, pool_pre_ping=True,
        connect_args={"connect_timeout": 5, "options": "-csearch_path=public"},
    )


def check_runtime_role(connection, username):
    row = connection.execute(text("""
        SELECT r.rolname, r.rolcanlogin,
               r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
                 OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid)
                 OR r.oid = d.datdba AS elevated
        FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
        WHERE r.rolname = :username
    """), {"username": username}).one_or_none()
    if row is None or not row.rolcanlogin or row.elevated:
        raise RuntimeError("The database runtime login must be a non-owner role without elevated privileges or memberships")


def check_runtime_database(engine):
    with engine.connect() as connection:
        current = connection.scalar(text("SELECT current_user"))
        if current != engine.url.username:
            raise RuntimeError("The database session is not using its configured runtime role")
        check_runtime_role(connection, current)
        if connection.scalar(text("""
            SELECT has_schema_privilege('public', 'CREATE')
                OR has_database_privilege(current_database(), 'CREATE')
                OR EXISTS (
                    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relowner = current_user::regrole
                )
        """)):
            raise RuntimeError("The runtime login must not own or create public-schema objects")
        revisions = connection.scalars(text("SELECT version_num FROM public.alembic_version")).all()
        if revisions != [CORE_REVISION]:
            raise RuntimeError("The database needs the self-host core migration")
        from app.plans import BUILT_IN_TARGETS

        actual = set(connection.scalars(text("SELECT id FROM public.target_definitions")))
        if any(target["id"] not in actual for target in BUILT_IN_TARGETS):
            raise RuntimeError("The self-host database is missing built-in targets")
        for table in CORE_TABLES:
            grants = connection.execute(text("""
                SELECT has_table_privilege(:table, 'SELECT'),
                       has_table_privilege(:table, 'INSERT'),
                       has_table_privilege(:table, 'UPDATE'),
                       has_table_privilege(:table, 'DELETE'),
                       has_table_privilege(:table, 'TRUNCATE'),
                       has_table_privilege(:table, 'TRIGGER'),
                       has_table_privilege(:table, 'REFERENCES')
            """), {"table": f"public.{table}"}).one()
            writable = table in TRAINING_TABLES
            if tuple(grants) != (True, writable, writable, writable, False, False, False):
                raise RuntimeError("The self-host database has incorrect runtime table grants")


def migrate():
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.orm import Session

    runtime = postgres_url("DATABASE_URL")
    owner = postgres_url("MIGRATION_DATABASE_URL")
    if (
        (owner.host, owner.port or 5432, owner.database)
        != (runtime.host, runtime.port or 5432, runtime.database)
        or owner.username == runtime.username
    ):
        raise RuntimeError("Migration and runtime URLs must use separate logins for the same dedicated database")

    # Import only after checking the configured URL. Reuse the application's target seed.
    from app.plans import ensure_built_in_targets

    directory = Path(__file__).resolve().parents[1]
    configuration = Config(str(directory / "alembic.ini"))
    configuration.set_main_option("script_location", str(directory / "alembic"))
    engine = database_engine(owner)
    try:
        with engine.begin() as connection:
            connection.execute(text("SELECT pg_advisory_xact_lock(2269040003)"))
            is_owner = connection.scalar(text("""
                SELECT pg_get_userbyid(datdba) = current_user
                FROM pg_database WHERE datname = current_database()
            """))
            if not is_owner:
                raise RuntimeError("Migration requires the login that owns this dedicated database")
            check_runtime_role(connection, runtime.username)
            tables = set(connection.scalars(text("""
                SELECT tablename FROM pg_tables WHERE schemaname = 'public'
            """)))
            if tables and tables != set(CORE_TABLES):
                raise RuntimeError("Use a dedicated empty database or one already migrated by this self-host profile")
            if tables:
                revisions = connection.scalars(text("SELECT version_num FROM public.alembic_version")).all()
                if revisions != [CORE_REVISION]:
                    raise RuntimeError("The existing database does not match the self-host core revision")
            configuration.attributes["connection"] = connection
            command.upgrade(configuration, CORE_REVISION)
            # The original core schema used UUID-width columns. Its built-in target
            # identifiers are stable descriptive strings and can be longer.
            for table, column in (
                ("target_definitions", "id"),
                ("training_plans", "target_definition_id"),
                ("training_sessions", "target_definition_id"),
            ):
                width = connection.scalar(text("""
                    SELECT character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = :table AND column_name = :column
                """), {"table": table, "column": column})
                if width is not None and width < 64:
                    connection.execute(text(f"ALTER TABLE public.{table} ALTER COLUMN {column} TYPE VARCHAR(64)"))
            with Session(bind=connection, join_transaction_mode="rollback_only") as session:
                ensure_built_in_targets(session)

            quoted_role = connection.dialect.identifier_preparer.quote_identifier(runtime.username)
            qualified = ", ".join(f"public.{table}" for table in CORE_TABLES)
            writable = ", ".join(f"public.{table}" for table in TRAINING_TABLES)
            connection.execute(text("REVOKE CREATE ON SCHEMA public FROM PUBLIC"))
            connection.execute(text(f"REVOKE ALL ON SCHEMA public FROM {quoted_role}"))
            connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {quoted_role}"))
            connection.execute(text(f"REVOKE ALL ON TABLE {qualified} FROM PUBLIC, {quoted_role}"))
            connection.execute(text(f"GRANT SELECT ON TABLE {qualified} TO {quoted_role}"))
            connection.execute(text(f"GRANT INSERT, UPDATE, DELETE ON TABLE {writable} TO {quoted_role}"))
    finally:
        engine.dispose()
    engine = database_engine(runtime)
    try:
        check_runtime_database(engine)
    finally:
        engine.dispose()


if __name__ == "__main__":
    if sys.argv[1:] != ["migrate"]:
        sys.exit("Usage: python -m app.self_host_db migrate")
    try:
        migrate()
    except RuntimeError as error:
        sys.exit(str(error))
    except SQLAlchemyError:
        sys.exit("PostgreSQL migration or runtime verification failed. Check the database, roles and TLS configuration.")
    print(f"Self-host PostgreSQL migration and runtime grants verified at {CORE_REVISION}.")

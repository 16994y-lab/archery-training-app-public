"""Close direct client access to legacy training and migration metadata tables.

The API uses a trusted database owner and performs account isolation itself.
No public RLS policy is installed, including for built-in target definitions.
"""

from alembic import op


revision = "20261001_0006"
down_revision = "20260930_0005"
branch_labels = None
depends_on = None

TRAINING_TABLES = (
    "target_definitions",
    "training_plans",
    "plan_blocks",
    "training_sessions",
    "ends",
    "arrows",
)
PROTECTED_TABLES = TRAINING_TABLES + ("alembic_version",)


def upgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect not in {"sqlite", "postgresql"}:
        raise RuntimeError(f"Training permission migration has not been reviewed for {dialect}")
    if dialect == "sqlite":
        return

    for table in PROTECTED_TABLES:
        qualified = f'public."{table}"'
        op.execute(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY")
        op.execute(f"REVOKE ALL ON TABLE {qualified} FROM PUBLIC")
        for role in ("anon", "authenticated"):
            # Plain PostgreSQL installations may not define Supabase roles.
            op.execute("DO $$ BEGIN "
                       f"IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN "
                       f"EXECUTE 'REVOKE ALL ON TABLE {qualified} FROM {role}'; "
                       "END IF; END $$")


def downgrade() -> None:
    raise RuntimeError("Do not remove training table protection without a reviewed access plan")

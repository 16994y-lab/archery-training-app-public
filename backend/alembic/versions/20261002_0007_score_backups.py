"""Add a private score-only backup table without changing existing documents."""
from alembic import op
import sqlalchemy as sa

revision = "20261002_0007"
down_revision = "20261001_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "score_backups",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_score_backups_revision"),
    )
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE score_backups ENABLE ROW LEVEL SECURITY")
        op.execute("REVOKE ALL ON TABLE score_backups FROM PUBLIC")
        roles = set(op.get_bind().execute(sa.text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")).scalars())
        for role in ("anon", "authenticated"):
            if role in roles:
                op.execute(f"REVOKE ALL ON TABLE score_backups FROM {role}")


def downgrade() -> None:
    raise RuntimeError("Score backups must be exported before a reviewed destructive downgrade")

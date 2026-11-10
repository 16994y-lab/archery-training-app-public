"""Owner-isolated mobile archives. No existing training rows are transformed."""
from alembic import op
import sqlalchemy as sa

revision = "20260914_0004"
down_revision = "20260904_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mobile_documents",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_mobile_documents_revision"),
    )
    if op.get_bind().dialect.name == "postgresql":
        # The mobile app must go through the verified backend, never PostgREST.
        # No public policy is installed. The backend uses the trusted database
        # owner/service connection that owns this migration's table.
        op.execute("ALTER TABLE mobile_documents ENABLE ROW LEVEL SECURITY")
        op.execute("REVOKE ALL ON TABLE mobile_documents FROM PUBLIC")
        roles = set(op.get_bind().execute(sa.text("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")).scalars())
        for role in ("anon", "authenticated"):
            if role in roles:
                op.execute(f"REVOKE ALL ON TABLE mobile_documents FROM {role}")


def downgrade() -> None:
    # Operators must export these documents before choosing a destructive downgrade.
    op.drop_table("mobile_documents")

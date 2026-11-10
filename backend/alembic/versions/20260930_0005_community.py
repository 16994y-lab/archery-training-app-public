"""Add text-only community tables without changing training data.

PostgreSQL grants deliberately require the trusted API connection. No public
RLS policy is installed; the API performs per-request owner checks.
"""
from alembic import op
import sqlalchemy as sa

revision = "20260930_0005"
down_revision = "20260914_0004"
branch_labels = None
depends_on = None

COMMUNITY_TABLES = (
    "community_profiles", "community_posts", "community_comments",
    "community_reports", "community_moderators", "community_rate_windows",
)


def upgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect not in {"sqlite", "postgresql"}:
        raise RuntimeError(f"Community migration has not been reviewed for {dialect}")

    op.create_table("community_profiles",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column("nickname", sa.String(20), nullable=False),
        sa.Column("nickname_key", sa.String(80), nullable=False, unique=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False))
    op.create_table("community_posts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_community_post_revision"),
        sa.UniqueConstraint("owner_id", "idempotency_key", name="uq_community_post_idempotency"))
    op.create_index("ix_community_posts_owner_id", "community_posts", ["owner_id"])
    op.create_index("ix_community_posts_created_at", "community_posts", ["created_at"])
    op.create_table("community_comments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("community_posts.id"), nullable=False),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_community_comment_revision"),
        sa.UniqueConstraint("owner_id", "idempotency_key", name="uq_community_comment_idempotency"))
    op.create_index("ix_community_comments_post_id", "community_comments", ["post_id"])
    op.create_index("ix_community_comments_owner_id", "community_comments", ["owner_id"])
    op.create_index("ix_community_comments_created_at", "community_comments", ["created_at"])
    op.create_table("community_reports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("reporter_id", sa.String(128), nullable=False),
        sa.Column("target_kind", sa.String(12), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=False),
        sa.Column("reason", sa.String(24), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("decision", sa.String(12), nullable=True),
        sa.Column("moderator_id", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("reporter_id", "target_kind", "target_id", name="uq_community_report_target"))
    op.create_index("ix_community_reports_reporter_id", "community_reports", ["reporter_id"])
    op.create_index("ix_community_reports_created_at", "community_reports", ["created_at"])
    op.create_table("community_moderators",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column("active", sa.Boolean(), nullable=False))
    op.create_table("community_rate_windows",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column("kind", sa.String(12), primary_key=True),
        sa.Column("bucket", sa.Integer(), primary_key=True),
        sa.Column("uses", sa.Integer(), nullable=False),
        sa.CheckConstraint("uses >= 1", name="ck_community_rate_uses"))

    if dialect == "postgresql":
        for table in COMMUNITY_TABLES:
            op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
            op.execute(f"REVOKE ALL ON TABLE {table} FROM PUBLIC")
            for role in ("anon", "authenticated"):
                # The role may not exist in a plain PostgreSQL installation.
                op.execute("DO $$ BEGIN "
                           f"IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN "
                           f"EXECUTE 'REVOKE ALL ON TABLE {table} FROM {role}'; "
                           "END IF; END $$")


def downgrade() -> None:
    raise RuntimeError("Community downgrade would delete content; disable the feature and restore a reviewed backup instead")

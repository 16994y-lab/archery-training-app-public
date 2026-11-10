"""Backend-only private media and archive metadata; execution requires approval.

Local Alembic predecessor is 20261004_0010. Account 0012/0013 standalone
SQL candidates are not silently treated as revisions in this chain.
"""
from alembic import op
import sqlalchemy as sa

revision = "20261007_0014"
down_revision = "20261004_0010"
branch_labels = None
depends_on = None

_TABLES = (
    "private_media_owners",
    "private_media_objects",
    "private_media_consent_events",
    "private_media_access",
    "media_archive_records",
)


def upgrade() -> None:
    if op.get_context().dialect.name != "postgresql":
        raise RuntimeError("Private-media metadata candidate is PostgreSQL-only")

    op.create_table(
        "private_media_owners",
        sa.Column("owner_id", sa.String(128), primary_key=True),
        sa.Column("used_bytes", sa.BigInteger(), nullable=False),
        sa.Column("reserved_bytes", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("used_bytes >= 0 AND reserved_bytes >= 0", name="ck_private_media_quota_nonnegative"),
        schema="public",
    )
    op.create_table(
        "private_media_objects",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("client_object_id", sa.String(160), nullable=False),
        sa.Column("selection_id", sa.String(160), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("mime", sa.String(64), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("intent_digest", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("stored_at", sa.BigInteger(), nullable=True),
        sa.Column("save_consent", sa.JSON(), nullable=False),
        sa.Column("training_consent", sa.JSON(), nullable=False),
        sa.UniqueConstraint("owner_id", "idempotency_key", name="uq_private_media_idempotency"),
        sa.CheckConstraint("byte_size > 0 AND attempts >= 0", name="ck_private_media_object_size"),
        sa.CheckConstraint("status IN ('pending','stored','expired','repair-required')", name="ck_private_media_object_status"),
        schema="public",
    )
    op.create_index("ix_private_media_objects_owner_id", "private_media_objects", ["owner_id"], schema="public")
    op.create_table(
        "private_media_consent_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("object_id", sa.String(32), nullable=False),
        sa.Column("happened_at", sa.BigInteger(), nullable=False),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("consent", sa.JSON(), nullable=False),
        schema="public",
    )
    op.create_index("ix_private_media_consent_events_owner_id", "private_media_consent_events", ["owner_id"], schema="public")
    op.create_index("ix_private_media_consent_events_object_id", "private_media_consent_events", ["object_id"], schema="public")
    op.create_table(
        "private_media_access",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("object_id", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        schema="public",
    )
    op.create_index("ix_private_media_access_object_id", "private_media_access", ["object_id"], schema="public")
    op.create_table(
        "media_archive_records",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("selection_digest", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=False),
        sa.Column("archive_sha256", sa.String(64), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("restore_receipt", sa.JSON(), nullable=True),
        sa.Column("durable_copy_verified", sa.Boolean(), nullable=False),
        sa.Column("retention_policy_id", sa.String(160), nullable=True),
        sa.UniqueConstraint("owner_id", "idempotency_key", name="uq_media_archive_idempotency"),
        schema="public",
    )
    op.create_index("ix_media_archive_records_owner_id", "media_archive_records", ["owner_id"], schema="public")

    # No client policy, grant, researcher capability or Storage object mutation.
    # PUBLIC is the PostgreSQL pseudo-role; optional Supabase roles are guarded.
    for table in _TABLES:
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"REVOKE ALL ON TABLE public.{table} FROM PUBLIC")
        op.execute(f"""DO $private_media_revoke$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE public.{table} FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE public.{table} FROM authenticated;
    END IF;
END;
$private_media_revoke$""")


def downgrade() -> None:
    raise RuntimeError(
        "Private media/archives may contain user assets: destructive downgrade is refused. "
        "Keep all five metadata tables and bytes, keep backend services disabled/default 503, "
        "and revert only code that has not been enabled. Any data migration needs separate review."
    )
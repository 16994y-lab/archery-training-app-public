"""Add a private, durable SMS send reservation ledger; no provider sends."""

from alembic import op
import sqlalchemy as sa


revision = "20261002_0008"
down_revision = "20261002_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sms_send_reservations",
        sa.Column("webhook_id", sa.String(128), primary_key=True),
        sa.Column("phone_digest", sa.String(64), nullable=False),
        sa.Column("utc_day", sa.Date(), nullable=False),
        sa.Column("reserved_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_sms_send_reservations_day", "sms_send_reservations", ["utc_day"])
    op.create_index("ix_sms_send_reservations_phone_time", "sms_send_reservations",
                    ["phone_digest", "reserved_at"])
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE sms_send_reservations ENABLE ROW LEVEL SECURITY")
        op.execute("REVOKE ALL ON TABLE sms_send_reservations FROM PUBLIC")
        roles = set(op.get_bind().execute(sa.text(
            "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')"
        )).scalars())
        for role in ("anon", "authenticated"):
            if role in roles:
                op.execute(f"REVOKE ALL ON TABLE sms_send_reservations FROM {role}")


def downgrade() -> None:
    raise RuntimeError("SMS send reservations need an explicit export and reviewed downgrade")

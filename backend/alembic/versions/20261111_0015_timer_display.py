"""Ephemeral browser timer rooms, readable only through the server."""

from pathlib import Path

from alembic import op

revision = "20261111_0015"
down_revision = "20261007_0014"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_context().dialect.name != "postgresql":
        raise RuntimeError("Timer display pairing requires PostgreSQL")
    script = Path(__file__).resolve().parents[2] / "sql" / "20261114_timer_display_rooms.sql"
    ddl = script.read_text(encoding="utf-8").split("BEGIN;\n", maxsplit=1)[1].rsplit("COMMIT;", maxsplit=1)[0]
    op.execute(ddl)


def downgrade():
    op.drop_table("timer_display_rooms", schema="public")

"""add account ownership and optimistic-sync revisions

Revision ID: 20260903_0002
Revises: 20260903_0001
Create Date: 2026-09-03
"""
from alembic import op
import sqlalchemy as sa

revision = "20260903_0002"
down_revision = "20260903_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 已有的本机记录继续归属本机开发账户；生产环境不会暴露它们给云端用户。
    with op.batch_alter_table("training_plans") as batch:
        batch.add_column(sa.Column("owner_id", sa.String(36), nullable=False, server_default="local-dev"))
        batch.add_column(sa.Column("revision", sa.Integer, nullable=False, server_default="1"))
        batch.create_index("ix_training_plans_owner_id", ["owner_id"])
    with op.batch_alter_table("training_sessions") as batch:
        batch.add_column(sa.Column("owner_id", sa.String(36), nullable=False, server_default="local-dev"))
        batch.add_column(sa.Column("revision", sa.Integer, nullable=False, server_default="1"))
        batch.create_index("ix_training_sessions_owner_id", ["owner_id"])


def downgrade() -> None:
    with op.batch_alter_table("training_sessions") as batch:
        batch.drop_index("ix_training_sessions_owner_id")
        batch.drop_column("revision")
        batch.drop_column("owner_id")
    with op.batch_alter_table("training_plans") as batch:
        batch.drop_index("ix_training_plans_owner_id")
        batch.drop_column("revision")
        batch.drop_column("owner_id")

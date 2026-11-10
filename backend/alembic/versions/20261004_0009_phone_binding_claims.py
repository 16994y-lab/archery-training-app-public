"""Private ownership claims for same-account phone confirmation."""
from alembic import op
import sqlalchemy as sa
revision='20261004_0009'
down_revision='20261002_0008'
branch_labels=None
depends_on=None

def upgrade():
    op.create_table('phone_binding_claims',sa.Column('phone_digest',sa.String(64),primary_key=True),sa.Column('owner',sa.String(36),nullable=False),sa.Column('state',sa.String(16),nullable=False),sa.Column('updated_at',sa.DateTime(timezone=True),nullable=False),sa.CheckConstraint("state IN ('pending','verified')",name='ck_phone_binding_state'))
    if op.get_bind().dialect.name=='postgresql':
        op.execute("CREATE UNIQUE INDEX uq_phone_binding_pending_owner ON phone_binding_claims(owner) WHERE state='pending'")
        op.execute('ALTER TABLE phone_binding_claims ENABLE ROW LEVEL SECURITY')
        op.execute('REVOKE ALL ON TABLE phone_binding_claims FROM PUBLIC,anon,authenticated')

def downgrade():
    raise RuntimeError('Phone ownership claims require an explicit reviewed recovery; never drop to bypass account conflicts')

"""Private email ownership proofs, non-login challenges and send ledger."""
from alembic import op
import sqlalchemy as sa

revision='20261004_0010'
down_revision='20261004_0009'
branch_labels=None
depends_on=None


def upgrade():
    op.create_table('account_email_proofs',
        sa.Column('owner',sa.String(36),primary_key=True),
        sa.Column('email_digest',sa.String(64),nullable=False),
        sa.Column('verified_at',sa.DateTime(timezone=True),nullable=False),schema='public')
    op.create_table('account_email_challenges',
        sa.Column('owner',sa.String(36),primary_key=True),
        sa.Column('challenge_id',sa.String(36),nullable=False,unique=True),
        sa.Column('email_digest',sa.String(64),nullable=False),
        sa.Column('code_digest',sa.String(64),nullable=False),
        sa.Column('attempts',sa.Integer(),nullable=False),
        sa.Column('expires_at',sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint('attempts>=0 AND attempts<=5',name='ck_email_challenge_attempts'),schema='public')
    op.create_table('account_email_send_reservations',
        sa.Column('event_id',sa.String(100),primary_key=True),
        sa.Column('owner',sa.String(36),nullable=False),
        sa.Column('email_digest',sa.String(64),nullable=False),
        sa.Column('purpose',sa.String(16),nullable=False),
        sa.Column('reserved_at',sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint("purpose IN ('verification','recovery')",name='ck_email_send_purpose'),schema='public')
    op.create_index('ix_email_send_owner_time','account_email_send_reservations',['owner','reserved_at'],schema='public')
    if op.get_bind().dialect.name=='postgresql':
        for name in ('account_email_proofs','account_email_challenges','account_email_send_reservations'):
            op.execute(f'ALTER TABLE public.{name} ENABLE ROW LEVEL SECURITY')
            op.execute(f'REVOKE ALL ON TABLE public.{name} FROM PUBLIC,anon,authenticated')
        # A -> B -> A must also require fresh proof. Native email_confirmed_at
        # may be automatic; user metadata and a string comparison are inadequate.
        op.execute('''CREATE FUNCTION public.invalidate_account_email_proof() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
            BEGIN
                IF OLD.email IS DISTINCT FROM NEW.email THEN
                    PERFORM pg_catalog.pg_advisory_xact_lock(621662560617157763);
                    DELETE FROM public.account_email_proofs WHERE owner=NEW.id::text;
                    UPDATE public.account_email_challenges SET code_digest='' WHERE owner=NEW.id::text;
                END IF;
                RETURN NEW;
            END $$''')
        op.execute('REVOKE ALL ON FUNCTION public.invalidate_account_email_proof() FROM PUBLIC,anon,authenticated')
        op.execute('CREATE TRIGGER invalidate_account_email_proof AFTER UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION public.invalidate_account_email_proof()')


def downgrade():
    raise RuntimeError('Email ownership proof and send limits require reviewed recovery; never drop to reopen credential access')

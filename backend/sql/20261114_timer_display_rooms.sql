-- Timer-only provisioning. Execute as the role that owns the timer table,
-- unless a separate migration role and a scoped runtime grant were reviewed.
-- This script does not touch Alembic's version table.
BEGIN;

CREATE TABLE IF NOT EXISTS public.timer_display_rooms (
    display_hash varchar(64) PRIMARY KEY,
    pair_hash varchar(64) UNIQUE,
    control_hash varchar(64) UNIQUE,
    expires_at bigint NOT NULL,
    max_expires_at bigint NOT NULL,
    closed boolean NOT NULL,
    seq bigint NOT NULL,
    frame_at bigint,
    last_view_at bigint,
    frame json,
    CONSTRAINT ck_timer_display_expiry CHECK (expires_at <= max_expires_at),
    CONSTRAINT ck_timer_display_seq CHECK (seq >= 0 AND seq <= 1000000)
);

CREATE INDEX IF NOT EXISTS ix_timer_display_rooms_expires_at
    ON public.timer_display_rooms (expires_at);
ALTER TABLE public.timer_display_rooms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.timer_display_rooms FROM PUBLIC;

DO $$
DECLARE role_name text;
BEGIN
    FOR role_name IN SELECT rolname FROM pg_roles
                     WHERE rolname IN ('anon', 'authenticated', 'service_role')
    LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.timer_display_rooms FROM %I', role_name);
    END LOOP;
END
$$;

COMMIT;

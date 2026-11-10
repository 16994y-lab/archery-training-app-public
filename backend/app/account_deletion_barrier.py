"""Source-pinned catalog gate for the original project's deletion barriers.

All statements are parameter-free and must run on the caller's existing private
transaction. Complete absence supports a staged install; mutation requires the
whole reviewed catalog. A matching trigger name alone grants no exemption.
"""
from fastapi import HTTPException
from sqlalchemy import text

SERVICE = 'https://auth-4.example.invalid'
# Exact pg_proc.prosrc, including the installation's surrounding newlines.
SOURCE_SHA256 = 'c567cb26d28a8ee8f48823a92aafb194a53f86f1810dfb470db37595b3662677'
TRIGGER_COLUMNS = {
    'account_email_binding_intents': 'owner', 'account_email_challenges': 'owner',
    'account_email_enrollments': 'owner', 'account_email_proofs': 'owner',
    'account_email_send_reservations': 'owner', 'account_invitation_attributions': 'inviter,invitee',
    'account_invitation_codes': 'owner', 'arrows': '', 'community_comments': 'owner_id',
    'community_moderators': 'owner_id', 'community_posts': 'owner_id', 'community_profiles': 'owner_id',
    'community_rate_windows': 'owner_id', 'community_reports': 'reporter_id,moderator_id',
    'ends': '', 'media_archive_records': 'owner_id', 'mobile_documents': 'owner_id',
    'phone_binding_claims': 'owner', 'photo_contribution_choices': 'user_id',
    'photo_contribution_deletions': 'user_id', 'photo_contribution_receipts': 'user_id',
    'photo_contribution_samples': 'user_id', 'plan_blocks': '', 'private_media_access': 'owner_id',
    'private_media_consent_events': 'owner_id', 'private_media_objects': 'owner_id',
    'private_media_owners': 'owner_id', 'product_donation_submissions': 'user_id',
    'product_feedback': 'user_id', 'product_operations_audits': 'actor_id',
    'product_operations_incidents': 'user_id', 'product_operations_requests': 'actor_id',
    'reward_audit': 'actor_id', 'reward_claim_attempts': 'user_id',
    'reward_claims': 'user_id,issuer_id', 'reward_contacts': 'user_id',
    'reward_identities': 'user_id', 'reward_registration_intents': '',
    'reward_registration_pairs': 'inviter_id,invitee_id', 'reward_registration_receipts': 'user_id',
    'reward_requests': 'actor_id', 'reward_sources': 'user_id', 'score_backups': 'owner_id',
    'team_coach_applications': 'user_id', 'team_workspace_audits': 'actor_id',
    'team_workspace_grants': 'recipient_id', 'team_workspace_groups': '',
    'team_workspace_invitations': 'accepted_by', 'team_workspace_members': 'user_id',
    'team_workspace_notes': 'coach_id', 'team_workspace_owner': 'user_id',
    'team_workspace_sessions': '', 'team_workspaces': 'coach_id',
    'training_plans': 'owner_id', 'training_sessions': 'owner_id',
}
PROTECTED_PUBLIC_TABLES = tuple(sorted(set(TRIGGER_COLUMNS) | {
    'account_deletion_requests', 'account_deletion_objects', 'alembic_version',
    'target_definitions', 'product_announcements', 'product_metric_streams',
    'product_metric_events', 'sms_send_reservations', 'sms_retry_operations',
}))


def _catalog_sql(allow_absent):
    # Only immutable source constants are interpolated; no owner or credential.
    expected = ','.join("('%s','%s')" % (name, (SERVICE+'\0'+columns+'\0').encode().hex())
                        for name, columns in sorted(TRIGGER_COLUMNS.items()))
    protected = ','.join("'%s'" % name for name in PROTECTED_PUBLIC_TABLES)
    absent = 'true' if allow_absent else 'false'
    return """(WITH expected(name,args) AS (VALUES """+expected+"""),
      ns AS (SELECT * FROM pg_catalog.pg_namespace WHERE nspname='gxj_account_deletion'),
      fn AS (SELECT p.* FROM pg_catalog.pg_proc p JOIN ns ON ns.oid=p.pronamespace),
      rel AS (SELECT c.* FROM pg_catalog.pg_class c JOIN ns ON ns.oid=c.relnamespace),
      tab AS (SELECT * FROM rel WHERE relname='tx_authority'),
      relevant AS (
        SELECT t.*,c.relname,n.nspname,c.relkind,c.relispartition,c.relowner
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE (NOT t.tgisinternal AND n.nspname='public' AND c.relname IN ("""+protected+"""))
           OR n.nspname='gxj_account_deletion' OR t.tgname='gxj_account_deletion_guard'
           OR t.tgfoid IN (SELECT oid FROM fn))
      SELECT coalesce(
       ("""+absent+""" AND NOT EXISTS(SELECT 1 FROM ns) AND NOT EXISTS(SELECT 1 FROM relevant)) OR (
        current_user='postgres' AND session_user='postgres'
        AND (SELECT count(*) FROM ns)=1
        AND (SELECT pg_catalog.pg_get_userbyid(nspowner)='postgres'
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(nspacl,pg_catalog.acldefault('n',nspowner))) a
            WHERE a.grantee<>nspowner OR a.grantor<>nspowner OR a.is_grantable)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
            AND pg_catalog.has_schema_privilege(r.oid,ns.oid,'USAGE,CREATE')) FROM ns)
        AND (SELECT count(*) FROM fn)=1
        AND (SELECT proname='write_barrier' AND pg_catalog.pg_get_userbyid(proowner)='postgres'
          AND prokind='f' AND prosecdef AND NOT proleakproof AND NOT proisstrict AND NOT proretset
          AND provolatile='v' AND proparallel='u' AND prosupport=0
          AND prorettype='pg_catalog.trigger'::regtype AND pronargs=0 AND pronargdefaults=0
          AND proargtypes::text='' AND proallargtypes IS NULL AND proargmodes IS NULL AND proargnames IS NULL
          AND proargdefaults IS NULL AND probin IS NULL AND prosqlbody IS NULL
          AND proconfig=ARRAY['search_path=pg_catalog']
          AND (SELECT lanname='plpgsql' AND lanispl FROM pg_catalog.pg_language WHERE oid=prolang)
          AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc,'UTF8')),'hex')='"""+SOURCE_SHA256+"""'
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(proacl,pg_catalog.acldefault('f',proowner))) a
            WHERE a.grantee<>proowner OR a.grantor<>proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
            AND pg_catalog.has_function_privilege(r.oid,fn.oid,'EXECUTE')) FROM fn)
        AND (SELECT count(*) FROM rel)=2 AND (SELECT count(*) FROM tab)=1
        AND (SELECT relkind='r' AND relpersistence='p' AND NOT relispartition
          AND pg_catalog.pg_get_userbyid(relowner)='postgres' AND relrowsecurity AND NOT relforcerowsecurity
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=tab.oid OR i.inhparent=tab.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=tab.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=tab.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=tab.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(relacl,pg_catalog.acldefault('r',relowner))) a
            WHERE a.grantee<>relowner OR a.grantor<>relowner OR a.is_grantable)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
            WHERE c.attrelid=tab.oid AND c.attnum>0 AND NOT c.attisdropped
              AND (a.grantee<>relowner OR a.grantor<>relowner OR a.is_grantable))
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
            AND (pg_catalog.has_table_privilege(r.oid,tab.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR pg_catalog.has_any_column_privilege(r.oid,tab.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
          AND (SELECT jsonb_object_agg(attname,jsonb_build_array(pg_catalog.format_type(atttypid,atttypmod),attnotnull,atthasdef,attidentity,attgenerated))
            FROM pg_catalog.pg_attribute WHERE attrelid=tab.oid AND attnum>0 AND NOT attisdropped)
             ='{"transaction_id":["bigint",true,false,"",""],"backend_id":["integer",true,false,"",""],"owner":["uuid",true,false,"",""]}'::jsonb
          AND (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid=tab.oid)=1
          AND (SELECT count(*) FROM pg_catalog.pg_index WHERE indrelid=tab.oid)=1
          AND (SELECT k.contype='p' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
            AND k.conislocal AND k.coninhcount=0 AND k.conkey=ARRAY[1,2]::smallint[]
            AND i.indrelid=tab.oid AND i.indisprimary AND i.indisunique AND i.indimmediate
            AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indnullsnotdistinct
            AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts=2 AND i.indnkeyatts=2
            AND i.indkey::text='1 2' AND i.indcollation::text='0 0' AND i.indoption::text='0 0'
            AND ic.relkind='i' AND ic.relpersistence='p' AND NOT ic.relispartition AND ic.relowner=tab.relowner
            AND ic.relnamespace=tab.relnamespace AND am.amname='btree'
            AND (SELECT array_agg(op.opcname::text ORDER BY x.position)
              FROM unnest(i.indclass) WITH ORDINALITY x(oid,position)
              JOIN pg_catalog.pg_opclass op ON op.oid=x.oid JOIN pg_catalog.pg_namespace n ON n.oid=op.opcnamespace
              WHERE n.nspname='pg_catalog' AND op.opcdefault AND op.opcmethod=ic.relam)=ARRAY['int8_ops','int4_ops']
            FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_index i ON i.indexrelid=k.conindid
            JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
            WHERE k.conrelid=tab.oid) FROM tab)
        AND (SELECT count(*) FROM relevant)=55
        AND NOT EXISTS(SELECT 1 FROM relevant t LEFT JOIN expected e ON e.name=t.relname
          WHERE e.name IS NULL OR t.nspname<>'public' OR t.tgname<>'gxj_account_deletion_guard'
            OR t.tgfoid<>(SELECT oid FROM fn) OR t.tgtype<>31 OR t.tgenabled<>'O' OR t.tgisinternal
            OR t.tgnargs<>2 OR pg_catalog.encode(t.tgargs,'hex')<>e.args OR t.tgqual IS NOT NULL
            OR t.tgconstraint<>0 OR t.tgconstrrelid<>0 OR t.tgconstrindid<>0 OR t.tgdeferrable OR t.tginitdeferred
            OR t.tgparentid<>0 OR t.tgattr::text<>'' OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL
            OR t.relkind<>'r' OR t.relispartition OR pg_catalog.pg_get_userbyid(t.relowner)<>'postgres')
        AND NOT EXISTS(SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM relevant t WHERE t.relname=e.name))
       ),false))"""


# Boolean expressions may be embedded in the existing same-connection snapshot.
OPTIONAL_BARRIER_SQL = _catalog_sql(True)
REQUIRED_BARRIER_SQL = 'SELECT '+_catalog_sql(False)


def require_write_barrier(db):
    """Called only after the existing privacy/log gate, before private binds."""
    try:
        if db.get_bind().dialect.name != 'postgresql' or db.execute(text(REQUIRED_BARRIER_SQL)).scalar_one() is not True:
            raise HTTPException(503, '账号注销写入保护尚未完整接通')
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, '账号注销写入保护暂时无法核对') from None

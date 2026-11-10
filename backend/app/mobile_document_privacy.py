"""Existing archive, guarded on the same connection before any private binding.

No DDL, data migration, startup I/O, public Data API access, or automatic retry.
The fixed catalog query contains no account or document values and is also the
operator's read-only rollout check. A changed catalog fails closed.
"""
from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db import SessionLocal
from app.account_deletion_barrier import OPTIONAL_BARRIER_SQL


SCHEMA_SQL = """SELECT c.relkind::text AS kind,
 c.relrowsecurity AS rls, c.relforcerowsecurity AS forced_rls,
 pg_catalog.pg_get_userbyid(c.relowner)=current_user AS runtime_owns_table,
 pg_catalog.to_regclass('mobile_documents')=c.oid AS unqualified_resolves_public,
 (SELECT pg_catalog.jsonb_object_agg(a.attname, pg_catalog.jsonb_build_array(
    pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull))
  FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
   AND NOT a.attisdropped) AS columns,
 (SELECT pg_catalog.count(*)=2 FROM pg_catalog.pg_constraint k
  WHERE k.conrelid=c.oid) AS exact_constraints,
 (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_constraint k
  WHERE k.conrelid=c.oid AND k.contype='p' AND k.convalidated
   AND NOT k.condeferrable AND NOT k.condeferred AND k.conislocal AND k.coninhcount=0
   AND k.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=c.oid AND a.attname='owner_id')]::smallint[]
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=k.conindid
    AND i.indisvalid AND i.indisready)) AS owner_primary_key,
 (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_constraint k
  WHERE k.conrelid=c.oid AND k.contype='c' AND k.convalidated
   AND NOT k.condeferrable AND NOT k.condeferred AND k.conislocal AND k.coninhcount=0
   AND pg_catalog.pg_get_expr(k.conbin,k.conrelid)='(revision >= 1)') AS revision_check,
 (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(
   i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready
   AND i.indislive AND i.indimmediate AND NOT i.indisexclusion
   AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND i.indpred IS NULL
   AND i.indkey::text=(SELECT a.attnum::text FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=c.oid AND a.attname='owner_id')
   AND am.amname='btree' AND op.opcname='text_ops' AND ns.nspname='pg_catalog')
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid=ic.relam
  JOIN pg_catalog.pg_opclass op ON op.oid=i.indclass[0]
  JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace
  WHERE i.indrelid=c.oid) AS exact_primary_index,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r
  WHERE r.ev_class=c.oid) AS no_rules,
 NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h
  WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) AS no_inheritance,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   AND (a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS no_column_expressions,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p
  WHERE p.polrelid=c.oid) AS no_policies,
 """ + OPTIONAL_BARRIER_SQL + """ AS no_user_triggers,
 NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,
  pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a,
   LATERAL pg_catalog.aclexplode(a.attacl) acl
   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    AND acl.grantee=0) AS no_public_acl,
 (SELECT pg_catalog.count(*)=2 FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('anon','authenticated')) AS public_roles_exist,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('anon','authenticated')
   AND (pg_catalog.has_table_privilege(r.oid,c.oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(r.oid,c.oid,
    'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_public_access
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='mobile_documents'"""

EXPECTED_COLUMNS = {
    'owner_id': ['character varying(128)', True],
    'revision': ['integer', True],
    'document': ['json', True],
    'updated_at': ['timestamp with time zone', True],
}


def require_document_schema(db):
    rows = db.execute(text(SCHEMA_SQL)).mappings().all()
    if len(rows) != 1:
        raise HTTPException(503, '云记录数据保护尚未就绪')
    row = rows[0]
    if (row['kind'] != 'r' or row['rls'] is not True or row['forced_rls'] is not False
            or row['columns'] != EXPECTED_COLUMNS
            or any(row[name] is not True for name in (
                'runtime_owns_table', 'unqualified_resolves_public',
                'exact_constraints', 'owner_primary_key', 'revision_check',
                'exact_primary_index', 'no_rules', 'no_inheritance',
                'no_column_expressions', 'no_policies',
                'no_user_triggers', 'no_public_acl', 'public_roles_exist', 'no_public_access'))):
        raise HTTPException(503, '云记录数据保护尚未就绪')


def require_document_session(db, actor):
    from app.team_workspace import _TeamActor, _session_active
    if not isinstance(actor, _TeamActor) or not _session_active(db, str(actor), actor.session_id):
        raise HTTPException(401, '登录会话已失效，请重新登录')


@contextmanager
def document_transaction(db, actor):
    """Parse/size-check first, then guard, authorize, CAS, recheck and commit.

    SQLite is only the existing isolated local test adapter. Production's
    configured SessionLocal is PostgreSQL, and the PostgreSQL path never accepts
    a synthetic string principal. A failed/unknown commit is never retried here.
    """
    try:
        with db.begin():
            dialect = db.get_bind().dialect.name
            if dialect == 'postgresql':
                from app.team_workspace import _require_private_transaction
                _require_private_transaction(db, factory=SessionLocal)
                require_document_schema(db)
                require_document_session(db, actor)
            elif dialect != 'sqlite':
                raise HTTPException(503, '云记录存储尚未就绪')
            yield db
            if dialect == 'postgresql':
                require_document_session(db, actor)
    except SQLAlchemyError:
        # No SQL, account, document, driver MESSAGE/DETAIL/HINT/CONTEXT, or retry.
        raise HTTPException(503, '云记录操作结果尚未确认；请保留本机资料并重新读取核对') from None

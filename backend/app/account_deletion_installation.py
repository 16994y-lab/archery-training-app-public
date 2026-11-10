"""Offline DDL generation and same-transaction receipt protection checks."""
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable
from app.account_deletion_models import DeletionBase

TABLES = ('account_deletion_objects', 'account_deletion_requests')
KEYS = {
    'account_deletion_objects': [('p', ['request_id', 'key'])],
    'account_deletion_requests': [('p', ['request_id']), ('u', ['barrier_digest']), ('u', ['owner_digest'])],
}


def _keys_match(name, row):
    """A named/invalid/partial index is not an immediate uniqueness guarantee."""
    constraints = row.get('constraints')
    if not isinstance(constraints, list) or len(constraints) != len(KEYS[name]):
        return False
    if row.get('index_count') != len(KEYS[name]):
        return False
    return all(isinstance(c, dict) and set(c) == {'kind', 'columns', 'safe'}
               and c['safe'] is True for c in constraints) and sorted(
        [(c['kind'], c['columns']) for c in constraints], key=lambda item: (item[0], item[1])
    ) == KEYS[name]


def installation_sql():
    lines = ['BEGIN;']
    for name in TABLES:
        lines.extend([str(CreateTable(DeletionBase.metadata.tables[name]).compile(dialect=postgresql.dialect())).strip() + ';',
                      f'ALTER TABLE public.{name} ENABLE ROW LEVEL SECURITY;',
                      f'REVOKE ALL ON TABLE public.{name} FROM PUBLIC, anon, authenticated, service_role;'])
    return '\n'.join(lines + ['COMMIT;'])


def require_deletion_schema(db):
    """Must follow the project's private-log guard, before binding private values."""
    for name in TABLES:
        # Relation names come only from the fixed tuple, never from a request.
        row = db.execute(text("""SELECT c.relrowsecurity AS rls,
          pg_catalog.pg_get_userbyid(c.relowner)=current_user AS own,
          c.relkind='r' AND NOT c.relispartition AS regular,
          NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid) AS no_policies,
          NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS no_triggers,
          NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS no_inheritance,
          NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
            AND NOT a.attisdropped AND (a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS no_defaults,
          NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS no_public,
          NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
            AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_access,
          (SELECT count(*) FROM pg_index i WHERE i.indrelid=c.oid) AS index_count,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',k.contype,'columns',
            (SELECT jsonb_agg(a.attname ORDER BY x.position) FROM unnest(k.conkey) WITH ORDINALITY x(num,position)
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num), 'safe',
            k.contype IN ('p','u') AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
            AND k.conislocal AND k.coninhcount=0 AND i.indrelid=c.oid
            AND i.indisunique AND i.indimmediate AND i.indisvalid AND i.indisready AND i.indislive
            AND i.indisprimary=(k.contype='p') AND NOT i.indnullsnotdistinct
            AND i.indpred IS NULL AND i.indexprs IS NULL
            AND i.indnatts=i.indnkeyatts AND i.indnkeyatts=cardinality(k.conkey)
            AND (SELECT array_agg(v ORDER BY p) FROM unnest(i.indkey) WITH ORDINALITY z(v,p))=k.conkey
            AND ic.relkind='i' AND NOT ic.relispartition AND ic.relowner=c.relowner
            AND am.amname='btree'
            AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass) oc
              LEFT JOIN pg_opclass op ON op.oid=oc LEFT JOIN pg_namespace ns ON ns.oid=op.opcnamespace
              WHERE op.oid IS NULL OR ns.nspname<>'pg_catalog' OR op.opcname<>'text_ops'
                 OR NOT op.opcdefault OR op.opcmethod<>ic.relam)
            AND NOT EXISTS (SELECT 1 FROM unnest(i.indcollation) WITH ORDINALITY co(oid,position)
              JOIN unnest(k.conkey) WITH ORDINALITY ck(num,position) USING(position)
              JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ck.num
              WHERE co.oid<>a.attcollation)
            AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption) opt WHERE opt<>0)
          )), '[]'::jsonb) FROM pg_constraint k LEFT JOIN pg_index i ON i.indexrelid=k.conindid
          LEFT JOIN pg_class ic ON ic.oid=i.indexrelid LEFT JOIN pg_am am ON am.oid=ic.relam
          WHERE k.conrelid=c.oid) AS constraints,
          (SELECT jsonb_object_agg(a.attname,jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull))
           FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='""" + name + "'")).mappings().one_or_none()
        expected = {c.name: [str(c.type.compile(dialect=postgresql.dialect())).lower().replace('varchar', 'character varying'), not c.nullable]
                    for c in DeletionBase.metadata.tables[name].columns}
        if (not row or row['columns'] != expected or not _keys_match(name, row)
            or any(row[k] is not True for k in ('rls','own','regular','no_policies','no_triggers','no_inheritance','no_defaults','no_public','no_access'))):
            raise HTTPException(503, '账号注销的数据保护尚未就绪')

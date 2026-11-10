"""Four additive tables only; no startup DDL, marker/owner binding or auth changes."""
from collections import defaultdict
import hashlib,json
from sqlalchemy import MetaData, UniqueConstraint, text
from sqlalchemy.schema import CreateTable, CreateIndex
from app.photo_contribution_models import ContributionBase
from app import team_workspace_installation as original
from app.account_deletion_barrier import OPTIONAL_BARRIER_SQL

TABLES = tuple(sorted(ContributionBase.metadata.tables))
EXPECTED_TABLES = ('photo_contribution_choices', 'photo_contribution_deletions',
                   'photo_contribution_receipts', 'photo_contribution_samples')


def closed():
    from fastapi import HTTPException
    raise HTTPException(503, '贡献数据权限尚未就绪', headers={'Cache-Control':'no-store'}) from None


def generate_installation_sql(runtime_role='postgres', *, verified_runtime_roles=()):
    """Draft, never execution. Existing relations cause rollback, not modification."""
    role = original._role(runtime_role, verified_runtime_roles)
    if TABLES != EXPECTED_TABLES:
        closed()
    metadata = MetaData(schema='public')
    for table in ContributionBase.metadata.sorted_tables:
        original._copy_table_preserving_index_names(table, metadata)
    parts = ['-- REVIEW DRAFT ONLY: four NEW contribution tables; no original tables, markers or owner rows.',
             '-- Execute once on the reviewed existing PostgreSQL connection; rollback on any existing relation.',
             'BEGIN;', "SET LOCAL statement_timeout='8s';", "SET LOCAL lock_timeout='3s';",
             "SET LOCAL transaction_timeout='10000ms';",
             f'SELECT pg_catalog.pg_advisory_xact_lock({original._LOCK});',
             f"DO $role$ BEGIN IF current_user <> '{role}' THEN RAISE EXCEPTION 'contribution-runtime-role-mismatch'; END IF; END $role$;"]
    for table in metadata.sorted_tables:
        name = 'public."'+table.name+'"'
        parts.append(str(CreateTable(table).compile(dialect=original._DIALECT)).strip()+';')
        for index in sorted(table.indexes, key=lambda item:item.name):
            parts.append(str(CreateIndex(index).compile(dialect=original._DIALECT)).strip()+';')
        parts.extend([f'ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;',
            f'REVOKE ALL ON TABLE {name} FROM PUBLIC, anon, authenticated, service_role;',
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {name} TO "{role}";'])
    return '\n\n'.join(parts+['COMMIT;'])+'\n'


def expected_columns():
    return {name:{c.name:(str(c.type.compile(dialect=original._DIALECT)).lower().replace('varchar','character varying'), not c.nullable)
                  for c in ContributionBase.metadata.tables[name].columns} for name in TABLES}


def expected_constraints():
    result = {}
    for name in TABLES:
        table=ContributionBase.metadata.tables[name]
        result[name]={('p',tuple(c.name for c in table.primary_key.columns))}
        result[name].update(('u',tuple(c.name for c in constraint.columns)) for constraint in table.constraints if isinstance(constraint,UniqueConstraint))
    return result


_STORAGE = """SELECT
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',r.rolname,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'acl',c.relacl::text,
   'select',pg_catalog.has_table_privilege('service_role',c.oid,'SELECT'),
   'insert',pg_catalog.has_table_privilege('service_role',c.oid,'INSERT'),
   'update',pg_catalog.has_table_privilege('service_role',c.oid,'UPDATE'),
   'delete',pg_catalog.has_table_privilege('service_role',c.oid,'DELETE')) ORDER BY c.relname)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
   WHERE n.nspname='storage' AND c.relname IN ('objects','buckets')), '[]'::jsonb) AS relations,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.relname,'policy',p.polname,'cmd',p.polcmd,'roles',p.polroles::text,'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname)
   FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='storage' AND c.relname IN ('objects','buckets')), '[]'::jsonb) AS policies,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',r.rolname,'bypass',r.rolbypassrls,'super',r.rolsuper,'inherit',r.rolinherit) ORDER BY r.rolname)
   FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')), '[]'::jsonb) AS roles,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_catalog.pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text)
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE p.prokind='f' AND (n.nspname='storage' OR p.oid IN (
     SELECT d.refobjid FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_policy pol ON d.classid='pg_catalog.pg_policy'::regclass AND d.objid=pol.oid
     JOIN pg_catalog.pg_class c ON c.oid=pol.polrelid JOIN pg_catalog.pg_namespace s ON s.oid=c.relnamespace
     WHERE d.refclassid='pg_catalog.pg_proc'::regclass AND s.nspname='storage' AND c.relname IN ('objects','buckets')))), '[]'::jsonb) AS functions"""


def _queries():
    return {'identity':_IDENTITY,'relations':original._RELATIONS,'columns':original._COLUMNS,
        'constraints':original._CONSTRAINTS,'indexes':original._INDEXES,'access':original._TABLE_ACCESS,
        'extras':_EXTRAS,'functions':original._FUNCTION_CATALOG,'storage':_STORAGE}


class _Snapshot:
    def __init__(self,db,values):self.db,self.values=db,values
    def in_transaction(self):return self.db.in_transaction()
    def get_bind(self):return self.db.get_bind()
    def execute(self,statement,params):
        name=next((name for name,sql in _queries().items() if sql==str(statement)),None)
        if name is None:closed()
        class Rows:
            def mappings(inner):return inner
            def all(inner):return self.values[name]
            def one(inner):
                if len(self.values[name])!=1:closed()
                return self.values[name][0]
        return Rows()


def require_contribution_schema(db,runtime_role='postgres',*,verified_runtime_roles=()):
    """One current-connection SQL round trip, same full reject-only validation."""
    try:
        if not db.in_transaction() or db.get_bind().dialect.name!='postgresql':closed()
        queries=_queries()
        sql='WITH '+',\n'.join('q_'+name+' AS ('+query+')' for name,query in queries.items())
        sql+=' SELECT jsonb_build_object('+','.join("'"+name+"',(SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM q_"+name+' t)' for name in queries)+') AS catalog'
        params={'tables':list(TABLES),'public_roles':list(original._PUBLIC_ROLES),'functions':['team_workspace_session_active']}
        values=db.execute(text(sql),params).mappings().one()['catalog']
        if type(values) is not dict or set(values)!=set(queries):closed()
        _validate_catalog(_Snapshot(db,values),runtime_role,verified_runtime_roles=verified_runtime_roles)
        storage=values['storage']
        if type(storage) is not list or len(storage)!=1:closed()
        storage=storage[0]
        roles={v['name']:v for v in storage['roles']}
        rights=(set(roles)=={'anon','authenticated','service_role'} and roles['service_role']['bypass'] is True
            and len(storage['relations'])==2 and {r['name'] for r in storage['relations']}=={'objects','buckets'}
            and all(r['rls'] is True and all(r[k] is True for k in ('select','insert','update','delete')) for r in storage['relations']))
        return {'storageRights':rights,'storageAclSha256':hashlib.sha256(json.dumps(storage,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}
    except Exception:closed()


def _validate_catalog(db, runtime_role='postgres', *, verified_runtime_roles=()):
    """Inspect the caller's active business transaction, never a second connection.

    The caller already installed private logging/timeouts/advisory lock. No user
    fields, raw SQL error or role names are exported. Existing Auth function is
    read-only checked, never created or replaced here.
    """
    try:
        role=original._role(runtime_role,verified_runtime_roles)
        if TABLES!=EXPECTED_TABLES or not db.in_transaction() or db.get_bind().dialect.name!='postgresql':
            closed()
        params={'tables':list(TABLES),'public_roles':list(original._PUBLIC_ROLES),
                'functions':['team_workspace_session_active']}
        identity=db.execute(text("""SELECT current_user AS runtime_role,
          (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname=ANY(CAST(:public_roles AS text[]))) AS public_role_count"""),params).mappings().one()
        if identity['runtime_role']!=role or identity['public_role_count']!=len(original._PUBLIC_ROLES):closed()
        relations=db.execute(text(original._RELATIONS),params).mappings().all()
        if len(relations)!=4 or {r['name'] for r in relations}!=set(TABLES) or any(r['kind']!='r' or r['rls'] is not True or r['forced_rls'] is not False or r['owner_role']!=role or r['public_acl'] for r in relations):closed()
        columns=defaultdict(dict)
        for row in db.execute(text(original._COLUMNS),params).mappings().all():
            columns[row['table_name']][row['name']]=(row['type'],row['not_null'])
        if dict(columns)!=expected_columns():closed()
        constraints=defaultdict(set)
        for row in db.execute(text(original._CONSTRAINTS),params).mappings().all():
            if not all(row[k] is True for k in ('validated','index_valid','index_ready')):closed()
            constraints[row['table_name']].add((row['kind'],tuple(row['columns'])))
        if dict(constraints)!=expected_constraints():closed()
        indexes={r['name']:r for r in db.execute(text(original._INDEXES),params).mappings().all()}
        for table in ContributionBase.metadata.sorted_tables:
            for index in table.indexes:
                row=indexes.get(index.name)
                if not row or not all(row[k] is True for k in ('valid','ready','plain')) or (row['table_name'],tuple(row['columns']),row['unique'])!=(table.name,tuple(index.columns.keys()),index.unique):closed()
        allowed_indexes={(name,cols,True) for name,items in expected_constraints().items() for _,cols in items}
        allowed_indexes.update((table.name,tuple(index.columns.keys()),index.unique) for table in ContributionBase.metadata.sorted_tables for index in table.indexes)
        if len(indexes)!=len(allowed_indexes) or any(not all(row[k] is True for k in ('valid','ready','plain')) or (row['table_name'],tuple(row['columns']),row['unique']) not in allowed_indexes for row in indexes.values()):closed()
        if db.execute(text(original._TABLE_ACCESS),params).mappings().all():closed()
        # Only the complete source-pinned deletion barrier (or its whole
        # absence before installation) is compatible. No trigger-name bypass.
        # Use exactly the same expression in the one-round-trip snapshot.
        extras=db.execute(text(_EXTRAS),params).mappings().one()
        if any(value is not False for value in extras.values()):closed()
        functions=db.execute(text(original._FUNCTION_CATALOG),params).mappings().all()
        if len(functions)!=1:closed()
        row=functions[0];_,arguments,result,body=original._FUNCTIONS['team_workspace_session_active']
        if row['name']!='team_workspace_session_active' or row['definer'] is not True or row['config'] not in (['search_path=""'],['search_path=']) or row['owner_role']!=original._FUNCTION_OWNER or row['source'].strip()!=body.strip() or tuple(row['arguments'])!=arguments or row['result']!=result or row['kind']!='f' or row['volatility']!='s' or row['language']!='sql' or row['runtime_execute'] is not True or row['public_acl'] or row['public_execute']:closed()
        return True
    except Exception:
        closed()

_IDENTITY='SELECT current_user AS runtime_role,\n          (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname=ANY(CAST(:public_roles AS text[]))) AS public_role_count'
_EXTRAS="SELECT\n          EXISTS(SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[]))) AS policies,\n          NOT ("+OPTIONAL_BARRIER_SQL+") AS triggers,\n          EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w JOIN pg_catalog.pg_class c ON c.oid=w.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[]))) AS rules,\n          EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[])) AND k.contype NOT IN ('p','u')) AS extra_constraints,\n          EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[])) AND acl.grantee<>c.relowner) AS extra_grants"

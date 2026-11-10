"""Offline installation draft and same-connection, read-only readiness gate.

No startup DDL. Import registration models before generating the combined draft.
The deployment operator verifies the actual runtime role; clients cannot set it.
"""
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import MetaData, UniqueConstraint, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable

from app.rewards_models import RewardsBase
from app.team_workspace_installation import (_role, _RELATIONS, _COLUMNS,
    _CONSTRAINTS, _INDEXES, _TABLE_ACCESS, _copy_table_preserving_index_names)

_DIALECT = postgresql.dialect()
_ROLES = ('anon', 'authenticated', 'service_role')
_LOCK = 621662560617158019


def generate_installation_sql(runtime_role='postgres', *, verified_runtime_roles=(), model_metadata=None):
    role = _role(runtime_role, verified_runtime_roles)
    metadata = MetaData(schema='public')
    for table in (model_metadata if model_metadata is not None else RewardsBase.metadata).sorted_tables:
        _copy_table_preserving_index_names(table, metadata)
    statements = [
        '-- REVIEW DRAFT ONLY. No deployment or DDL was executed by this generator.',
        '-- Existing Team session guard and original invitation table must be installed first.',
        '-- Runtime role, parameter-safe logging, original key and Auth read privileges require verification.',
        'BEGIN;', "SET LOCAL statement_timeout = '8s';", "SET LOCAL lock_timeout = '3s';",
        f'SELECT pg_catalog.pg_advisory_xact_lock({_LOCK});',
    ]
    for table in metadata.sorted_tables:
        name = 'public."'+table.name+'"'
        statements.append(str(CreateTable(table, if_not_exists=True).compile(dialect=_DIALECT)).strip()+';')
        if table.name == 'reward_audit':
            statements.append(f"ALTER TABLE {name} ADD COLUMN IF NOT EXISTS reason varchar(500) NOT NULL DEFAULT '';")
        for index in sorted(table.indexes, key=lambda i: i.name):
            statements.append(str(CreateIndex(index, if_not_exists=True).compile(dialect=_DIALECT)).strip()+';')
        statements.extend([
            f'ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;',
            f'REVOKE ALL ON TABLE {name} FROM PUBLIC, anon, authenticated, service_role;',
            f'ALTER TABLE {name} OWNER TO "{role}";',
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {name} TO "{role}";',
        ])
    statements.append('COMMIT;')
    return '\n\n'.join(statements)+'\n'


def _fail():
    raise HTTPException(503, '奖励数据权限尚未就绪', headers={'Cache-Control': 'no-store'})


def assert_rewards_ready(db, runtime_role='postgres', *, verified_runtime_roles=(), model_metadata=None, invitation_dependencies=True):
    """Inspect the caller's already locked transaction. Never reconnect or issue DDL."""
    try:
        role = _role(runtime_role, verified_runtime_roles)
        engine = db.get_bind()
        if engine.dialect.name != 'postgresql' or engine.echo or engine.hide_parameters is not True:
            _fail()
        tables = dict((model_metadata if model_metadata is not None else RewardsBase.metadata).tables)
        if not tables:
            _fail()
        params = {'tables': sorted(tables), 'public_roles': list(_ROLES)}
        identity = db.execute(text("""SELECT current_user AS runtime_role,
          (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname=ANY(CAST(:public_roles AS text[]))) AS public_role_count"""), params).mappings().one()
        if identity['runtime_role'] != role or identity['public_role_count'] != len(_ROLES):
            _fail()
        relations = db.execute(text(_RELATIONS), params).mappings().all()
        if {r['name'] for r in relations} != set(tables) or any(r['kind'] != 'r' or r['rls'] is not True or r['forced_rls'] is not False or r['owner_role'] != role or r['public_acl'] for r in relations):
            _fail()
        columns = defaultdict(dict)
        for row in db.execute(text(_COLUMNS), params).mappings().all():
            columns[row['table_name']][row['name']] = (row['type'], row['not_null'])
        expected_columns = {name: {c.name: (str(c.type.compile(dialect=_DIALECT)).lower().replace('varchar', 'character varying'), not c.nullable) for c in table.columns} for name, table in tables.items()}
        if dict(columns) != expected_columns:
            _fail()
        constraints = defaultdict(set)
        for row in db.execute(text(_CONSTRAINTS), params).mappings().all():
            if not all(row[k] is True for k in ('validated', 'index_valid', 'index_ready')):
                _fail()
            constraints[row['table_name']].add((row['kind'], tuple(row['columns'])))
        expected_constraints = {name: {('p', tuple(c.name for c in table.primary_key.columns))} | {('u', tuple(c.name for c in cst.columns)) for cst in table.constraints if isinstance(cst, UniqueConstraint)} for name, table in tables.items()}
        if dict(constraints) != expected_constraints:
            _fail()
        indexes = {r['name']: r for r in db.execute(text(_INDEXES), params).mappings().all()}
        for table in tables.values():
            for index in table.indexes:
                row = indexes.get(index.name)
                if not row or not all(row[k] is True for k in ('valid', 'ready', 'plain')) or (row['table_name'], tuple(row['columns']), row['unique']) != (table.name, tuple(c.name for c in index.columns), index.unique):
                    _fail()
        if db.execute(text(_TABLE_ACCESS), params).mappings().all():
            _fail()
        # No client-facing RLS policy is permitted on these server-only tables.
        if db.execute(text("SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename=ANY(CAST(:tables AS text[]))"), params).scalar_one() != 0:
            _fail()
        dependencies = db.execute(text("""SELECT
          pg_catalog.has_column_privilege(current_user,'auth.users','id','SELECT')
          AND pg_catalog.has_column_privilege(current_user,'auth.users','phone','SELECT')
          AND pg_catalog.has_column_privilege(current_user,'auth.users','phone_confirmed_at','SELECT')
          AND pg_catalog.has_column_privilege(current_user,'auth.users','deleted_at','SELECT')
          AND pg_catalog.has_column_privilege(current_user,'auth.users','is_anonymous','SELECT')
          AND pg_catalog.has_column_privilege(current_user,'auth.users','banned_until','SELECT') AS auth_read""")).mappings().one()
        if dependencies['auth_read'] is not True:
            _fail()
        if invitation_dependencies:
            invitation_access = db.execute(text("""SELECT
              pg_catalog.has_table_privilege(current_user,'public.account_invitation_codes','SELECT')
              AND pg_catalog.has_table_privilege(current_user,'public.account_invitation_codes','INSERT')""")).scalar_one()
            if invitation_access is not True:
                _fail()
        return {'ready': True, 'tables': len(tables)}
    except Exception:
        _fail()

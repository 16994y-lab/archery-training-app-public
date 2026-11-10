"""Reviewed PostgreSQL draft generation and fail-closed readiness; no startup DDL.

The default runtime role ``postgres`` is a proposal, NOT evidence of the deployed
connection's identity. A non-default role is accepted only when supplied in the
operator's separately verified role set. Never source this set from an HTTP body.
"""
from collections import defaultdict
import re
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import MetaData, UniqueConstraint, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable

from app.team_workspace_models import TeamBase

_LOCK = 621662560617158019  # Same transaction lock as team_workspace.py.
_PUBLIC_ROLES = ("anon", "authenticated", "service_role")
_FUNCTION_OWNER = "postgres"
_DIALECT = postgresql.dialect()
_TABLES = tuple(sorted(TeamBase.metadata.tables))

SESSION_ACTIVE_BODY = """SELECT EXISTS (
    SELECT 1
    FROM auth.sessions AS s
    JOIN auth.users AS u ON u.id = s.user_id
    WHERE s.id = p_session_id AND s.user_id = p_owner
      AND (s.not_after IS NULL OR s.not_after > pg_catalog.now())
      AND u.deleted_at IS NULL AND u.is_anonymous IS FALSE
      AND u.phone IS NOT NULL AND u.phone <> ''
      AND u.phone_confirmed_at IS NOT NULL
      AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.now())
)"""

CONTACT_HINT_BODY = """SELECT CASE
    WHEN u.phone ~ '^(86|[+]86)?1[3-9][0-9]{9}$'
    THEN pg_catalog.left(pg_catalog.right(u.phone, 11), 2)
         || '*****' || pg_catalog.right(u.phone, 4)
    ELSE NULL
END
FROM auth.users AS u
WHERE u.id = p_owner AND u.deleted_at IS NULL
  AND u.is_anonymous IS FALSE AND u.phone_confirmed_at IS NOT NULL
  AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.now())
  AND EXISTS (SELECT 1 FROM public.team_coach_applications AS a
              WHERE a.user_id = p_owner::text)"""

_FUNCTIONS = {
    "team_workspace_session_active": ("p_owner uuid, p_session_id uuid", ("uuid", "uuid"), "boolean", SESSION_ACTIVE_BODY),
    "team_workspace_contact_hint": ("p_owner uuid", ("uuid",), "text", CONTACT_HINT_BODY),
}


def _role(runtime_role, verified_runtime_roles):
    allowed = {_FUNCTION_OWNER}
    if not isinstance(verified_runtime_roles, (tuple, list, set, frozenset)):
        raise ValueError("Invalid verified runtime role set")
    for role in (*verified_runtime_roles, runtime_role):
        if not isinstance(role, str) or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role) or role in {"public", *_PUBLIC_ROLES}:
            raise ValueError("Invalid runtime role")
    allowed.update(verified_runtime_roles)
    if runtime_role not in allowed:
        raise ValueError("Runtime role has not been independently verified")
    return runtime_role


def _copy_table_preserving_index_names(table, metadata):
    copied = table.to_metadata(metadata, schema="public")
    # Column(index=True) otherwise regenerates ix_public_* on schema copy.
    # Preserve the same semantic index names enforced by readiness.
    for index in copied.indexes:
        matches = [source for source in table.indexes
                   if tuple(source.columns.keys()) == tuple(index.columns.keys())
                   and source.unique == index.unique]
        if len(matches) != 1:
            raise ValueError("Ambiguous installation index metadata")
        index.name = matches[0].name
    return copied


def generate_installation_sql(runtime_role="postgres", *, verified_runtime_roles=()):
    """Return a reviewable SQL draft. This function never opens a DB connection.

    Execute only after deployment/database-role review. It does not bind any owner
    UID. Existing relations are not dropped; readiness must pass after installation.
    """
    role = _role(runtime_role, verified_runtime_roles)
    quoted = '"'+role+'"'
    metadata = MetaData(schema="public")
    for name in _TABLES:
        _copy_table_preserving_index_names(TeamBase.metadata.tables[name], metadata)
    parts = ["-- REVIEW DRAFT ONLY. Not applied; no owner UID is embedded or bound.",
             "-- Default postgres is assumed until the live runtime identity is verified.",
             "-- A custom runtime role must already exist and be independently verified.",
             "BEGIN;", "SET LOCAL statement_timeout = '8s';", "SET LOCAL lock_timeout = '3s';",
             f"SELECT pg_catalog.pg_advisory_xact_lock({_LOCK});"]
    for table in metadata.sorted_tables:
        name = 'public."'+table.name+'"'
        parts.append(str(CreateTable(table, if_not_exists=True).compile(dialect=_DIALECT)).strip()+";")
        if table.name == "team_workspace_audits":
            parts.append(f"ALTER TABLE {name} ADD COLUMN IF NOT EXISTS reason varchar(500) NOT NULL DEFAULT '';")
        for index in sorted(table.indexes, key=lambda i: i.name):
            parts.append(str(CreateIndex(index, if_not_exists=True).compile(dialect=_DIALECT)).strip()+";")
        parts.extend([f"ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;",
                      f"REVOKE ALL ON TABLE {name} FROM PUBLIC, anon, authenticated, service_role;",
                      f"ALTER TABLE {name} OWNER TO {quoted};",
                      f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {name} TO {quoted};"])
    for name, (arguments, types, result, body) in _FUNCTIONS.items():
        signature = f"public.{name}({', '.join(types)})"
        parts.extend([f"CREATE OR REPLACE FUNCTION public.{name}({arguments})\nRETURNS {result}\nLANGUAGE sql STABLE SECURITY DEFINER\nSET search_path = ''\nAS $team_workspace$\n{body}\n$team_workspace$;",
                      f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC, anon, authenticated, service_role;",
                      f'ALTER FUNCTION {signature} OWNER TO "{_FUNCTION_OWNER}";',
                      f"GRANT EXECUTE ON FUNCTION {signature} TO {quoted};"])
    parts.append("COMMIT;")
    return "\n\n".join(parts)+"\n"


def _expected_columns():
    return {name: {c.name: (str(c.type.compile(dialect=_DIALECT)).lower().replace("varchar", "character varying"), not c.nullable)
                   for c in TeamBase.metadata.tables[name].columns} for name in _TABLES}


def _expected_constraints():
    result = {}
    for name in _TABLES:
        table = TeamBase.metadata.tables[name]
        result[name] = {("p", tuple(c.name for c in table.primary_key.columns))}
        result[name].update(("u", tuple(c.name for c in cst.columns)) for cst in table.constraints if isinstance(cst, UniqueConstraint))
    return result


def _expected_indexes():
    return {index.name: (name, tuple(c.name for c in index.columns), index.unique)
            for name in _TABLES for index in TeamBase.metadata.tables[name].indexes}


_RELATIONS = """SELECT c.relname AS name, c.relkind AS kind,
 c.relrowsecurity AS rls, c.relforcerowsecurity AS forced_rls, r.rolname AS owner_role,
 EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl WHERE acl.grantee=0) AS public_acl
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[]))"""

_COLUMNS = """SELECT c.relname AS table_name, a.attname AS name,
 pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[]))
 AND a.attnum>0 AND NOT a.attisdropped"""

_CONSTRAINTS = """SELECT c.relname AS table_name, k.contype AS kind,
 ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY x(attnum,position)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.attnum ORDER BY x.position) AS columns,
 k.convalidated AS validated, i.indisvalid AS index_valid, i.indisready AS index_ready
FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_index i ON i.indexrelid=k.conindid
WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[])) AND k.contype IN ('p','u')"""

_INDEXES = """SELECT c.relname AS table_name, idx.relname AS name,
 i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
 i.indpred IS NULL AND i.indexprs IS NULL AS plain,
 ARRAY(SELECT a.attname FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY x(attnum,position)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.attnum ORDER BY x.position) AS columns
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[]))"""

_TABLE_ACCESS = """SELECT c.relname AS table_name, r.rolname AS role_name
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN pg_catalog.pg_roles r
WHERE n.nspname='public' AND c.relname=ANY(CAST(:tables AS text[]))
 AND r.rolname=ANY(CAST(:public_roles AS text[]))
 AND (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))"""

_FUNCTION_CATALOG = """SELECT p.proname AS name, p.prosecdef AS definer,
 p.proconfig AS config, p.prosrc AS source, r.rolname AS owner_role,
 p.prokind AS kind, p.provolatile AS volatility, l.lanname AS language,
 pg_catalog.format_type(p.prorettype,NULL) AS result,
 ARRAY(SELECT pg_catalog.format_type(x,NULL) FROM pg_catalog.unnest(p.proargtypes) x) AS arguments,
 pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AS runtime_execute,
 EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE acl.grantee=0) AS public_acl,
 EXISTS(SELECT 1 FROM pg_catalog.pg_roles z WHERE z.rolname=ANY(CAST(:public_roles AS text[]))
        AND pg_catalog.has_function_privilege(z.oid,p.oid,'EXECUTE')) AS public_execute
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
WHERE n.nspname='public' AND p.proname=ANY(CAST(:functions AS text[]))"""


def _fail():
    raise HTTPException(503, "团队数据权限尚未就绪", headers={"Cache-Control": "no-store"})


def require_schema_ready(session_factory, expected_owner_uid, runtime_role="postgres", *, verified_runtime_roles=()):
    """Read-only, one-connection/transaction gate; returns only non-sensitive facts.

    Neither relation/function names alone nor a successful SELECT counts as ready.
    Function bodies, empty search_path, ACLs, columns, keys/indexes and owner binding
    must match the reviewed contract. Every unknown or driver error returns 503.
    """
    try:
        role = _role(runtime_role, verified_runtime_roles)
        if not isinstance(expected_owner_uid, str) or str(UUID(expected_owner_uid)) != expected_owner_uid:
            _fail()
        params = {"tables": list(_TABLES), "public_roles": list(_PUBLIC_ROLES), "functions": list(_FUNCTIONS)}
        with session_factory() as db:
            with db.begin():
                if db.get_bind().dialect.name != "postgresql":
                    _fail()
                db.execute(text("SELECT pg_catalog.set_config('statement_timeout','8000',true)"))
                db.execute(text("SELECT pg_catalog.set_config('lock_timeout','3000',true)"))
                db.execute(text("SELECT pg_catalog.pg_advisory_xact_lock(:lock)"), {"lock": _LOCK})
                identity = db.execute(text("""SELECT current_user AS runtime_role,
                    (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname=ANY(CAST(:public_roles AS text[]))) AS public_role_count"""), params).mappings().one()
                if identity["runtime_role"] != role or identity["public_role_count"] != len(_PUBLIC_ROLES):
                    _fail()
                relations = db.execute(text(_RELATIONS), params).mappings().all()
                if len(relations) != len(_TABLES) or {r["name"] for r in relations} != set(_TABLES) or any(r["kind"] != "r" or r["rls"] is not True or r["forced_rls"] is not False or r["owner_role"] != role or r["public_acl"] for r in relations):
                    _fail()
                actual_columns = defaultdict(dict)
                for row in db.execute(text(_COLUMNS), params).mappings().all():
                    actual_columns[row["table_name"]][row["name"]] = (row["type"], row["not_null"])
                if dict(actual_columns) != _expected_columns():
                    _fail()
                actual_constraints = defaultdict(set)
                for row in db.execute(text(_CONSTRAINTS), params).mappings().all():
                    if not all(row[k] is True for k in ("validated", "index_valid", "index_ready")):
                        _fail()
                    actual_constraints[row["table_name"]].add((row["kind"], tuple(row["columns"])))
                if dict(actual_constraints) != _expected_constraints():
                    _fail()
                actual_indexes = {r["name"]: r for r in db.execute(text(_INDEXES), params).mappings().all()}
                for name, expected in _expected_indexes().items():
                    row = actual_indexes.get(name)
                    if not row or not all(row[k] is True for k in ("valid", "ready", "plain")) or (row["table_name"], tuple(row["columns"]), row["unique"]) != expected:
                        _fail()
                if db.execute(text(_TABLE_ACCESS), params).mappings().all():
                    _fail()
                functions = db.execute(text(_FUNCTION_CATALOG), params).mappings().all()
                if len(functions) != len(_FUNCTIONS) or {r["name"] for r in functions} != set(_FUNCTIONS):
                    _fail()
                for row in functions:
                    _, arguments, result, source = _FUNCTIONS[row["name"]]
                    if row["definer"] is not True or row["config"] not in (["search_path=\"\""], ["search_path="]) or row["owner_role"] != _FUNCTION_OWNER or row["source"].strip() != source.strip() or tuple(row["arguments"]) != arguments or row["result"] != result or row["kind"] != "f" or row["volatility"] != "s" or row["language"] != "sql" or row["runtime_execute"] is not True or row["public_acl"] or row["public_execute"]:
                        _fail()
                owners = db.execute(text("SELECT slot,user_id FROM public.team_workspace_owner")).mappings().all()
                # Permanent account deletion may leave the operator seat vacant.
                # This gate never appoints a successor; every admin action still
                # requires an actual matching WorkspaceOwner row. If occupied,
                # the independently configured binding remains mandatory.
                if len(owners) > 1 or (owners and (owners[0]["slot"] != 1 or owners[0]["user_id"] != expected_owner_uid)):
                    _fail()
        return {"ready": True, "tables": len(_TABLES)}
    except Exception:
        # Do not expose a UID, SQL, role, schema name, driver error or configuration.
        _fail()


def create_schema_gate(session_factory, expected_owner_uid, runtime_role="postgres", *, verified_runtime_roles=()):
    def gate():
        require_schema_ready(session_factory, expected_owner_uid, runtime_role, verified_runtime_roles=verified_runtime_roles)
    return gate

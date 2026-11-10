"""Closed, server-only account erasure inventory. No I/O or DDL at import.

Caller owns the protected transaction, authenticated identity, persistent request,
Storage readback, and final Auth deletion. Returned storage bindings are PRIVATE;
only counts/blockers/fingerprint may be projected to the account holder.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from uuid import UUID, uuid5, NAMESPACE_URL

from fastapi import HTTPException
from sqlalchemy import DateTime, String, and_, cast, column, delete, func, literal, or_, select, table, text, tuple_, union_all
from sqlalchemy.orm import make_transient_to_detached


COUNT_KEYS = ('trainingSessions', 'trainingPlans', 'cloudBackups', 'teamMemberships',
              'teamsOwned', 'rewardSources', 'rewardClaims', 'invitationLinks',
              'feedbackRecords', 'privateMedia', 'contributionPhotos', 'archiveRecords',
              'communityRecords')
ERASED = '00000000-0000-0000-0000-000000000000'
EXTRA_TABLES = {'account_deletion_requests', 'account_deletion_objects'}
SHARED_TABLES = {'alembic_version', 'target_definitions', 'product_announcements',
                 'product_metric_streams', 'product_metric_events',
                 'sms_send_reservations', 'sms_retry_operations'}
AUTH_TABLES = ('phone_binding_claims', 'account_email_proofs', 'account_email_challenges',
               'account_email_send_reservations', 'account_email_binding_intents',
               'account_email_enrollments')
_ANCILLARY_COLUMNS = {
    'phone_binding_claims': 'phone_digest owner state updated_at',
    'account_email_proofs': 'owner email_digest verified_at',
    'account_email_challenges': 'owner challenge_id email_digest code_digest attempts expires_at',
    'account_email_send_reservations': 'event_id owner email_digest purpose reserved_at',
    'account_email_binding_intents': 'owner intent_id email_digest code_digest state attempts created_at expires_at',
    'account_email_enrollments': 'enrollment_id address_digest resume_digest creation_digest creation_expires owner state attempt_id send_digest send_expires mail_event mail_fingerprint delivery native_outcome created_at updated_at expires_at completed_at',
    'sms_retry_operations': 'operation_id phone_digest attempt_nonce attempt_no state created_at expires_at next_at webhook_id owner_digest signup_owner_digest webhook_ids confirmation_digest',
    'sms_send_reservations': 'webhook_id phone_digest utc_day reserved_at outcome completed_at',
    'alembic_version': 'version_num',
}


def _fail(code='account_deletion_data_unavailable', status=409):
    raise HTTPException(status, {'code': code, 'message': '账号关联尚未完成核对，原资料保留；请读取原注销进度'})


def _identity(owner, service):
    try:
        if str(UUID(owner)) != owner or owner == ERASED:
            raise ValueError()
        if not re.fullmatch(r'https://[a-z0-9-]+\.supabase\.co', service):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        _fail(status=422)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def _hash(value):
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _models():
    from app.models import TrainingPlan, PlanBlock, TrainingSession, End, Arrow
    from app.mobile_document_models import MobileDocument
    from app.score_backup_models import ScoreBackup
    from app.private_media_models import PrivateMediaOwner, PrivateMediaObject, PrivateMediaConsentEvent, PrivateMediaAccess, MediaArchiveRecord
    from app.photo_contribution_models import ContributionChoice, ContributionReceipt, ContributionSample, ContributionDeletion
    from app.team_workspace_models import WorkspaceOwner, CoachApplication, Team, TeamMember, TeamInvitation, TeamGrant, TeamSession, TeamGroup, TeamNote, TeamAudit
    from app.rewards_models import AccountInvitationCode, AccountInvitationAttribution, RewardIdentity, RewardSource, RewardClaim, RewardRequest, RewardAttempt, RewardContact, RewardAudit
    from app.registration_models import RegistrationIntent, RegistrationReceipt, RegistrationPair
    from app.admin_operations_models import ProductFeedback, DonationSubmission, OperationsIncident, OperationsRequest, OperationsAudit
    from app.community_models import CommunityProfile, CommunityPost, CommunityComment, CommunityReport, CommunityModerator, CommunityRateWindow
    return {value.__tablename__: value for value in locals().values() if isinstance(value, type) and hasattr(value, '__tablename__')}


def _collect(db, owner, service):
    models = _models()
    rows, predicates, queries = {}, {}, {}

    def get(name, predicate):
        model = models[name]
        predicates[name] = predicate
        queries[name] = (model, predicate)

    direct = {
        'training_plans': 'owner_id', 'training_sessions': 'owner_id',
        'mobile_documents': 'owner_id', 'score_backups': 'owner_id',
        'private_media_owners': 'owner_id', 'private_media_objects': 'owner_id',
        'private_media_consent_events': 'owner_id', 'private_media_access': 'owner_id',
        'media_archive_records': 'owner_id', 'team_workspace_owner': 'user_id',
        'team_coach_applications': 'user_id', 'team_workspaces': 'coach_id',
        'team_workspace_members': 'user_id', 'account_invitation_codes': 'owner',
        'product_feedback': 'user_id', 'product_donation_submissions': 'user_id',
        'product_operations_incidents': 'user_id', 'community_profiles': 'owner_id',
        'community_posts': 'owner_id', 'community_comments': 'owner_id',
        'community_moderators': 'owner_id', 'community_rate_windows': 'owner_id',
    }
    for name, column in direct.items():
        get(name, getattr(models[name], column) == owner)
    service_tables = ('photo_contribution_choices', 'photo_contribution_receipts',
                      'photo_contribution_samples', 'photo_contribution_deletions',
                      'reward_identities', 'reward_sources', 'reward_claims',
                      'reward_claim_attempts', 'reward_contacts', 'reward_registration_receipts')
    for name in service_tables:
        model = models[name]
        get(name, and_(model.service == service, model.user_id == owner))

    ids = lambda name: select(models[name].id).where(predicates[name])
    plans, sessions, members, teams = (ids(n) for n in ('training_plans', 'training_sessions', 'team_workspace_members', 'team_workspaces'))
    get('plan_blocks', models['plan_blocks'].training_plan_id.in_(plans))
    get('ends', models['ends'].training_session_id.in_(sessions))
    get('arrows', models['arrows'].end_id.in_(ids('ends')))
    for name in ('team_workspace_invitations', 'team_workspace_grants', 'team_workspace_sessions', 'team_workspace_notes'):
        model = models[name]
        predicates_here = [model.member_id.in_(members), model.team_id.in_(teams)]
        if name == 'team_workspace_invitations': predicates_here.append(model.accepted_by == owner)
        if name == 'team_workspace_grants': predicates_here.append(model.recipient_id == owner)
        if name == 'team_workspace_notes': predicates_here.append(model.coach_id == owner)
        get(name, or_(*predicates_here))
    get('team_workspace_groups', or_(models['team_workspace_groups'].team_id.in_(teams), models['team_workspace_groups'].team_id.in_(select(models['team_workspace_members'].team_id).where(predicates['team_workspace_members']))))
    model = models['team_workspace_audits']
    get('team_workspace_audits', or_(model.actor_id == owner, model.subject_id == owner, model.subject_id.in_(members), model.subject_id.in_(teams), model.subject_id.in_(ids('team_workspace_invitations'))))

    model = models['account_invitation_attributions']
    get('account_invitation_attributions', or_(model.inviter == owner, model.invitee == owner))
    model = models['reward_registration_pairs']
    get('reward_registration_pairs', and_(model.service == service, or_(model.inviter_id == owner, model.invitee_id == owner)))
    receipt_model = models['reward_registration_receipts']; pair_model = models['reward_registration_pairs']
    registration_ids = union_all(select(receipt_model.registration_id).where(predicates['reward_registration_receipts']), select(pair_model.registration_id).where(predicates['reward_registration_pairs']))
    phone_hashes = select(receipt_model.phone_digest).where(predicates['reward_registration_receipts'])
    model = models['reward_registration_intents']
    get('reward_registration_intents', and_(model.service == service, or_(model.registration_id.in_(select(receipt_model.registration_id).where(predicates['reward_registration_receipts'])), model.phone_digest.in_(phone_hashes))))
    # Other participant sources are explicitly selected so their identity and
    # manageability survive. They are never bulk-deleted with our sources.
    peer_ids = union_all(select(pair_model.invitee_source_id).where(pair_model.service == service, pair_model.inviter_id == owner), select(pair_model.inviter_source_id).where(pair_model.service == service, pair_model.invitee_id == owner))
    peer_model = models['reward_sources']
    queries['peer_reward_sources'] = (peer_model, and_(peer_model.service == service, peer_model.id.in_(peer_ids), peer_model.user_id != owner))
    peer_identity = models['reward_identities']
    queries['peer_reward_identities'] = (peer_identity, and_(peer_identity.service == service, peer_identity.user_id.in_(select(peer_model.user_id).where(queries['peer_reward_sources'][1]))))
    claim_ids, source_ids = ids('reward_claims'), ids('reward_sources')
    model = models['reward_requests']
    get('reward_requests', and_(model.service == service, or_(model.actor_id == owner,
        model.result['userId'].as_string() == owner, model.result['claim']['userId'].as_string() == owner,
        model.result['sourceId'].as_string().in_(source_ids))))
    model = models['reward_audit']
    get('reward_audit', and_(model.service == service, or_(model.actor_id == owner, model.subject_id == owner, model.subject_id.in_(claim_ids), model.subject_id.in_(source_ids), model.subject_id.in_(registration_ids))))
    model = models['reward_claims']
    queries['issued_peer_claims'] = (model, and_(model.service == service, model.issuer_id == owner, model.user_id != owner))
    operation_ids = union_all(ids('product_feedback'), ids('product_donation_submissions'), ids('product_operations_incidents'))
    model = models['product_operations_requests']
    get('product_operations_requests', or_(model.actor_id == owner,
        model.result['userId'].as_string() == owner, model.result['id'].as_string().in_(operation_ids),
        *(or_(model.result[key]['userId'].as_string() == owner, model.result[key]['id'].as_string().in_(operation_ids)) for key in ('feedback','donation','incident'))))
    model = models['product_operations_audits']
    get('product_operations_audits', or_(model.actor_id == owner, model.subject_id == owner, model.subject_id.in_(operation_ids)))
    model = models['community_reports']
    get('community_reports', or_(model.reporter_id == owner, model.moderator_id == owner,
                               model.target_id.in_(union_all(ids('community_posts'), ids('community_comments')))))
    # Preserve other people's replies; our post becomes a content-free tombstone.
    model = models['community_comments']
    queries['peer_comments'] = (model, and_(model.post_id.in_(ids('community_posts')), model.owner_id != owner))
    # Same applies to a coach who departs: others' original or submitted records
    # and team membership survive; all grants to the former coach are disabled.
    model = models['team_workspace_members']
    associated_members = union_all(*(select(models[name].member_id).where(predicates[name]) for name in
        ('team_workspace_grants', 'team_workspace_sessions', 'team_workspace_notes', 'team_workspace_invitations')))
    queries['peer_team_members'] = (model, and_(or_(model.team_id.in_(teams), model.id.in_(associated_members)), or_(model.user_id != owner, model.user_id.is_(None))))
    for name, (_, predicate) in queries.items(): predicates.setdefault(name, predicate)
    if db.get_bind().dialect.name == 'postgresql':
        # One network round trip for the closed, parameter-bound ownership tree.
        statement = union_all(*(select(literal(name).label('kind'), func.to_jsonb(model.__table__.table_valued()).label('value')).select_from(model).where(predicate) for name, (model, predicate) in queries.items()))
        rows = {name: [] for name in queries}
        for name, values in db.execute(statement):
            model = queries[name][0]
            converted = dict(values)
            for column in model.__table__.columns:
                if isinstance(column.type, DateTime) and isinstance(converted.get(column.name), str):
                    converted[column.name] = datetime.fromisoformat(converted[column.name])
            instance = model(**converted)
            make_transient_to_detached(instance)
            rows[name].append(db.merge(instance, load=False))
    else:
        rows = {name: list(db.scalars(select(model).where(predicate).execution_options(populate_existing=True))) for name, (model, predicate) in queries.items()}
    if any(len(values) > 25000 for values in rows.values()): _fail('account_deletion_batch_too_large', 503)
    cross = union_all(*(select(literal(1)).where(select(models[name].user_id).where(models[name].user_id == owner, models[name].service != service).exists()) for name in service_tables))
    if db.execute(cross).first(): _fail('account_deletion_cross_service_data')
    auth = {}
    if db.get_bind().dialect.name == 'postgresql':
        auth = {name: [] for name in AUTH_TABLES}
        for name, value in db.execute(text(' UNION ALL '.join(f"SELECT '{name}',to_jsonb(t) FROM public.{name} t WHERE CAST(owner AS text)=CAST(:owner AS text)" for name in AUTH_TABLES)), {'owner': owner}): auth[name].append(value)
    else:
        for name in AUTH_TABLES:
            auth[name] = [dict(r) for r in db.execute(text(f'SELECT * FROM {name} WHERE owner=:owner'), {'owner': owner}).mappings()]
    auth = {name: sorted(values, key=_canonical) for name, values in auth.items()}
    rows['_auth'] = auth
    return models, rows, predicates


def _schema(db, models):
    if db.get_bind().dialect.name == 'sqlite':
        if db.info.get('account_deletion_isolated_test') is not True:
            _fail('account_deletion_postgres_required', 503)
        return
    if db.get_bind().dialect.name != 'postgresql': _fail(status=503)
    from app.account_deletion_barrier import require_write_barrier
    require_write_barrier(db)
    shape = {name: set(columns) for name, columns in db.execute(text("SELECT c.relname,array_agg(a.attname ORDER BY a.attnum) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.relname"))}
    names = set(shape)
    expected = set(models) | set(AUTH_TABLES) | SHARED_TABLES | EXTRA_TABLES
    if names != expected:
        _fail('account_deletion_schema_review_required', 503)
    from app.models import TargetDefinition
    from app.admin_operations_models import ProductAnnouncement, BusinessMetricStream, BusinessMetricEvent
    expected_columns = {name: set(model.__table__.columns.keys()) for name, model in models.items()}
    expected_columns.update({m.__tablename__: set(m.__table__.columns.keys()) for m in (TargetDefinition, ProductAnnouncement, BusinessMetricStream, BusinessMetricEvent)})
    expected_columns.update({name: set(columns.split()) for name, columns in _ANCILLARY_COLUMNS.items()})
    if any(shape[name] != columns for name, columns in expected_columns.items()):
        _fail('account_deletion_schema_review_required', 503)
    foreign_keys = set(db.execute(text("""SELECT src.relname,sa.attname,tn.nspname,dst.relname,da.attname,
      c.confdeltype::text,c.confupdtype::text,c.condeferrable,c.condeferred
      FROM pg_constraint c JOIN pg_class src ON src.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=src.relnamespace
      JOIN pg_class dst ON dst.oid=c.confrelid JOIN pg_namespace tn ON tn.oid=dst.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(s,d)
      JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attnum=k.s
      JOIN pg_attribute da ON da.attrelid=dst.oid AND da.attnum=k.d
      WHERE c.contype='f' AND sn.nspname='public'""")).all())
    expected_fks = {(name, fk.parent.name, 'public', fk.column.table.name, fk.column.name, 'a', 'a', False, False)
                    for name, model in models.items() for fk in model.__table__.foreign_keys}
    if foreign_keys != expected_fks: _fail('account_deletion_schema_review_required', 503)
    # Actual reviewed catalog has no account_next tables. Never silently skip an
    # added owner namespace, a partition, or future ownership relation.
    if db.execute(text("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='account_next' AND c.relkind IN ('r','p'))")).scalar_one():
        _fail('account_deletion_schema_review_required', 503)


def _inventory(db, owner, service):
    _identity(owner, service)
    models = _models()
    _schema(db, models)
    models, rows, predicates = _collect(db, owner, service)
    blockers, targets = [], []
    def block(code, message):
        if not any(b['code'] == code for b in blockers): blockers.append({'code': code, 'message': message})
    plans = [r.id for r in rows['training_plans']]
    blocks = [r.id for r in rows['plan_blocks']]
    session = models['training_sessions']; end = models['ends']
    if db.scalar(select(session.id).where(session.owner_id != owner, session.training_plan_id.in_(plans)).limit(1)) or db.scalar(select(end.id).join(session, end.training_session_id == session.id).where(session.owner_id != owner, end.plan_block_id.in_(blocks)).limit(1)):
        block('cross_account_training_reference', '检测到跨账号训练关联，需先核对；不会删除其他人的记录')
    buckets = db.info.get('account_deletion_storage_buckets', {})
    if type(buckets) is not dict: _fail(status=503)
    def target(kind, identity, path, size, sha, bucket_kind=None):
        bucket = buckets.get(bucket_kind or kind)
        if not isinstance(identity, str) or not re.fullmatch('[0-9a-f]{32}', identity) or type(size) is not int or size <= 0 or not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{64}', sha):
            block('storage_binding_unknown', '媒体对象的身份或大小尚未核清'); return
        if not isinstance(bucket, str) or not re.fullmatch('[a-z0-9][a-z0-9_-]{2,62}', bucket):
            block('storage_binding_unknown', '媒体保存位置尚未核清'); return
        item = dict(kind=kind, objectId=identity, path=path, expectedBytes=size, sha256=sha, bucket=bucket)
        item['key'] = _hash([kind, bucket, path])
        if item not in targets: targets.append(item)
    for r in rows['private_media_objects']:
        if r.status == 'pending' and r.attempts:
            block('media_upload_unsettled', '存在尚未确认结束的媒体上传，请先核对原上传结果')
        if r.status == 'stored' or r.attempts:
            target('private', r.id, f'objects/{r.id[:2]}/{r.id}', r.byte_size, r.sha256)
        elif r.status not in ('pending', 'expired', 'failed'):
            block('storage_binding_unknown', '媒体状态尚未核清')
    receipts = {(r.sample_id, r.request_id) for r in rows['photo_contribution_receipts'] if r.operation == 'content' and r.state == 'done'}
    deletions = {r.sample_id: r for r in rows['photo_contribution_deletions']}
    for r in rows['photo_contribution_samples']:
        job = deletions.get(r.sample_id)
        settled = bool(r.status in ('uploaded', 'received') or r.received_at or (r.sample_id, r.upload_request) in receipts or job and job.settled)
        if r.upload_request and not settled:
            block('contribution_upload_unsettled', '存在尚未确认结束的贡献上传，请先核对原请求')
        if r.storage_scope != 'contributions/v1':
            block('storage_binding_unknown', '贡献照片保存位置尚未核清')
        if r.upload_request:
            target('contribution', r.object_id, f'contributions/v1/{r.object_id[:2]}/{r.object_id}.png', r.image_bytes, r.image_sha256)
    sample_ids = {r.sample_id for r in rows['photo_contribution_samples']}
    for r in rows['photo_contribution_deletions']:
        if r.sample_id not in sample_ids and r.state != 'deleted':
            block('storage_binding_unknown', '存在尚未核清的历史媒体删除记录')
    for r in rows['media_archive_records']:
        # Current adapter cannot assert that inflight restore writes have stopped.
        receipt = r.restore_receipt or {}
        if r.status != 'stored' or receipt.get('state') == 'pending':
            block('archive_operation_unsettled', '存在尚未确认结束的归档或恢复，请先核对原请求')
        base = 'archives-v1/' + hashlib.sha256(owner.encode()).hexdigest()
        target('archive', r.id, f'{base}/zips/{r.id}.zip', r.byte_size, r.archive_sha256)
        manifest = r.manifest
        if type(manifest) is not dict or manifest.get('ownerId') != owner or manifest.get('archiveId') != r.id:
            block('storage_binding_unknown', '归档归属尚未核清'); continue
        archive_binding = _hash([service, buckets.get('archive'), 'archives-v1', buckets.get('archive_copy')])
        objects = manifest.get('objects')
        if (type(objects) is not list or not objects or any(type(obj) is not dict or not isinstance(obj.get('id'), str) for obj in objects)
                or manifest.get('schema') != 'private-media-archive/v1'
                or manifest.get('restoreSemantics') != '核对后恢复独立受保护对象副本，不覆盖训练记录，不重授训练同意，不删除任何源资产。'
                or _hash(manifest) != r.manifest_sha256):
            block('storage_binding_unknown', '归档存储绑定尚未核清'); continue
        if _hash({'objectIds': sorted(obj['id'] for obj in objects), 'consent': manifest.get('archiveConsent'), 'storageBinding': archive_binding}) != r.selection_digest:
            block('storage_binding_unknown', '归档存储绑定尚未核清'); continue
        restore_id = receipt.get('restoreId')
        if restore_id:
            if (not isinstance(restore_id, str) or not re.fullmatch('[0-9a-f]{32}', restore_id)
                    or receipt.get('storageBinding') != archive_binding
                    or receipt.get('ownerId') != owner or receipt.get('archiveId') != r.id):
                block('storage_binding_unknown', '恢复对象身份尚未核清')
            else:
                for obj in manifest.get('objects', []):
                    if type(obj) is not dict or obj.get('ownerId') != owner:
                        block('storage_binding_unknown', '恢复对象归属尚未核清'); continue
                    identity = obj.get('id', '')
                    target('restored', identity, f'{base}/restored/{restore_id}/{identity}', obj.get('bytes'), obj.get('sha256'), 'archive')
        if r.durable_copy_verified or receipt.get('copyWriteAttempted'):
            target('archive_copy', r.id, f'{base}/zips/{r.id}.zip', r.byte_size, r.archive_sha256)
    if len({(t['bucket'], t['path']) for t in targets}) != len(targets):
        block('storage_binding_unknown', '媒体对象关联重复，需先核对')
    if db.get_bind().dialect.name == 'postgresql':
        # Detect Storage uploads assigned to this Auth owner but absent from the
        # application inventory. Service-role-owned objects are bound by exact keys.
        actual = db.execute(text('SELECT bucket_id,name FROM storage.objects WHERE owner_id=CAST(:owner AS text) OR owner=CAST(:owner AS uuid)'), {'owner': owner}).mappings()
        known = {(t['bucket'], t['path']) for t in targets}
        if any((r['bucket_id'], r['name']) not in known for r in actual):
            block('untracked_storage_objects', '发现尚未归入清单的账号媒体，需要先核对')
    counts = dict.fromkeys(COUNT_KEYS, 0)
    groups = {'trainingSessions': ['training_sessions'], 'trainingPlans': ['training_plans'],
        'cloudBackups': ['mobile_documents', 'score_backups'], 'teamMemberships': ['team_workspace_members'],
        'teamsOwned': ['team_workspaces'], 'rewardSources': ['reward_sources'], 'rewardClaims': ['reward_claims'],
        'invitationLinks': ['account_invitation_attributions'], 'feedbackRecords': ['product_feedback', 'product_donation_submissions', 'product_operations_incidents'],
        'privateMedia': ['private_media_objects'], 'contributionPhotos': ['photo_contribution_samples'],
        'archiveRecords': ['media_archive_records'], 'communityRecords': ['community_profiles', 'community_posts', 'community_comments']}
    for key, names in groups.items(): counts[key] = sum(len(rows[n]) for n in names)
    # The accepted scope is this owner's private content and physical objects.
    # Shared links can disappear when the other participant leaves; preserved
    # peer content can change normally while Storage work is pending. Neither
    # is a reason to strand an already accepted erasure forever.
    relational = {'account_invitation_attributions', 'reward_registration_pairs',
        'team_workspace_groups', 'team_workspace_invitations', 'team_workspace_audits',
        'reward_audit', 'product_operations_audits'}
    member_ids = {r.id for r in rows['team_workspace_members']}
    snapshot = {}
    for name, values in rows.items():
        if name == '_auth': snapshot[name] = values; continue
        if name.startswith('peer_') or name == 'issued_peer_claims' or name in relational: continue
        if name in ('reward_requests', 'product_operations_requests'):
            values = [r for r in values if r.actor_id == owner]
        elif name == 'community_reports': values = [r for r in values if r.reporter_id == owner]
        elif name in ('team_workspace_grants', 'team_workspace_sessions'):
            values = [r for r in values if r.member_id in member_ids]
        elif name == 'team_workspace_notes':
            # Either the subject or author may legitimately erase a shared
            # note. Only self-authored notes about this same owner are fixed.
            values = [r for r in values if r.member_id in member_ids and r.coach_id == owner]
        snapshot[name] = sorted(({c.name: getattr(r, c.name) for c in r.__table__.columns} for r in values), key=_canonical)
    # Storage readback is external and deliberately not part of the plan fingerprint.
    plan = dict(counts=counts, blockers=blockers, fingerprint=_hash([owner, service, snapshot, sorted(targets, key=lambda x: x['key'])]), storageObjects=sorted(targets, key=lambda x: x['key']))
    return plan, rows, predicates, models


def inspect(db, owner, service):
    """Read-only private plan in the caller's existing protected transaction."""
    return _inventory(db, owner, service)[0]


def _anonymous_team(team_id):
    return str(UUID(hex=hashlib.sha256(('gongxingji/deleted-team-coach/' + team_id).encode()).hexdigest()[:32]))


def _peer_locks(db, owner, service, rows):
    """Lock live peer identities before their rows; skip peers already erasing.

    This prevents Auth/business lock inversion with another deletion. A second
    receipt read after KEY SHARE also covers a deletion that committed while we
    waited. The locks last until the caller's transaction ends.
    """
    candidates = set()
    for values in rows.values():
        if not isinstance(values, list): continue
        for r in values:
            for name in ('user_id', 'actor_id', 'reporter_id', 'accepted_by'):
                value = getattr(r, name, None)
                if isinstance(value, str) and value and value != owner: candidates.add(value)
    if not candidates: return set()
    if db.get_bind().dialect.name != 'postgresql':
        return candidates - set(db.info.get('account_deletion_pending_owners', ()))
    digests = {hashlib.sha256((service+'|'+value).encode()).hexdigest(): value for value in candidates}
    query = text('SELECT barrier_digest FROM public.account_deletion_requests WHERE barrier_digest=ANY(:digests)')
    excluded = set(db.execute(query, {'digests': sorted(digests)}).scalars())
    eligible = sorted(value for digest, value in digests.items() if digest not in excluded)
    if eligible:
        db.execute(text('SELECT id FROM auth.users WHERE id::text=ANY(:owners) ORDER BY id FOR KEY SHARE'), {'owners': eligible}).all()
        excluded.update(db.execute(query, {'digests': sorted(digests)}).scalars())
    return {value for digest, value in digests.items() if digest not in excluded}


def _refresh_locked(db, values, predicate=None):
    """Reread the exact surviving rows, preserving concurrent peer changes."""
    if not values: return []
    model = type(values[0]); keys = list(model.__table__.primary_key.columns)
    identities = [tuple(getattr(r, c.name) for c in keys) for r in values]
    condition = tuple_(*keys).in_(identities)
    if predicate is not None: condition = and_(condition, predicate)
    return list(db.scalars(select(model).where(condition)
        .order_by(*keys).with_for_update().execution_options(populate_existing=True)))


def _barrier_body():
    # Private trigger body is fixed source. Values come only from the row,
    # fixed relation joins and the migration-bound service argument, never SQL
    # supplied by a client. Tx authority has no API-role privileges.
    return r'''
DECLARE
  item jsonb; item_old jsonb := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  item_new jsonb := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  candidates text[]; v text; c text; u uuid; found_user uuid;
  authorised uuid; position integer; is_new boolean; historical boolean;
BEGIN
  SELECT owner INTO authorised FROM gxj_account_deletion.tx_authority
    WHERE transaction_id=txid_current() AND backend_id=pg_backend_pid();
  IF authorised IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_deletion_requests
    WHERE owner=authorised::text AND service=TG_ARGV[0] AND state='pending') THEN
    RAISE EXCEPTION 'account_deletion_fenced' USING ERRCODE='23514';
  END IF;
  -- Either participant may remove a joint link. Do not acquire the other
  -- participant's Auth lock while both have accepted pending deletions.
  -- This exception only removes a row actually bound to this transaction's
  -- private authority; it cannot modify or insert somebody else's content.
  IF TG_OP='DELETE' AND authorised IS NOT NULL THEN
    IF TG_TABLE_NAME='account_invitation_attributions' AND
      authorised::text IN (item_old->>'inviter',item_old->>'invitee') THEN RETURN OLD;
    ELSIF TG_TABLE_NAME='reward_registration_pairs' AND
      authorised::text IN (item_old->>'inviter_id',item_old->>'invitee_id') THEN RETURN OLD;
    ELSIF TG_TABLE_NAME='team_workspace_notes' AND
      (item_old->>'coach_id'=authorised::text OR EXISTS(SELECT 1 FROM public.team_workspace_members
        WHERE id=item_old->>'member_id' AND user_id=authorised::text)) THEN RETURN OLD;
    ELSIF TG_TABLE_NAME='team_workspace_invitations' AND
      (item_old->>'accepted_by'=authorised::text OR EXISTS(SELECT 1 FROM public.team_workspace_members
        WHERE id=item_old->>'member_id' AND user_id=authorised::text)) THEN RETURN OLD;
    END IF;
  END IF;
  FOR position IN 1..2 LOOP
    is_new := position=2;
    item := CASE WHEN is_new THEN item_new ELSE item_old END;
    candidates := ARRAY[]::text[];
    FOREACH c IN ARRAY string_to_array(TG_ARGV[1],',') LOOP
      historical := c IN ('issuer_id','moderator_id','recipient_id','accepted_by') OR
        (c='actor_id' AND TG_TABLE_NAME IN ('reward_audit','team_workspace_audits','product_operations_audits'));
      IF c<>'' AND item->>c IS NOT NULL AND
        (NOT historical OR (is_new AND (TG_OP='INSERT' OR item_new->c IS DISTINCT FROM item_old->c))) THEN
        candidates := array_append(candidates,item->>c);
      END IF;
    END LOOP;
    IF TG_TABLE_NAME='training_sessions' THEN
      IF is_new AND (TG_OP='INSERT' OR item_new->'training_plan_id' IS DISTINCT FROM item_old->'training_plan_id') THEN
        candidates := candidates || ARRAY(SELECT owner_id FROM public.training_plans WHERE id=item->>'training_plan_id');
      END IF;
    ELSIF TG_TABLE_NAME='plan_blocks' THEN
      candidates := candidates || ARRAY(SELECT owner_id FROM public.training_plans WHERE id=item->>'training_plan_id');
    ELSIF TG_TABLE_NAME='ends' THEN
      candidates := candidates || ARRAY(SELECT owner_id FROM public.training_sessions WHERE id=item->>'training_session_id');
      IF is_new AND (TG_OP='INSERT' OR item_new->'plan_block_id' IS DISTINCT FROM item_old->'plan_block_id') THEN
        candidates := candidates || ARRAY(SELECT p.owner_id FROM public.plan_blocks b JOIN public.training_plans p ON p.id=b.training_plan_id WHERE b.id=item->>'plan_block_id');
      END IF;
    ELSIF TG_TABLE_NAME='arrows' THEN
      candidates := candidates || ARRAY(SELECT s.owner_id FROM public.ends e JOIN public.training_sessions s ON s.id=e.training_session_id WHERE e.id=item->>'end_id');
    ELSIF TG_TABLE_NAME IN ('private_media_consent_events','private_media_access') THEN
      IF is_new AND (TG_OP='INSERT' OR item_new->'object_id' IS DISTINCT FROM item_old->'object_id') THEN
        candidates := candidates || ARRAY(SELECT owner_id FROM public.private_media_objects WHERE id=item->>'object_id');
      END IF;
    END IF;
    IF TG_TABLE_NAME LIKE 'team_workspace_%' AND TG_TABLE_NAME NOT IN ('team_workspace_owner','team_workspace_audits') THEN
      -- Existing member-owned rows remain the member's content even if their
      -- former coach is pending. Only new/moved sharing binds the coach again.
      IF TG_TABLE_NAME IN ('team_workspace_grants','team_workspace_sessions') THEN
        candidates := candidates || ARRAY(SELECT user_id FROM public.team_workspace_members WHERE id=item->>'member_id' AND user_id IS NOT NULL);
      END IF;
      IF TG_TABLE_NAME IN ('team_workspace_groups','team_workspace_invitations') OR
        (is_new AND (TG_OP='INSERT' OR item_new->'team_id' IS DISTINCT FROM item_old->'team_id'
          OR item_new->'member_id' IS DISTINCT FROM item_old->'member_id'
          OR (item_new->>'user_id' IS NOT NULL AND item_new->'user_id' IS DISTINCT FROM item_old->'user_id'))) THEN
        candidates := candidates || ARRAY(SELECT coach_id FROM public.team_workspaces WHERE id=item->>'team_id');
      END IF;
      IF TG_TABLE_NAME IN ('team_workspace_notes','team_workspace_invitations') AND is_new AND
        (TG_OP='INSERT' OR item_new->'member_id' IS DISTINCT FROM item_old->'member_id') THEN
        candidates := candidates || ARRAY(SELECT user_id FROM public.team_workspace_members WHERE id=item->>'member_id' AND user_id IS NOT NULL);
      END IF;
      IF TG_TABLE_NAME='team_workspace_groups' THEN
        IF is_new AND (TG_OP='INSERT' OR item_new->'value'->'memberIds' IS DISTINCT FROM item_old->'value'->'memberIds') THEN
          candidates := candidates || ARRAY(SELECT m.user_id FROM public.team_workspace_members m
            WHERE m.id IN (SELECT jsonb_array_elements_text(COALESCE(item->'value'->'memberIds','[]'::jsonb))) AND m.user_id IS NOT NULL);
        END IF;
      END IF;
    END IF;
    IF TG_TABLE_NAME IN ('reward_requests','product_operations_requests') AND is_new AND
      (TG_OP='INSERT' OR item_new->'result' IS DISTINCT FROM item_old->'result') THEN
      candidates := candidates || ARRAY[item->'result'->>'userId',item->'result'->'claim'->>'userId'];
      candidates := candidates || ARRAY(SELECT user_id FROM public.reward_sources WHERE id=item->'result'->>'sourceId')
        || ARRAY(SELECT user_id FROM public.reward_claims WHERE id=item->'result'->'claim'->>'id');
      IF TG_TABLE_NAME='product_operations_requests' THEN
        candidates := candidates || ARRAY[item->'result'->'feedback'->>'userId',item->'result'->'donation'->>'userId',item->'result'->'incident'->>'userId']
          || ARRAY(SELECT user_id FROM public.product_feedback WHERE id=item->'result'->'feedback'->>'id')
          || ARRAY(SELECT user_id FROM public.product_donation_submissions WHERE id=item->'result'->'donation'->>'id')
          || ARRAY(SELECT user_id FROM public.product_operations_incidents WHERE id=item->'result'->'incident'->>'id');
      END IF;
    END IF;
    IF TG_TABLE_NAME IN ('reward_claims','product_donation_submissions') AND is_new AND
      (TG_OP='INSERT' OR item_new->'source_id' IS DISTINCT FROM item_old->'source_id') THEN
      candidates := candidates || ARRAY(SELECT user_id FROM public.reward_sources WHERE id=item->>'source_id');
    END IF;
    IF TG_TABLE_NAME='reward_registration_intents' THEN
      candidates := candidates || ARRAY(SELECT user_id FROM public.reward_registration_receipts WHERE registration_id=item->>'registration_id');
      IF is_new AND (TG_OP='INSERT' OR item_new->'invitation_digest' IS DISTINCT FROM item_old->'invitation_digest') THEN
        candidates := candidates || ARRAY(SELECT owner::text FROM public.account_invitation_codes WHERE code_digest=item->>'invitation_digest');
      END IF;
    END IF;
    IF TG_TABLE_NAME IN ('reward_audit','team_workspace_audits','product_operations_audits') AND is_new AND
      (TG_OP='INSERT' OR item_new->'subject_id' IS DISTINCT FROM item_old->'subject_id') THEN
      v := item->>'subject_id';
      candidates := candidates || ARRAY[v] || ARRAY(SELECT id::text FROM auth.users WHERE id::text=v)
        || ARRAY(SELECT owner FROM public.account_deletion_requests WHERE owner=v)
        || ARRAY(SELECT user_id FROM public.reward_sources WHERE id=v)
        || ARRAY(SELECT user_id FROM public.reward_claims WHERE id=v)
        || ARRAY(SELECT user_id FROM public.reward_registration_receipts WHERE registration_id=v)
        || ARRAY(SELECT user_id FROM public.team_workspace_members WHERE id=v AND user_id IS NOT NULL)
        || ARRAY(SELECT coach_id FROM public.team_workspaces WHERE id=v)
        || ARRAY(SELECT user_id FROM public.product_feedback WHERE id=v)
        || ARRAY(SELECT user_id FROM public.product_donation_submissions WHERE id=v)
        || ARRAY(SELECT user_id FROM public.product_operations_incidents WHERE id=v);
    END IF;
    IF TG_TABLE_NAME='community_comments' AND is_new AND
      (TG_OP='INSERT' OR item_new->'post_id' IS DISTINCT FROM item_old->'post_id') THEN
      candidates := candidates || ARRAY(SELECT owner_id FROM public.community_posts WHERE id=item->>'post_id');
    ELSIF TG_TABLE_NAME='community_reports' AND is_new AND
      (TG_OP='INSERT' OR item_new->'target_id' IS DISTINCT FROM item_old->'target_id' OR item_new->'target_kind' IS DISTINCT FROM item_old->'target_kind') THEN
      candidates := candidates || ARRAY(SELECT owner_id FROM public.community_posts WHERE id=item->>'target_id' AND item->>'target_kind'='post')
        || ARRAY(SELECT owner_id FROM public.community_comments WHERE id=item->>'target_id' AND item->>'target_kind'='comment');
    END IF;
    FOR v IN SELECT DISTINCT x FROM unnest(candidates) x WHERE x IS NOT NULL AND x<>'' ORDER BY x LOOP
      IF v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        CONTINUE;
      END IF;
      u := v::uuid;
      IF authorised IS NOT NULL AND u=authorised THEN CONTINUE; END IF;
      SELECT id INTO found_user FROM auth.users WHERE id=u FOR KEY SHARE;
      -- Preserve existing legacy/system identifiers and pre-create Auth hooks.
      -- This barrier fences known deletion receipts, not a new generic FK.
      IF EXISTS(SELECT 1 FROM public.account_deletion_requests
        WHERE barrier_digest=encode(sha256(convert_to(TG_ARGV[0]||'|'||v,'UTF8')),'hex')) THEN
        RAISE EXCEPTION 'account_deletion_fenced' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
'''.strip()


def barrier_manifest(service, runtime_role='postgres'):
    """Expected private function/trigger source for the existing SQL privacy gate."""
    _identity('10000000-0000-0000-0000-000000000001', service)
    if not re.fullmatch('[a-z_][a-z0-9_]{0,62}', runtime_role): _fail(status=422)
    direct = {}
    for name, model in _models().items():
        direct[name] = ','.join(c for c in ('owner_id','user_id','actor_id','coach_id','recipient_id','accepted_by','issuer_id','reporter_id','moderator_id','owner','inviter','invitee','inviter_id','invitee_id') if c in model.__table__.columns)
    direct.update({name: 'owner' for name in AUTH_TABLES})
    return {'schema': 'gxj_account_deletion', 'function': 'write_barrier', 'source': _barrier_body(),
            'securityDefiner': True, 'searchPath': 'pg_catalog', 'owner': runtime_role,
            'triggers': [{'table': name, 'name': 'gxj_account_deletion_guard', 'type': 31, 'enabled': 'O',
                          'args': [service, columns]} for name, columns in sorted(direct.items())]}


def barrier_sql(service, runtime_role='postgres'):
    """DDL text only; caller must use the normal reviewed migration workflow."""
    manifest = barrier_manifest(service, runtime_role)
    role = '"' + runtime_role + '"'
    head = f'''CREATE SCHEMA gxj_account_deletion AUTHORIZATION {role};
REVOKE ALL ON SCHEMA gxj_account_deletion FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE gxj_account_deletion.tx_authority (
 transaction_id bigint NOT NULL, backend_id integer NOT NULL, owner uuid NOT NULL,
 PRIMARY KEY(transaction_id,backend_id));
ALTER TABLE gxj_account_deletion.tx_authority OWNER TO {role};
ALTER TABLE gxj_account_deletion.tx_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gxj_account_deletion.tx_authority FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION gxj_account_deletion.write_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $gxj$
{manifest['source']}
$gxj$;
ALTER FUNCTION gxj_account_deletion.write_barrier() OWNER TO {role};
REVOKE ALL ON FUNCTION gxj_account_deletion.write_barrier() FROM PUBLIC, anon, authenticated, service_role;
'''
    return head + '\n'.join(f"CREATE TRIGGER gxj_account_deletion_guard BEFORE INSERT OR UPDATE OR DELETE ON public.{t['table']} FOR EACH ROW EXECUTE FUNCTION gxj_account_deletion.write_barrier('{service}','{t['args'][1]}');" for t in manifest['triggers']) + '\n'


def erase(db, owner, service, plan):
    """Erase only inspected bindings; does not commit, touch Auth, or call Storage."""
    current, rows, predicates, models = _inventory(db, owner, service)
    if type(plan) is not dict or plan.get('fingerprint') != current['fingerprint']:
        _fail('account_deletion_plan_changed')
    if current['blockers']: _fail('account_deletion_blocked')
    expected = [t['key'] for t in current['storageObjects']]
    confirmed = plan.get('storageVerifiedAbsent', [])
    if type(confirmed) is not list or sorted(confirmed) != sorted(expected) or len(confirmed) != len(set(confirmed)):
        _fail('account_deletion_storage_unconfirmed')
    pg = db.get_bind().dialect.name == 'postgresql'
    if pg:
        # Only the trusted DB service can insert here; browser API roles have no
        # privileges. Bound to the current transaction/backend and a pending job.
        result = db.execute(text('INSERT INTO gxj_account_deletion.tx_authority(transaction_id,backend_id,owner) SELECT txid_current(),pg_backend_pid(),CAST(:owner AS uuid) WHERE EXISTS(SELECT 1 FROM public.account_deletion_requests WHERE owner=CAST(:owner AS text) AND service=:service AND state=\'pending\')'), {'owner': owner, 'service': service})
        if result.rowcount != 1: _fail('account_deletion_authority_missing')
    def drop(name, predicate=None):
        db.execute(delete(models[name]).where(predicate if predicate is not None else predicates[name]).execution_options(synchronize_session=False))
    stamp = datetime.now(timezone.utc).isoformat(timespec='microseconds')
    member_ids = {r.id for r in rows['team_workspace_members']}
    owned_teams = {r.id for r in rows['team_workspaces']}
    live_peers = _peer_locks(db, owner, service, rows)
    member_owners = {r.id: r.user_id for r in rows['peer_team_members']}
    def live_member(r):
        peer = member_owners.get(r.member_id)
        return peer is None or peer in live_peers
    # Only mutable peer rows require a reread. Lock them after their Auth row,
    # and before changing any ORM instances, so newer values are never replaced
    # by an earlier inventory snapshot. Pending peers erase their own rows.
    for name, attribute in (('peer_reward_sources', 'user_id'), ('peer_reward_identities', 'user_id'),
            ('issued_peer_claims', 'user_id'), ('reward_requests', 'actor_id'),
            ('product_operations_requests', 'actor_id'), ('community_reports', 'reporter_id')):
        values = [r for r in rows[name] if getattr(r, attribute) == owner or getattr(r, attribute) in live_peers]
        if values:
            ownership = getattr(type(values[0]), attribute).in_(live_peers | {owner})
            rows[name] = _refresh_locked(db, values, and_(predicates[name], ownership))
        else: rows[name] = []
    for name in ('team_workspace_grants', 'team_workspace_invitations'):
        values = [r for r in rows[name] if r.member_id in member_ids or
            (name == 'team_workspace_invitations' and r.accepted_by == owner) or
            (live_member(r) and (name != 'team_workspace_invitations' or r.accepted_by is None or r.accepted_by in live_peers))]
        rows[name] = _refresh_locked(db, values, predicates[name])
    for name in ('team_workspace_notes', 'team_workspace_sessions'):
        values = [r for r in rows[name] if r.member_id in member_ids or
            (name == 'team_workspace_notes' and r.coach_id == owner)]
        rows[name] = _refresh_locked(db, values, predicates[name])
    for name in ('team_workspace_audits', 'reward_audit', 'product_operations_audits'):
        rows[name] = _refresh_locked(db, rows[name], predicates[name])
    for r in rows['team_workspaces']:
        r.coach_id, r.name = _anonymous_team(r.id), '待接管团队'
    for r in rows['team_workspace_grants']:
        if r.member_id in member_ids: db.delete(r)
        elif r.recipient_id == owner or r.team_id in owned_teams:
            r.active, r.recipient_id, r.version = False, _anonymous_team(r.team_id), r.version + 1
    for name in ('team_workspace_sessions', 'team_workspace_notes'):
        for r in rows[name]:
            if r.member_id in member_ids or name == 'team_workspace_notes' and r.coach_id == owner:
                db.delete(r)
    for r in rows['team_workspace_invitations']:
        if r.member_id in member_ids or r.accepted_by == owner: db.delete(r)
        elif r.team_id in owned_teams: r.expires_at = stamp
    for r in rows['team_workspace_audits']:
        if r.actor_id == owner: r.actor_id = ERASED
        if r.subject_id == owner: r.subject_id = ERASED
        r.reason = ''
    drop('team_workspace_owner'); drop('team_coach_applications')
    for r in rows['peer_reward_sources']:
        # An already-earned other person's reward remains active and manageable.
        r.details = {**r.details, 'counterpartyErased': True}
        r.version += 1
    changed_reward_owners = {r.user_id for r in rows['peer_reward_sources']}
    for r in rows['peer_reward_identities']:
        if r.user_id in changed_reward_owners: r.revision += 1
    for r in rows['issued_peer_claims']: r.issuer_id = ERASED
    # Keep spent request IDs as harmless receipts to prevent old admin retries.
    for r in rows['reward_requests']:
        if r.actor_id == owner: db.delete(r)
        else: r.result = {'requestId': r.request_id, 'status': 'unavailable'}
    for r in rows['reward_audit']:
        if r.actor_id == owner: r.actor_id = ERASED
        if r.subject_id == owner: r.subject_id = ERASED
        r.reason = ''
    for r in rows['product_operations_requests']:
        if r.actor_id == owner: db.delete(r)
        else: r.result = {'id': r.request_id, 'state': 'deleted', 'version': 1}
    for r in rows['product_operations_audits']:
        if r.actor_id == owner: r.actor_id = ERASED
        if r.subject_id == owner: r.subject_id = ERASED
        r.reason = ''
    for r in rows['community_reports']:
        if r.reporter_id == owner: db.delete(r)
        elif r.moderator_id == owner: r.moderator_id = None
    peer_post_ids = {r.post_id for r in rows['peer_comments']}
    # Comments have a real FK to posts. Remove our replies before any parent;
    # retain other people's replies under a content-free parent tombstone.
    drop('community_comments')
    for r in rows['community_posts']:
        if r.id in peer_post_ids:
            r.owner_id, r.body, r.status, r.revision = ERASED, '', 'deleted', r.revision + 1
            r.idempotency_key, r.request_hash = r.id, '0' * 64
        else: db.delete(r)
    db.flush()
    for r in rows['team_workspace_members']:
        # Detach only after deleting subject-owned notes/invitations: their
        # privacy DELETE guards still need the original membership binding.
        # Category stays unchanged for existing competition/group validity.
        r.user_id, r.label, r.status, r.version = None, '已注销成员', 'inactive', r.version + 1
    db.flush()
    # Explicit dependency order. Shared tables, peer sources/members/records,
    # Auth, finite-window SMS budgets and externally exported files are excluded.
    deletion_order = ('arrows', 'ends', 'training_sessions', 'plan_blocks', 'training_plans',
        'mobile_documents', 'score_backups', 'private_media_access', 'private_media_consent_events',
        'media_archive_records', 'private_media_objects', 'private_media_owners',
        'photo_contribution_deletions', 'photo_contribution_receipts', 'photo_contribution_samples', 'photo_contribution_choices',
        'reward_registration_intents', 'reward_registration_pairs', 'reward_registration_receipts',
        'account_invitation_attributions', 'account_invitation_codes', 'reward_claims', 'reward_claim_attempts',
        'reward_contacts', 'reward_sources', 'reward_identities', 'product_feedback', 'product_donation_submissions',
        'product_operations_incidents', 'community_comments', 'community_profiles', 'community_moderators', 'community_rate_windows')
    if pg:
        # Data-modifying CTEs retain one snapshot and run in dependency order.
        # The subquery reference makes the previous CTE complete first; FK
        # checks occur at the statement boundary. One bound network request.
        chain = []
        for name in (*deletion_order, *AUTH_TABLES):
            relation = models[name].__table__ if name in models else table(name, column('owner'))
            predicate = predicates[name] if name in models else cast(relation.c.owner, String) == owner
            if chain: predicate = and_(predicate, select(func.count()).select_from(chain[-1]).scalar_subquery() >= 0)
            chain.append(delete(relation).where(predicate).returning(literal(1)).cte('erase_'+name))
        db.execute(select(literal(1)).add_cte(*chain))
    else:
        for name in deletion_order: drop(name)
        for name in AUTH_TABLES:
            db.execute(text(f'DELETE FROM {name} WHERE owner=:owner'), {'owner': owner})
    db.flush()
    if pg:
        db.execute(text('DELETE FROM gxj_account_deletion.tx_authority WHERE transaction_id=txid_current() AND backend_id=pg_backend_pid() AND owner=CAST(:owner AS uuid)'), {'owner': owner})

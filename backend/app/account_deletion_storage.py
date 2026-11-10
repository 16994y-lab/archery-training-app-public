"""Exact-object account erasure using the existing private Storage service.

Targets are server-created, ownership-checked database snapshots. This port has
no list, prefix-delete, upload, or Storage-metadata-delete operation. Unknown
DELETE results are reconciled by the caller with inspect, never replayed here.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from urllib.parse import quote

from app.photo_contribution_storage import (
    SupabaseContributionStore, _object_missing,
    ContributionDeleteNotDispatched,
)
from app.supabase_private_media_store import APPROVED_ORIGIN, MAX_OBJECT_BYTES


_KEY_SHA256 = '76e96f89f390f1011df9aa3315f11b4cd4c6bffa98f75d0a2b5fbb627444267a'
_BUCKET = 'gongxingji-private-media'
_KINDS = frozenset({'private', 'contribution', 'archive', 'archive_copy', 'restored'})
_VERSION = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
_HEX32 = re.compile(r'[a-f0-9]{32}')
_HEX64 = re.compile(r'[a-f0-9]{64}')


class AccountStorageUnknown(Exception):
    """Fixed message only; never expose a provider body, key, URL, or object id."""

    def __init__(self):
        super().__init__('account-deletion-storage-unconfirmed')


class AccountDeletionStorage:
    def __init__(self, server_key, buckets, *, guard, transport=None):
        if (type(buckets) is not dict or not buckets or not callable(guard)
                or not set(buckets) <= _KINDS
                or any(type(v) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,62}', v)
                       for v in buckets.values())):
            raise AccountStorageUnknown()
        self.buckets = dict(buckets)
        self._guard = guard
        self._wires = {bucket: SupabaseContributionStore(
            APPROVED_ORIGIN, bucket, server_key, transport=transport,
            timeout_seconds=10, live_guard=guard,
        ) for bucket in set(buckets.values())}

    def __repr__(self):
        return '<AccountDeletionStorage exact-object-only>'

    def supports(self, target):
        """No I/O: reject unsupported bindings before accepting a deletion job."""
        try:
            self._target(target)
            return True
        except Exception:
            return False

    def _target(self, target):
        if type(target) is not dict or not self._guard():
            raise AccountStorageUnknown()
        kind = target.get('kind')
        bucket = target.get('bucket')
        path = target.get('path')
        object_id = target.get('objectId')
        size = target.get('expectedBytes')
        digest = target.get('sha256')
        # Restored copies are written in the archive bucket, as bound by the
        # archive manifest. They are not a separately configured destination.
        binding_kind = 'archive' if kind == 'restored' else kind
        if (kind not in _KINDS or binding_kind not in self.buckets
                or bucket != self.buckets[binding_kind]
                or type(path) is not str or type(object_id) is not str
                or not _HEX32.fullmatch(object_id)
                or type(size) is not int or not 1 <= size <= MAX_OBJECT_BYTES
                or type(digest) is not str or not _HEX64.fullmatch(digest)):
            raise AccountStorageUnknown()
        if kind == 'private':
            valid = path == f'objects/{object_id[:2]}/{object_id}'
        elif kind == 'contribution':
            valid = path == f'contributions/v1/{object_id[:2]}/{object_id}.png'
        elif kind in {'archive', 'archive_copy'}:
            valid = re.fullmatch(r'archives-v1/[a-f0-9]{64}/zips/' + object_id + r'\.zip', path) is not None
        else:
            valid = re.fullmatch(r'archives-v1/[a-f0-9]{64}/restored/[a-f0-9]{32}/' + object_id, path) is not None
        if not valid:
            raise AccountStorageUnknown()
        return self._wires[bucket], path, size, digest

    @staticmethod
    def _json(raw):
        try:
            def pairs(items):
                out = {}
                for key, value in items:
                    if key in out:
                        raise ValueError()
                    out[key] = value
                return out
            return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
        except Exception:
            raise AccountStorageUnknown() from None

    def inspect(self, target):
        try:
            wire, path, size, digest = self._target(target)
            # A hidden-object 404 is not absence. Authenticate the exact private
            # bucket with the original server credential before object lookup.
            wire._private_bucket()
            route = 'object/info/authenticated/' + wire.bucket + '/' + quote(path, safe='/')
            status, raw, _ = wire._request('GET', route)
            info = self._json(raw)
            if _object_missing(status, info):
                return None
            version = info.get('version') if type(info) is dict else None
            if (status != 200 or type(info) is not dict or info.get('name') != path
                    or info.get('bucket_id') != wire.bucket or info.get('size') != size
                    or info.get('is_delete_marker') is True
                    or type(version) is not str or not _VERSION.fullmatch(version)):
                raise AccountStorageUnknown()
            # Bind the immutable provider version to all expected bytes, not an
            # unverified ETag or a filename alone.
            status, content, _ = wire._request(
                'GET', 'object/authenticated/' + wire.bucket + '/' + quote(path, safe='/')
                + '?versionId=' + version, maximum=size)
            actual = hashlib.sha256(content).hexdigest()
            if (status != 200 or len(content) != size or not hmac.compare_digest(actual, digest)
                    or not self._guard()):
                raise AccountStorageUnknown()
            return {'version': version, 'bytes': size, 'sha256': actual}
        except Exception:
            raise AccountStorageUnknown() from None

    def remove(self, target, version):
        # The coordinator persists attempted + exact version BEFORE this call.
        # All pre-dispatch operations are reads; no implicit retry is performed.
        try:
            wire, path, _, _ = self._target(target)
            if type(version) is not str or not _VERSION.fullmatch(version):
                raise AccountStorageUnknown()
            wire._private_bucket()
            body = json.dumps({'prefixes': [{'path': path, 'versionId': version}]},
                              separators=(',', ':')).encode('utf-8')
        except Exception:
            return {'status': 'not_dispatched'}
        try:
            status, raw, _ = wire._request('DELETE', 'object/' + wire.bucket, body, 'application/json')
            value = self._json(raw)
            if (status != 200 or type(value) is not list or len(value) != 1
                    or type(value[0]) is not dict or value[0].get('name') != path
                    or value[0].get('version') != version):
                return {'status': 'unknown'}
            return {'status': 'deleted'}
        except ContributionDeleteNotDispatched:
            return {'status': 'not_dispatched'}
        except Exception:
            return {'status': 'unknown'}


def configured_account_deletion_storage():
    """Original trusted process only. Configuration is not a claim of deletion.

Bucket privacy and object/version/bytes are freshly read for each operation.
No credentials are copied to a local runner, response, receipt or log. New
archive locations require explicit server configuration, never caller input.
"""
    try:
        # The admission flag only closes NEW confirmations. An already accepted
        # deletion keeps its original capability and must remain resumable.
        def available():
            return (os.getenv('GONGXINGJI_SERVERLESS_DB') == '1'
                    or os.getenv('ACCOUNT_DELETION_ENABLED') == '1')

        if (not available()
                or os.getenv('SUPABASE_URL', '').rstrip('/') != APPROVED_ORIGIN):
            return None
        key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
        expected = os.environ.get('ACCOUNT_DELETION_STORAGE_KEY_SHA256', _KEY_SHA256)
        if not _HEX64.fullmatch(expected) or hashlib.sha256(key.encode()).hexdigest() != expected:
            return None
        raw = os.environ.get('ACCOUNT_DELETION_STORAGE_BUCKETS')
        buckets = json.loads(raw) if raw else {'private': _BUCKET, 'contribution': _BUCKET}
        snapshot = json.dumps(buckets, sort_keys=True, separators=(',', ':'))

        def live():
            current = os.environ.get('ACCOUNT_DELETION_STORAGE_BUCKETS')
            try:
                mapping = json.loads(current) if current else {'private': _BUCKET, 'contribution': _BUCKET}
                return (available()
                        and os.getenv('SUPABASE_URL', '').rstrip('/') == APPROVED_ORIGIN
                        and os.environ.get('ACCOUNT_DELETION_STORAGE_KEY_SHA256', _KEY_SHA256) == expected
                        and hashlib.sha256(os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').encode()).hexdigest() == expected
                        and json.dumps(mapping, sort_keys=True, separators=(',', ':')) == snapshot)
            except Exception:
                return False

        return AccountDeletionStorage(key, buckets, guard=live)
    except Exception:
        return None

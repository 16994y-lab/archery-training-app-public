"""OFFLINE ARCHITECTURE CANDIDATE: one relay POST, never a direct fallback.

The original SDK signs and parses. The Edge must cryptographically authenticate
OIDC and durably claim the signature before dispatch; this module cannot grant
it that authority. No environment credential fallback is present. Diagnostics contain only closed
phase classifications and the hash of a random per-attempt identifier.
"""
from __future__ import annotations
import asyncio
import base64
import contextvars
import hashlib
import json
import logging
import math
import os
import re
import secrets
import time
from pathlib import Path
from types import FunctionType
from urllib.parse import urlsplit, parse_qsl

TRANSPORT_SHA256 = 'd6b343f09636da3d3f6fa355aafffeb0b75b70faf93e4094ed7c1aa38be84da2'
RELAY_URL = 'https://auth-4.example.invalid/functions/v1/gxj-sms-relay-candidate'
MAX_REQUEST_BYTES = 24576
MAX_RESPONSE_BYTES = 50000
MAX_PROVIDER_BYTES = 32768
_IDENTITY = contextvars.ContextVar('gxj_sms_relay_identity', default=None)
_HEX64 = re.compile(r'[0-9a-f]{64}\Z')
_TOKEN = re.compile(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z')
_HEADERS = frozenset(('Authorization', 'accept', 'host', 'user-agent',
    'x-acs-action', 'x-acs-content-sha256', 'x-acs-credentials-provider',
    'x-acs-date', 'x-acs-signature-nonce', 'x-acs-version'))
_QUERY = frozenset(('AutoRetry', 'CountryCode', 'Interval', 'PhoneNumber',
    'ReturnVerifyCode', 'SignName', 'TemplateCode', 'TemplateParam'))
_REASONS = frozenset(('response_received', 'deadline_before_fetch',
    'duplicate_or_unclaimed', 'claim_unknown', 'dispatch_or_response_unknown',
    'prepare_failed_before_fetch'))


class RelayUnknown(Exception):
    """Fixed exception only; no upstream body, token or URL attached."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True, allow_nan=False).encode('ascii')


_LOGGER = logging.getLogger(__name__)
# Exact fixed public-code whitelist inherited from formal sms_hook.py.
_DIAGNOSTIC_PROVIDER_CODES = frozenset(['BUSINESS_LIMIT_CONTROL', 'CreateFail.SmsCode', 'EntityNotExist.SmsSignName', 'EntityNotExist.SmsTemplateCode', 'FREQUENCY_FAIL', 'FUNCTION_NOT_OPENED', 'Forbidden.RAM', 'INVALID_PARAMETERS', 'InvalidAccessKeyId.NotFound', 'InvalidParameter.SmsTemplateCode', 'LimitExceeded.SmsCode', 'MOBILE_NUMBER_ILLEGAL', 'OK', 'SignatureDoesNotMatch', 'biz.FREQUENCY', 'isp.QPS_LIMIT', 'isp.RAM_PERMISSION_DENY', 'isp.RES_OWNER_ID_UNKNOWN', 'isp.SYSTEM_ERROR', 'isp.UNKNOWN', 'isv.ACCOUNT_ABNORMAL', 'isv.ACCOUNT_NOT_EXISTS', 'isv.BUSINESS_LIMIT_CONTROL', 'isv.FORBIDDEN_ACTION', 'isv.INVALID_PARAMETERS', 'isv.MOBILE_NUMBER_ILLEGAL', 'isv.OUT_OF_SERVICE', 'isv.PRODUCT_UNSUBSCRIBE', 'isv.PRODUCT_UN_SUBSCRIPT', 'isv.RAM_PERMISSION_DENY'])


def _provider_shape(body, status):
    """Diagnostic only: never interpret acceptance or expose provider values."""
    result = {'httpStatus': status if type(status) is int and 100 <= status <= 599 else None,
              'bodyKind': 'invalid_json', 'codeKeys': 'missing',
              'codeUpper': 'missing', 'codeLower': 'missing',
              'codeCategoryUpper': 'missing', 'codeCategoryLower': 'missing',
              'successKeys': 'missing', 'successUpper': 'missing', 'successLower': 'missing'}
    try:
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value: raise ValueError()
                value[key] = item
            return value
        def finite(_): raise ValueError()
        value = json.loads(body, object_pairs_hook=unique, parse_constant=finite)
        if type(value) is not dict:
            result['bodyKind'] = 'non_object'
            return result
        result['bodyKind'] = 'object'
        for upper, lower, prefix in (('Code', 'code', 'code'), ('Success', 'success', 'success')):
            result[prefix + 'Keys'] = ('both' if upper in value and lower in value else
                                      'upper' if upper in value else 'lower' if lower in value else 'missing')
            for key, suffix in ((upper, 'Upper'), (lower, 'Lower')):
                if key not in value: continue
                item = value[key]
                if prefix == 'code':
                    result['codeCategory' + suffix] = item if type(item) is str and item in _DIAGNOSTIC_PROVIDER_CODES else 'unknown'
                    result[prefix + suffix] = ('ok' if type(item) is str and item == 'OK' else
                        'string_200' if type(item) is str and item == '200' else
                        'number_200' if type(item) in (int, float) and item == 200 else 'unknown')
                else:
                    result[prefix + suffix] = ('true' if item is True else 'false' if item is False else 'invalid_type')
    except BaseException:
        pass
    return result


def _phase_observer():
    # Independent clock: observational reads never advance the functional clock.
    try: started = time.monotonic()
    except BaseException: started = None
    trace = None
    def emit(stage, *, attempt=None, outcome=None, provider=None):
        nonlocal trace
        try:
            if attempt is not None:
                trace = hashlib.sha256(attempt.encode('ascii')).hexdigest()
            elapsed = None if started is None else int((time.monotonic() - started) * 1000)
            if elapsed is not None: elapsed = max(0, min(300000, elapsed))
            event = {'schema': 'gxj-sms-relay-client-v1', 'stage': stage,
                     'elapsedMs': elapsed, 'attemptHash': trace, 'outcome': outcome}
            if provider is not None: event['providerShape'] = provider
            _LOGGER.warning(json.dumps(event, separators=(',', ':'), allow_nan=False))
        except BaseException:
            # Diagnostic handlers, formatters and clocks must not affect sending.
            pass
    return emit


def _not_dispatched():
    from app.aliyun_sms_transport import SmsNotDispatched
    return SmsNotDispatched()


def _not_dispatched_permanent():
    from app.aliyun_sms_transport import SmsNotDispatchedPermanent
    return SmsNotDispatchedPermanent()


def identity_from_headers(headers):
    values = [v for k, v in headers if k == b'x-vercel-oidc-token']
    if len(values) != 1 or type(values[0]) is not bytes or not 40 <= len(values[0]) <= 16000:
        return None
    try:
        value = values[0].decode('ascii')
    except UnicodeError:
        return None
    return value if _TOKEN.fullmatch(value) else None


class RelayIdentityMiddleware:
    """Read the actual invocation header; Edge verifies its signature/claims."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        token = None
        if (os.getenv('GONGXINGJI_SMS_RELAY_ENABLED') == '1'
                and scope.get('type') == 'http' and scope.get('method') == 'POST'
                and scope.get('path') == '/auth/hooks/send-sms'):
            token = identity_from_headers(scope.get('headers', []))
        handle = _IDENTITY.set(token)
        try:
            await self.app(scope, receive, send)
        finally:
            _IDENTITY.reset(handle)


def signed_request(request, runtime):
    from app import aliyun_sms_transport as formal
    from darabonba.core import DaraCore
    formal._validate_request(request, runtime)
    if type(request.headers) is not dict or set(request.headers) != _HEADERS:
        raise _not_dispatched_permanent()
    if any(type(v) is not str or not re.fullmatch(r'[\x20-\x7e]{1,4096}', v)
           for v in request.headers.values()):
        raise _not_dispatched_permanent()
    url = DaraCore.compose_url(request)
    if type(url) is not str or not re.fullmatch(r'[\x21-\x7e]{1,15999}', url):
        raise _not_dispatched_permanent()
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc != formal.HOST
            or parsed.path != '/' or parsed.fragment):
        raise _not_dispatched_permanent()
    pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    query_keys = {k for k, _ in pairs}
    if len(pairs) != len(query_keys) or query_keys not in (_QUERY, _QUERY | {'OutId'}):
        raise _not_dispatched_permanent()
    query = dict(pairs)
    if 'OutId' in query and not _HEX64.fullmatch(query['OutId']):
        raise _not_dispatched_permanent()
    if any(not 1 <= len(v) <= 4096 for v in query.values()):
        raise _not_dispatched_permanent()
    if (query['AutoRetry'] != '0' or query['CountryCode'] != '86'
            or query['Interval'] != '1' or query['ReturnVerifyCode'] != 'False'):
        raise _not_dispatched_permanent()
    return {'url': url, 'headers': dict(request.headers)}


def decode_response(raw, expected_attempt, expected_digest):
    from darabonba.response import DaraResponse
    try:
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        def finite(_):
            raise ValueError()
        if type(raw) is not bytes or len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=finite)
        if (type(value) is not dict or set(value) !=
                {'version', 'attemptId', 'requestSHA256', 'outcome', 'provider', 'reason'}
                or type(value['version']) is not int or value['version'] != 1
                or value['attemptId'] != expected_attempt
                or value['requestSHA256'] != expected_digest
                or value['reason'] not in _REASONS):
            raise ValueError()
        if value['outcome'] == 'before_dispatch':
            if (value['reason'] not in {'deadline_before_fetch', 'prepare_failed_before_fetch'}
                    or value['provider'] is not None):
                raise ValueError()
            return None
        if value['outcome'] != 'provider_response' or value['reason'] != 'response_received':
            raise ValueError()
        p = value['provider']
        if (type(p) is not dict or set(p) != {'status', 'bodyBase64', 'headers'}
                or type(p['status']) is not int or not (200 <= p['status'] <= 299 or 400 <= p['status'] <= 599)
                or type(p['bodyBase64']) is not str or len(p['bodyBase64']) > 43692
                or type(p['headers']) is not dict
                or not set(p['headers']) <= {'content-type', 'x-acs-request-id'}
                or any(type(v) is not str or not re.fullmatch(r'[\x20-\x7e]{1,256}', v)
                       for v in p['headers'].values())):
            raise ValueError()
        body = base64.b64decode(p['bodyBase64'], validate=True)
        if len(body) > MAX_PROVIDER_BYTES:
            raise ValueError()
        result = DaraResponse()
        result.status_code, result.headers, result.body = p['status'], p['headers'], body
        result.status_message = ''
        return result
    except Exception:
        raise RelayUnknown() from None


async def _post_once(payload, token, deadline):
    import aiohttp
    loop = asyncio.get_running_loop()
    remaining = deadline - loop.time()
    if remaining <= 0:
        raise _not_dispatched()
    timeout = aiohttp.ClientTimeout(total=remaining, connect=remaining, sock_read=remaining)
    # Calling request may have reached Edge. Every subsequent ambiguous failure
    # remains unknown, including connection failures and caller cancellation.
    async with aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar()) as session:
        async with session.post(RELAY_URL, data=payload,
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                proxy=None, allow_redirects=False, timeout=timeout) as response:
            if response.status != 200:
                raise RelayUnknown()
            raw = bytearray()
            async for chunk in response.content.iter_chunked(16384):
                raw.extend(chunk)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise RelayUnknown()
            return bytes(raw)


def _sender(deadline, token):
    from app import aliyun_sms_transport as formal
    loop = asyncio.get_running_loop()
    used = False

    async def send(request, runtime, supplied_deadline):
        nonlocal used
        if used or supplied_deadline != deadline:
            raise RelayUnknown()
        used = True
        observe = _phase_observer()
        try:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise _not_dispatched()
            wire = {'version': 1, 'attemptId': secrets.token_hex(32),
                    'deadlineUnixMs': math.floor((time.time() + remaining) * 1000),
                    'signedRequest': signed_request(request, runtime)}
            payload = canonical(wire)
            if len(payload) > MAX_REQUEST_BYTES:
                raise _not_dispatched_permanent()
            observe('wire_ready', attempt=wire['attemptId'])
        except (formal.SmsNotDispatched, formal.SmsNotDispatchedPermanent):
            observe('relay_result', outcome='before_dispatch')
            raise
        except Exception:
            observe('relay_result', outcome='before_dispatch')
            raise _not_dispatched_permanent() from None
        try:
            async with asyncio.timeout_at(deadline) as timer:
                observe('relay_post')
                raw = await _post_once(payload, token, deadline)
                # Cancellation may fire within clock resolution before its deadline.
                # A dependency swallowing it must not produce a usable late proof.
                if timer.expired() or loop.time() >= deadline:
                    raise RelayUnknown()
                result = decode_response(raw, wire['attemptId'], hashlib.sha256(payload).hexdigest())
        except asyncio.CancelledError:
            observe('relay_result', outcome='cancelled_unknown')
            raise
        except formal.SmsNotDispatched:
            # _post_once can prove its deadline expired before opening a session.
            # Preserve only that explicit proof; network/response errors stay unknown.
            observe('relay_result', outcome='before_dispatch')
            raise
        except Exception:
            observe('relay_result', outcome='unknown')
            raise RelayUnknown() from None
        if result is None:
            observe('relay_result', outcome='before_dispatch')
            raise _not_dispatched()
        observe('relay_result', outcome='provider_response',
                provider=_provider_shape(result.body, result.status_code))
        return result
    return send


def _route_for_attempt(retry_attempt, *, relay_enabled):
    """Pure internal policy; the caller must use the committed gate ordinal."""
    if (type(relay_enabled) is not bool or
            (retry_attempt is not None and
             (type(retry_attempt) is not int or not 1 <= retry_attempt <= 5))):
        raise _not_dispatched_permanent()
    return 'native' if not relay_enabled or retry_attempt == 1 else 'relay'


def bind_transport(client, deadline, *, retry_attempt=None):
    """Same official binder with a private IO binding, not a global monkeypatch."""
    from app import aliyun_sms_transport as formal
    if hashlib.sha256(Path(formal.__file__).read_bytes()).hexdigest() != TRANSPORT_SHA256:
        raise _not_dispatched_permanent()
    route = _route_for_attempt(retry_attempt,
                               relay_enabled=os.getenv('GONGXINGJI_SMS_RELAY_ENABLED') == '1')
    # One branch is selected before any relay attempt. This is a rollout switch,
    # never a recovery fallback after a relay error or uncertain dispatch.
    # Only the committed gate receipt supplies this ordinal. A new Hook after
    # a verified, durable unsent attempt may choose relay; never within this Hook.
    if route == 'native':
        return formal.bind_transport(client, deadline)
    token = _IDENTITY.get()
    if type(token) is not str or not 40 <= len(token) <= 16000 or not _TOKEN.fullmatch(token):
        raise _not_dispatched_permanent()
    loop = asyncio.get_running_loop()
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise _not_dispatched_permanent()
    remaining = deadline - loop.time()
    if remaining <= 0:
        raise _not_dispatched()
    if remaining > 3.5:
        raise _not_dispatched_permanent()
    original = formal.bind_transport
    globals_copy = dict(original.__globals__)
    globals_copy['send_signed_request'] = _sender(deadline, token)
    private = FunctionType(original.__code__, globals_copy, original.__name__,
                           original.__defaults__, original.__closure__)
    private.__kwdefaults__ = original.__kwdefaults__
    return private(client, deadline)

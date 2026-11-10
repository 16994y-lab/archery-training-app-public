"""Isolated Supabase Send SMS HTTP Hook; disabled without an explicit gate."""

from __future__ import annotations

import base64
import asyncio
import binascii
import hashlib
import hmac
import json
import inspect
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Mapping, Protocol

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse


MAX_BODY_BYTES = 16_384
SIGNATURE_AGE_SECONDS = 300
PHONE_INTERVAL_SECONDS = 60
# Provider throttling is separate from the application admission interval.
PROVIDER_INTERVAL_SECONDS = 1
# The Supabase HTTP Hook has a five-second response window. Keep time for
# cold-start/network overhead; if reservation was slow, do not begin a send.
MAX_PRE_SEND_ELAPSED_SECONDS = 1.0
HOOK_RESPONSE_BUDGET_SECONDS = 4.5
HOOK_FINALIZE_RESERVE_SECONDS = 0.75
# The async transport races resolved addresses. Bound the entire SDK await,
# including DNS, TCP/TLS and reading; never fall back to a second send.
ALIYUN_CONNECT_TIMEOUT_MS = 2500
ALIYUN_READ_TIMEOUT_MS = 2000
ALIYUN_SEND_DEADLINE_SECONDS = 3.5
_PHONE_RE = re.compile(r"\+?861[3-9][0-9]{9}\Z", re.ASCII)
_OTP_RE = re.compile(r"[0-9]{6}\Z", re.ASCII)
_WEBHOOK_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}\Z", re.ASCII)
_LOGGER = logging.getLogger(__name__)
# Only fixed codes from the provider's public contract may enter diagnostics.
# Never log Message, AccessDeniedDetail, request/response objects or exceptions.
_SAFE_PROVIDER_CODES = frozenset({
    "OK", "MOBILE_NUMBER_ILLEGAL", "BUSINESS_LIMIT_CONTROL", "FREQUENCY_FAIL",
    "INVALID_PARAMETERS", "FUNCTION_NOT_OPENED", "isv.RAM_PERMISSION_DENY",
    "isp.RAM_PERMISSION_DENY", "isv.PRODUCT_UNSUBSCRIBE", "isv.PRODUCT_UN_SUBSCRIPT",
    "isv.OUT_OF_SERVICE", "isv.MOBILE_NUMBER_ILLEGAL", "isv.INVALID_PARAMETERS",
    "isv.FORBIDDEN_ACTION", "isv.ACCOUNT_NOT_EXISTS", "isv.ACCOUNT_ABNORMAL",
    "isp.UNKNOWN", "isp.SYSTEM_ERROR", "isp.RES_OWNER_ID_UNKNOWN", "isp.QPS_LIMIT",
    "InvalidParameter.SmsTemplateCode", "EntityNotExist.SmsTemplateCode",
    "EntityNotExist.SmsSignName", "LimitExceeded.SmsCode", "CreateFail.SmsCode",
    "biz.FREQUENCY", "isv.BUSINESS_LIMIT_CONTROL",
    "InvalidAccessKeyId.NotFound", "SignatureDoesNotMatch", "Forbidden.RAM",
})
_SAFE_EXCEPTION_CATEGORIES = {
    ("requests.exceptions", "ConnectTimeout"): "timeout",
    ("requests.exceptions", "ReadTimeout"): "timeout",
    ("requests.exceptions", "Timeout"): "timeout",
    ("requests.exceptions", "SSLError"): "tls_error",
    ("requests.exceptions", "ConnectionError"): "connection_error",
    ("requests.exceptions", "InvalidURL"): "request_configuration",
    ("requests.exceptions", "InvalidHeader"): "request_configuration",
    ("aiohttp.client_exceptions", "ConnectionTimeoutError"): "timeout",
    ("aiohttp.client_exceptions", "SocketTimeoutError"): "timeout",
    ("aiohttp.client_exceptions", "ServerTimeoutError"): "timeout",
    ("aiohttp.client_exceptions", "ClientConnectorError"): "connection_error",
    ("aiohttp.client_exceptions", "ClientConnectorDNSError"): "connection_error",
    ("aiohttp.client_exceptions", "ClientConnectorSSLError"): "tls_error",
    ("aiohttp.client_exceptions", "ClientConnectorCertificateError"): "tls_error",
    ("darabonba.exceptions", "UnretryableException"): "sdk_wrapper",
    ("darabonba.exceptions", "RetryError"): "sdk_wrapper",
    ("darabonba.exceptions", "DaraException"): "sdk_error",
    ("darabonba.exceptions", "ResponseException"): "sdk_error",
    ("darabonba.exceptions", "ValidateException"): "request_configuration",
    ("darabonba.exceptions", "RequiredArgumentException"): "request_configuration",
    ("Tea.exceptions", "TeaException"): "sdk_error",
    ("Tea.exceptions", "UnretryableException"): "sdk_wrapper",
    ("Tea.exceptions", "RequiredArgumentException"): "request_configuration",
    ("alibabacloud_tea_openapi.exceptions._client", "ClientException"): "sdk_error",
    ("alibabacloud_tea_openapi.exceptions._server", "ServerException"): "sdk_error",
    ("alibabacloud_tea_openapi.exceptions._throttling", "ThrottlingException"): "sdk_error",
    ("builtins", "ValueError"): "value_error",
    ("builtins", "TypeError"): "type_error",
    ("builtins", "AttributeError"): "attribute_error",
}


def _diagnostic_errors(error):
    """Visit a bounded exception chain without reading messages or SDK payloads."""
    pending, seen, errors = [error], set(), []
    while pending and len(seen) < 8:
        current = pending.pop(0)
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        errors.append(current)
        for field in ("inner_exception", "__cause__", "__context__"):
            child = getattr(current, field, None)
            if isinstance(child, BaseException):
                pending.append(child)
    return errors


def _exception_category(error) -> str:
    if isinstance(error, ImportError):
        return "sdk_import"
    if isinstance(error, TimeoutError):
        return "timeout"
    return _SAFE_EXCEPTION_CATEGORIES.get(
        (type(error).__module__, type(error).__name__), "other_error")


def _provider_diagnostic(started: float, stage: str, *, response=None, error=None) -> None:
    # Logging must never change a provider result or hide its original failure.
    try:
        _emit_provider_diagnostic(started, stage, response=response, error=error)
    except Exception:
        pass


def _outcome_diagnostic(outcome, reason):
    try:
        _LOGGER.warning('sms_outcome_recording %s', json.dumps({
            'event':'sms_outcome_recording','observed':outcome,
            'recording':'unconfirmed','reason':reason},separators=(',',':')))
    except Exception:
        pass


def _emit_provider_diagnostic(started: float, stage: str, *, response=None, error=None) -> None:
    """Emit bounded, non-identifying fields only; never stringify SDK data."""
    errors = _diagnostic_errors(error) if error is not None else []
    source = getattr(response, "body", None)
    safe_code, status = "UNKNOWN", None
    for item in errors or [source]:
        code = getattr(item, "code", None)
        if type(code) is str and code in _SAFE_PROVIDER_CODES:
            safe_code = code
            break
    for item in errors or [response]:
        # Some older Dara exceptions expose statusCode instead of status_code.
        for field in ("status_code", "statusCode"):
            value = getattr(item, field, None)
            if type(value) is int and 100 <= value <= 599:
                status = value
                break
        if status is not None:
            break
    success = getattr(source, "success", None)
    success = success if type(success) is bool else None
    categories = [_exception_category(item) for item in errors]
    category = "none" if error is None else "other_error"
    # Prefer a specific nested failure to its generic SDK wrapper. Export only
    # fixed categories, never arbitrary exception module/class names or text.
    for preferred in ("sdk_import", "request_configuration", "timeout", "tls_error",
                      "connection_error", "value_error", "type_error", "attribute_error",
                      "sdk_error", "sdk_wrapper"):
        if preferred in categories:
            category = preferred
            break
    record = {
        "event": "sms_provider", "stage": stage if stage in {"setup", "send"} else "unknown",
        "elapsed_ms": max(0, min(300_000, int((time.monotonic() - started) * 1000))),
        "http_status": status, "provider_code": safe_code, "provider_success": success,
        "exception_category": category, "exception_chain": categories,
        "timeout_phase": next((phase for item in errors for signature, phase in (
            (("requests.exceptions", "ConnectTimeout"), "connect"),
            (("requests.exceptions", "ReadTimeout"), "read"),
            (("aiohttp.client_exceptions", "ConnectionTimeoutError"), "connect"),
            (("aiohttp.client_exceptions", "SocketTimeoutError"), "read"),
        ) if (type(item).__module__, type(item).__name__) == signature),
            "unspecified" if category == "timeout" else "none"),
    }
    _LOGGER.warning("sms_provider %s", json.dumps(record, separators=(",", ":")))


class SmsHookTimingMiddleware:
    """Stamp the SMS ASGI arrival before dependencies; never cancel DB threads.

    This cannot measure gateway/network/cold-start time before ASGI invocation.
    No header or request body is used to set the server-owned monotonic clock.
    """

    def __init__(self, app, elapsed_clock=time.monotonic):
        self.app = app
        self.elapsed_clock = elapsed_clock

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and scope.get('path') == '/auth/hooks/send-sms':
            scope.setdefault('state', {})['_gxj_sms_started'] = self.elapsed_clock()
        await self.app(scope, receive, send)


class InvalidHookSignature(Exception):
    pass


class GateUnavailable(Exception):
    pass


class GateRejected(Exception):
    def __init__(self, reason='policy', retry_after_seconds=None):
        self.reason=reason if reason in {'recipient','duplicate','total','day','phone_day','cooldown','month','capacity_expired'} else 'policy'
        self.retry_after_seconds = retry_after_seconds if type(retry_after_seconds) is int and 0 <= retry_after_seconds <= 60 else None
        super().__init__(self.reason)


class ProviderRejected(Exception):
    """An explicit, documented provider rejection; never a network timeout."""


class ProviderNotDispatched(ProviderRejected):
    """Exact transport proof that no HTTP headers were written."""


class ProviderNotDispatchedPermanent(Exception):
    """Proven unsent, without permission to advance the automatic retry."""


class ProviderAcceptedLate(TimeoutError):
    """Positive acceptance was observed after the safe acknowledgement window."""


_DEFINITE_REJECTION_CODES = frozenset({
    'MOBILE_NUMBER_ILLEGAL', 'BUSINESS_LIMIT_CONTROL', 'FREQUENCY_FAIL',
    'INVALID_PARAMETERS', 'FUNCTION_NOT_OPENED',
})


def _provider_outcome(response):
    body = getattr(response, 'body', None)
    status, code, success = (getattr(response, 'status_code', None),
                             getattr(body, 'code', None), getattr(body, 'success', None))
    if status == 200 and code == 'OK' and success is True:
        return True  # PNVS request accepted, never evidence of handset delivery.
    if status in {200, 400} and code in _DEFINITE_REJECTION_CODES and success is False:
        raise ProviderRejected from None
    return False  # Missing, contradictory or unrecognised fields remain unknown.


class SmsTransport(Protocol):
    def __call__(self, phone: str, otp: str, settings: SmsHookSettings) -> bool | Awaitable[bool]: ...


class SendGate(Protocol):
    def reserve(self, webhook_id: str, phone: str, now: float) -> None:
        """Atomically reserve one event and enforce phone and cost limits."""

    def finish(self, webhook_id: str, outcome: str, now: float) -> None:
        """Record exactly one explicit outcome without replaying the send."""


@dataclass(frozen=True)
class SmsHookSettings:
    enabled: bool = False
    signing_secrets: str = ""
    access_key_id: str = ""
    access_key_secret: str = ""
    sign_name: str = ""
    template_code: str = ""
    code_param: str = "code"
    minute_param: str = ""
    template_minutes: int = 0
    expected_otp_expiry_seconds: int = 0

    @classmethod
    def from_env(cls) -> SmsHookSettings:
        return cls(
            enabled=os.getenv("SMS_HOOK_ENABLED") == "1",
            signing_secrets=os.getenv("SUPABASE_SEND_SMS_HOOK_SECRET", ""),
            access_key_id=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID", ""),
            access_key_secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", ""),
            sign_name=os.getenv("ALIYUN_SMS_SIGN_NAME", ""),
            template_code=os.getenv("ALIYUN_SMS_TEMPLATE_CODE", ""),
            code_param=os.getenv("ALIYUN_SMS_CODE_PARAM", "code"),
            minute_param=os.getenv("ALIYUN_SMS_MINUTE_PARAM", ""),
            template_minutes=_positive_int(os.getenv("ALIYUN_SMS_TEMPLATE_MINUTES", "")),
            expected_otp_expiry_seconds=_positive_int(
                os.getenv("SMS_HOOK_SUPABASE_OTP_EXPIRY_SECONDS", "")),
        )

    def ready(self) -> bool:
        if not all((self.signing_secrets, self.access_key_id,
                    self.access_key_secret, self.sign_name, self.template_code)):
            return False
        if self.code_param != "code" or self.minute_param != "min":
            return False
        if not (1 <= self.template_minutes <= 60
                and self.expected_otp_expiry_seconds == self.template_minutes * 60):
            return False
        try:
            _decoded_secrets(self.signing_secrets)
        except ValueError:
            return False
        return True


def _positive_int(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0


def _decoded_secrets(configured: str) -> tuple[bytes, ...]:
    """Supabase secrets are `v1,whsec_<base64>`, separated by `|` on rotation."""
    values = configured.split("|")
    if not values or len(values) > 3:
        raise ValueError("invalid hook signing configuration")
    result = []
    for value in values:
        if not value.startswith("v1,whsec_"):
            raise ValueError("invalid hook signing configuration")
        encoded = value[len("v1,whsec_"):]
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("invalid hook signing configuration") from error
        if not 24 <= len(decoded) <= 64:
            raise ValueError("invalid hook signing configuration")
        result.append(decoded)
    return tuple(result)


def verify_standard_webhook(raw_body: bytes, headers: Mapping[str, str],
                            configured_secrets: str, now: float) -> str:
    """Verify the raw-body HMAC defined by Standard Webhooks/Supabase HTTP Hooks."""
    normalized = {key.lower(): value for key, value in headers.items()}
    webhook_id = normalized.get("webhook-id", "")
    timestamp = normalized.get("webhook-timestamp", "")
    signature_header = normalized.get("webhook-signature", "")
    if not _WEBHOOK_ID_RE.fullmatch(webhook_id) or not timestamp.isascii() or not timestamp.isdecimal():
        raise InvalidHookSignature
    if len(timestamp) > 12 or abs(now - int(timestamp)) > SIGNATURE_AGE_SECONDS:
        raise InvalidHookSignature
    if not signature_header or len(signature_header) > 1024:
        raise InvalidHookSignature
    signatures = []
    for part in signature_header.split(" "):
        if not part.startswith("v1,"):
            continue
        try:
            signature = base64.b64decode(part[3:], validate=True)
        except (binascii.Error, ValueError):
            continue
        if len(signature) == hashlib.sha256().digest_size:
            signatures.append(signature)
    if not signatures:
        raise InvalidHookSignature
    signed = webhook_id.encode("ascii") + b"." + timestamp.encode("ascii") + b"." + raw_body
    # Check every configured key and supplied v1 signature; a valid old key is
    # accepted during Supabase's documented key rotation window.
    valid = False
    for secret in _decoded_secrets(configured_secrets):
        expected = hmac.digest(secret, signed, "sha256")
        for signature in signatures:
            valid |= hmac.compare_digest(expected, signature)
    if not valid:
        raise InvalidHookSignature
    return webhook_id


def canonical_mainland_phone(value: object) -> str | None:
    """Accept signed Auth phone storage or E.164 form; keep one quota identity."""
    if not isinstance(value, str) or not _PHONE_RE.fullmatch(value):
        return None
    return value if value.startswith("+") else "+" + value


def _signed_sms(raw_body: bytes) -> tuple[str, str]:
    try:
        payload = json.loads(raw_body)
        user = payload["user"]
        sms = payload["sms"]
        # Recent Auth includes the actual destination in sms.phone. For changes,
        # user.phone is the old number; never fall back to it when new_phone exists.
        destination = sms.get('phone')
        if destination is None:
            if user.get('new_phone'):
                raise HTTPException(400,'短信目标号码尚未明确，未发送')
            destination=user.get('phone')
        phone = canonical_mainland_phone(destination)
        otp = sms["otp"]
    except (UnicodeDecodeError, ValueError, TypeError, KeyError):
        raise HTTPException(400, "短信请求格式无效") from None
    if phone is None:
        raise HTTPException(400, "短信请求格式无效")
    if not isinstance(otp, str) or not _OTP_RE.fullmatch(otp):
        raise HTTPException(400, "短信请求格式无效")
    return phone, otp


class RejectingSendGate:
    """Fail closed until an atomic shared store and a cost cap are provided."""

    def reserve(self, webhook_id: str, phone: str, now: float) -> None:
        raise GateUnavailable


class LocalTestSendGate:
    """Process-local fixture for synthetic tests; never use across workers."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._webhooks: dict[str, float] = {}
        self._phones: dict[str, float] = {}
        self.outcomes: dict[str, str] = {}

    def reserve(self, webhook_id: str, phone: str, now: float) -> None:
        phone_key = hashlib.sha256(phone.encode("ascii")).hexdigest()
        with self._lock:
            self._webhooks = {key: until for key, until in self._webhooks.items() if until > now}
            self._phones = {key: until for key, until in self._phones.items() if until > now}
            if webhook_id in self._webhooks or phone_key in self._phones:
                raise GateRejected
            self._webhooks[webhook_id] = now + SIGNATURE_AGE_SECONDS
            self._phones[phone_key] = now + PHONE_INTERVAL_SECONDS

    def finish(self, webhook_id: str, outcome: str, now: float) -> None:
        with self._lock:
            if webhook_id not in self._webhooks or outcome not in {'provider_accepted','rejected','not_dispatched','unknown'}:
                raise GateUnavailable
            previous = self.outcomes.get(webhook_id)
            if previous is not None and previous != outcome:
                raise GateUnavailable
            self.outcomes[webhook_id] = outcome


async def _await_aliyun(operation, deadline=None):
    loop = asyncio.get_running_loop()
    deadline = deadline if deadline is not None else loop.time() + ALIYUN_SEND_DEADLINE_SECONDS
    async with asyncio.timeout_at(deadline) as timer:
        response = await operation
    # A dependency that swallows cancellation must not turn a late result into
    # confirmed success after the caller's response window. A timer may fire
    # within clock resolution before its numeric deadline; expiration is final.
    if timer.expired() or loop.time() >= deadline:
        try:
            if _provider_outcome(response) is True:
                raise ProviderAcceptedLate from None
        except ProviderRejected:
            pass
        raise TimeoutError()
    return response


def _bind_required_acs3_headers(client):
    """Retain this client's private IO binding and the official ACS3 signer."""
    from copy import copy
    from types import FunctionType, MethodType
    from alibabacloud_tea_openapi.client import Client as OpenApiClient
    from alibabacloud_tea_openapi.utils import Utils
    from darabonba.core import DaraCore
    original = client.do_request_async.__func__
    official = OpenApiClient.do_request_async
    if (original.__code__ is not official.__code__ or original.__closure__
            or original.__globals__ is official.__globals__
            or original.__globals__.get('Utils') is not Utils
            or original.__globals__.get('DaraCore') is DaraCore):
        raise ValueError('SMS_SIGNING_BINDING')
    required = frozenset(('host', 'x-acs-action', 'x-acs-content-sha256',
        'x-acs-credentials-provider', 'x-acs-date', 'x-acs-signature-nonce', 'x-acs-version'))
    wire = required | {'accept', 'user-agent'}
    class SigningUtils(Utils):
        @staticmethod
        def get_authorization(request, sign_type, payload, ak, secret):
            signed = copy(request)
            signed.headers = {k: v for k, v in request.headers.items()
                if k.lower() in ('host', 'content-type') or k.lower().startswith('x-acs-')}
            if set(request.headers) != wire or set(signed.headers) != required:
                raise ValueError('SMS_SIGNING_SCOPE')
            return Utils.get_authorization(signed, sign_type, payload, ak, secret)
    private_globals = dict(original.__globals__)
    private_globals['Utils'] = SigningUtils
    private = FunctionType(original.__code__, private_globals, original.__name__,
                           original.__defaults__, original.__closure__)
    private.__kwdefaults__ = original.__kwdefaults__
    client.do_request_async = MethodType(private, client)
    return client


def _validated_retry_receipt(receipt):
    """Validate only the committed gate result, never a client-supplied value."""
    if receipt is None:
        return None
    if (type(receipt) not in (tuple, list) or len(receipt) != 4
            or any(type(value) is not str or not re.fullmatch(r'[0-9a-f]{64}', value)
                   for value in receipt[:2])
            or type(receipt[2]) is not int or not 1 <= receipt[2] <= 5
            or type(receipt[3]) not in (int, float)
            or not math.isfinite(receipt[3]) or receipt[3] <= 0):
        raise ValueError('SMS_GATE_RECEIPT_CONTRACT')
    return tuple(receipt)


def _provider_out_id(retry_receipt):
    """Reuse the already durable random operation ID; never derive it from a phone."""
    if (isinstance(retry_receipt, (tuple, list)) and retry_receipt
            and isinstance(retry_receipt[0], str)
            and re.fullmatch(r'[0-9a-f]{64}', retry_receipt[0])):
        return retry_receipt[0]
    return None  # Legacy hooks keep their original sending behavior.


async def send_with_aliyun(phone: str, otp: str, settings: SmsHookSettings, *, deadline=None, out_id=None, retry_attempt=None) -> bool:
    """Send Supabase's OTP unchanged via Aliyun PNVS SendSmsVerifyCode.

    The SDK is imported only after the feature switch, signature, payload and
    gate checks. Only fixed non-identifying diagnostic fields enter logs.
    """
    if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
        raise ProviderNotDispatchedPermanent from None
    maximum = asyncio.get_running_loop().time() + ALIYUN_SEND_DEADLINE_SECONDS
    deadline = maximum if deadline is None else min(maximum, deadline)
    if not math.isfinite(deadline) or asyncio.get_running_loop().time() >= deadline:
        raise ProviderNotDispatched from None  # No SDK/provider invocation yet.
    started = time.monotonic()
    stage = "setup"
    try:
        from alibabacloud_dypnsapi20170525.client import Client
        from alibabacloud_dypnsapi20170525 import models as dypns_models
        from alibabacloud_tea_openapi import models as openapi_models
        from alibabacloud_tea_util import models as util_models
        from darabonba.policy.retry import RetryOptions
        from alibabacloud_tea_openapi.exceptions import ClientException
        from app.sms_relay_transport import bind_transport

        config = openapi_models.Config(
            access_key_id=settings.access_key_id,
            access_key_secret=settings.access_key_secret,
        )
        config.endpoint = "dypnsapi.aliyuncs.com"
        config.protocol = "HTTPS"
        config.retry_options = RetryOptions(retryable=False)
        parameters = {settings.code_param: otp}
        parameters[settings.minute_param] = str(settings.template_minutes)
        request = dypns_models.SendSmsVerifyCodeRequest(
            country_code="86",
            phone_number=phone[3:],
            sign_name=settings.sign_name,
            template_code=settings.template_code,
            template_param=json.dumps(parameters, separators=(",", ":")),
            return_verify_code=False,
            auto_retry=0,
            interval=PROVIDER_INTERVAL_SECONDS,
            # Correlation only: OutId is not a provider idempotency guarantee.
            out_id=_provider_out_id((out_id,)),
        )
        # SDK timeouts are milliseconds. One attempt leaves time within Supabase's
        # five-second HTTP Hook window for request verification and response.
        runtime = util_models.RuntimeOptions(
            connect_timeout=ALIYUN_CONNECT_TIMEOUT_MS,
            read_timeout=ALIYUN_READ_TIMEOUT_MS,
            autoretry=False, max_attempts=1,
        )
        client = _bind_required_acs3_headers(bind_transport(Client(config), deadline, retry_attempt=retry_attempt))
        if asyncio.get_running_loop().time() >= deadline:
            raise ProviderNotDispatched from None
        stage = "send"
        response = await _await_aliyun(client.send_sms_verify_code_with_options_async(request, runtime), deadline)
    except Exception as error:
        _provider_diagnostic(started, stage, error=error)
        # A paired, reviewed transport may prove no HTTP bytes were dispatched.
        # No error text/boolean attribute is accepted as such evidence. The old
        # baseline lacks this type and therefore remains conservatively unknown.
        from app import aliyun_sms_transport
        permanent = getattr(aliyun_sms_transport, 'SmsNotDispatchedPermanent', None)
        if (isinstance(permanent, type) and issubclass(permanent, Exception)
                and any(type(item) is permanent for item in _diagnostic_errors(error))):
            raise ProviderNotDispatchedPermanent from None
        if isinstance(error, ProviderNotDispatched):
            raise
        if stage == 'setup':
            # No SDK invocation has started. Dependency/configuration failure
            # is definitely unsent but must not authorize another route.
            raise ProviderNotDispatchedPermanent from None
        not_dispatched = getattr(aliyun_sms_transport, 'SmsNotDispatched', None)
        if (isinstance(not_dispatched, type) and issubclass(not_dispatched, Exception)
                and any(type(item) is not_dispatched for item in _diagnostic_errors(error))):
            raise ProviderNotDispatched from None
        # A verified SDK HTTP 400 signature refusal is definitive, not a
        # transport uncertainty. Keep every other exception classification.
        if (type(error) is ClientException
                and type(error.status_code) is int and error.status_code == 400
                and type(error.code) is str and error.code == "SignatureDoesNotMatch"):
            raise ProviderRejected from None
        # The SDK raises for HTTP 400. Only the documented exact request-level
        # refusals are definitive; arbitrary SDK/network errors stay unknown.
        if (getattr(error, 'code', None) in _DEFINITE_REJECTION_CODES
                and getattr(error, 'status_code', getattr(error, 'statusCode', None)) == 400):
            raise ProviderRejected from None
        raise
    _provider_diagnostic(started, stage, response=response)
    return _provider_outcome(response)


def create_sms_hook_router(settings: SmsHookSettings | None = None,
                           transport: SmsTransport | None = None,
                           gate: SendGate | None = None,
                           clock: Callable[[], float] = time.time,
                           elapsed_clock: Callable[[], float] = time.monotonic,
                           binding_guard=None, change_store=None) -> APIRouter:
    settings = settings or SmsHookSettings.from_env()
    transport = transport or send_with_aliyun
    gate = gate or RejectingSendGate()
    router = APIRouter()

    @router.post("/auth/hooks/send-sms")
    async def send_sms(request: Request) -> dict:
        started = getattr(request.state, '_gxj_sms_started', None)
        if started is None:
            # Bare router consumers retain their old behavior; production and
            # the standalone factory both install the early ASGI stamp.
            started = elapsed_clock()
        if not settings.enabled or not settings.ready():
            raise HTTPException(503, "短信发送尚未启用")
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "短信请求格式无效")
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            raise HTTPException(413, "短信请求过大") from None
        if length < 0 or length > MAX_BODY_BYTES:
            raise HTTPException(413, "短信请求过大")
        chunks = bytearray()
        async for chunk in request.stream():
            chunks.extend(chunk)
            if len(chunks) > MAX_BODY_BYTES:
                raise HTTPException(413, "短信请求过大")
        if not chunks:
            raise HTTPException(413, "短信请求过大")
        raw_body = bytes(chunks)
        try:
            webhook_id = verify_standard_webhook(
                raw_body, request.headers, settings.signing_secrets, clock())
        except (InvalidHookSignature, ValueError):
            raise HTTPException(401, "短信请求未通过验证") from None
        phone, otp = _signed_sms(raw_body)
        handled=False
        if change_store is not None:
            try:
                handled=await run_in_threadpool(change_store.capture_sms,webhook_id,json.loads(raw_body)['user'],phone,otp)
            except HTTPException:raise
            except Exception:raise HTTPException(503,'手机更换状态暂时无法核对') from None
        if binding_guard is not None and not handled:
            try:
                await run_in_threadpool(binding_guard,json.loads(raw_body)['user'],phone)
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(503,'手机绑定状态暂时无法核对') from None
        reserved_at = clock()
        try:
            if hasattr(gate,'reserve_for_user'):
                retry_receipt=await run_in_threadpool(gate.reserve_for_user,webhook_id,phone,reserved_at,json.loads(raw_body)['user'],json.loads(raw_body)['sms'])
            else:
                retry_receipt=await run_in_threadpool(gate.reserve,webhook_id,phone,reserved_at)
            retry_receipt = _validated_retry_receipt(retry_receipt)
        except GateUnavailable:
            return JSONResponse(status_code=200,content={'error':{'http_code':503,'message':'GXJ_SMS_GATE_UNAVAILABLE: 短信发送状态暂时无法核对，请稍后核对，不要自动重发'}})
        except GateRejected as error:
            reasons={
                'recipient':('GXJ_SMS_RECIPIENT','暂不支持该手机号，请使用中国大陆手机号'),
                'duplicate':('GXJ_SMS_DUPLICATE','本次请求已处理，请查看已收到的短信；不要重复提交'),
                'total':('GXJ_SMS_TOTAL_LIMIT','短信累计额度已用完，请联系服务方恢复；无需反复发送'),
                'day':('GXJ_SMS_DAY_LIMIT','今日短信额度已用完，请在下一额度周期重试'),
                'phone_day':('GXJ_SMS_PHONE_DAY_LIMIT','此号码今日短信次数已用完，请在下一额度周期重试'),
                'cooldown':('GXJ_SMS_COOLDOWN','请间隔至少60秒再申请验证码'),
                'month':('GXJ_SMS_MONTH_LIMIT','本月短信额度已用完，请等待下月；服务方需同时核对套餐剩余量'),
                'capacity_expired':('GXJ_SMS_CAPACITY_EXPIRED','短信套餐已到期，请联系服务方恢复；无需反复发送'),
                'policy':('GXJ_SMS_POLICY','本次短信申请未通过保护检查，请稍后核对发送状态'),
            }
            code,message=reasons[error.reason]
            # A signed, valid hook business rejection must use the hook JSON
            # contract in a 200 response for Auth to preserve its public reason.
            suffix = '' if error.retry_after_seconds is None else f' GXJ_RETRY_AFTER_SECONDS={error.retry_after_seconds}'
            return JSONResponse(status_code=200,content={'error':{'http_code':503 if error.reason=='capacity_expired' else 429,'message':code+': '+message+suffix}})
        except Exception:
            return JSONResponse(status_code=200,content={'error':{'http_code':503,'message':'GXJ_SMS_GATE_UNAVAILABLE: 短信发送状态暂时无法核对，请稍后核对，不要自动重发'}})
        async def finished(outcome):
            remaining = HOOK_RESPONSE_BUDGET_SECONDS - (elapsed_clock() - started)
            if remaining <= 0:
                _outcome_diagnostic(outcome, 'response_deadline')
                return False
            try:
                # Cancellation bounds the HTTP wait, not the SQL's outcome. The
                # already-running guarded transaction may still finish; caller
                # sees unknown and never replays it or the provider request.
                await asyncio.wait_for(asyncio.to_thread(gate.finish, webhook_id, outcome, clock()),
                                       timeout=remaining)
                return True
            except Exception:
                _outcome_diagnostic(outcome, 'storage_or_wait')
                return False  # Unknown COMMIT: no retry or outcome rewrite.

        def outcome_error(rejected=False, not_dispatched=False, retryable=True):
            cooldown_start=retry_receipt[3] if retry_receipt is not None else reserved_at
            remaining = max(0, min(60, math.ceil(cooldown_start + 60 - clock())))
            code = 'GXJ_SMS_PROVIDER_REJECTED' if rejected else 'GXJ_SMS_PROVIDER_UNCONFIRMED'
            suffix=''
            if not_dispatched and (retry_receipt is not None or not retryable):
                code='GXJ_SMS_NOT_DISPATCHED'
                if retryable and retry_receipt is not None:
                    op,nonce,attempt=retry_receipt[:3]
                    suffix=f' GXJ_SMS_RETRY_RECEIPT={op}.{nonce}.{attempt}'
            message = ('本次短信明确未发送成功，未计入每日5次；请稍后重新申请' if rejected
                       else '短信发送结果未确认，请先查看已收到的短信，不要自动重发')
            return JSONResponse(status_code=200, content={'error': {'http_code': 422,
                'message': f'{code}: {message} GXJ_RETRY_AFTER_SECONDS={remaining}{suffix}'}})

        if elapsed_clock() - started >= MAX_PRE_SEND_ELAPSED_SECONDS:
            # Definitively not invoked. Keep the cost reservation; no daily use.
            committed = await finished('not_dispatched')
            return outcome_error(rejected=committed,not_dispatched=committed)
        try:
            if inspect.iscoroutinefunction(transport):
                # Sender has its own absolute cutoff, strictly before the HTTP
                # response deadline. A late positive at that cutoff still has a
                # protected outcome-recording window, without background work.
                remaining = max(0.0, HOOK_RESPONSE_BUDGET_SECONDS - HOOK_FINALIZE_RESERVE_SECONDS - (elapsed_clock() - started))
                deadline = asyncio.get_running_loop().time() + remaining
                async with asyncio.timeout(remaining) as timer:
                    if transport is send_with_aliyun:
                        success = await transport(phone, otp, settings, deadline=deadline,
                                                  out_id=_provider_out_id(retry_receipt),
                                                  retry_attempt=None if retry_receipt is None else retry_receipt[2])
                    else:
                        success = await transport(phone, otp, settings)
                if timer.expired():
                    if success is True:
                        raise ProviderAcceptedLate
                    raise TimeoutError()
            else:
                def _send_sync():
                    # A queued synchronous fixture/adapter must not start a
                    # provider call after the same admission deadline.
                    if elapsed_clock() - started >= MAX_PRE_SEND_ELAPSED_SECONDS:
                        raise TimeoutError()
                    return transport(phone, otp, settings)
                success = await run_in_threadpool(_send_sync)
            # Do not confirm a transport that swallowed cancellation or a
            # synchronous adapter that finished after the response budget.
            if elapsed_clock() - started >= HOOK_RESPONSE_BUDGET_SECONDS:
                if success is True:
                    raise ProviderAcceptedLate
                raise TimeoutError()
        except ProviderAcceptedLate:
            await finished('provider_accepted')
            return outcome_error()
        except ProviderNotDispatchedPermanent:
            committed = await finished('not_dispatched')
            return outcome_error(rejected=committed, not_dispatched=committed, retryable=False)
        except ProviderNotDispatched:
            committed = await finished('not_dispatched')
            return outcome_error(rejected=committed,not_dispatched=committed)
        except ProviderRejected:
            committed = await finished('rejected')
            return outcome_error(rejected=committed)
        except Exception:
            # Auth propagates this business code as its HTTP response. Keep an
            # ambiguous send out of upstream 5xx retry policies; the safe relay
            # still classifies this marker as unknown, never as successful OTP.
            # The consumed reservation stays intact and the send is not retried.
            await finished('unknown')
            return outcome_error()
        if success is not True:
            await finished('unknown')
            return outcome_error()
        if not await finished('provider_accepted'):
            return outcome_error()
        return {}

    return router


def create_sms_hook_app(settings: SmsHookSettings | None = None,
                        transport: SmsTransport | None = None,
                        gate: SendGate | None = None,
                        clock: Callable[[], float] = time.time,
                        elapsed_clock: Callable[[], float] = time.monotonic) -> FastAPI:
    app = FastAPI(title="Gongxingji isolated SMS hook", docs_url=None,
                  redoc_url=None, openapi_url=None)
    app.add_middleware(SmsHookTimingMiddleware, elapsed_clock=elapsed_clock)
    app.include_router(create_sms_hook_router(settings, transport, gate, clock, elapsed_clock))
    return app

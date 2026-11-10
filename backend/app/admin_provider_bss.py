"""Read-only BSS package purchase bills; never a send counter or cash receipt.

Only the commodity verified in the original account is accepted. The underlying
OpenAPI signer is the existing official dependency. No BSS SDK is added.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import types
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

ACTION = 'DescribeInstanceBill'
ENDPOINT = 'business.aliyuncs.com'
VERSION = '2017-12-14'
PAGE_SIZE = 300
MAX_CALLS = 5
TIMEOUT_SECONDS = 3.5
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
PRODUCT = 'dypns'
COMMODITY = 'dypns_smsverify_public_cn'
BILLING_ITEM = 'smsverify'
REASONS = frozenset(('configuration', 'permission', 'provider', 'connection',
    'timeout', 'invalid_response', 'incomplete', 'no_matching_bill'))
PERMISSION_CODES = frozenset(('NotAuthorized', 'Forbidden', 'Forbidden.RAM',
    'Forbidden.RAMUser', 'InvalidAccessKeyId.NotFound', 'InvalidAccessKeyId.Inactive'))
DECIMAL = re.compile(r'(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,8})?\Z', re.ASCII)


_LOGGER = logging.getLogger(__name__)
_DIAGNOSTIC_PHASES = frozenset(('setup', 'request', 'validate', 'project'))
_EXCEPTION_KINDS = frozenset(('none', 'timeout_error', 'import_error',
    'attribute_error', 'type_error', 'value_error', 'os_error', 'other'))
_PURCHASE_MESSAGES = {
    'configuration': '查询配置尚未就绪，数据未知。',
    'permission': '认证或查询权限未通过，数据未知。',
    'provider': '供应商未返回成功，数据未知。',
    'connection': '连接未完成，数据未知。',
    'timeout': '查询超时，数据未知；未自动重试。',
    'invalid_response': '返回数据格式未确认，数据未知。',
    'incomplete': '返回账单不完整，数据未知。',
    'no_matching_bill': '未查到已核准品类的购买账单，未计为零。',
}


def exception_kind(error):
    # Fixed native categories only; never inspect exception text or class names.
    for cls, label in ((TimeoutError, 'timeout_error'), (ImportError, 'import_error'),
            (AttributeError, 'attribute_error'), (TypeError, 'type_error'),
            (ValueError, 'value_error'), (OSError, 'os_error')):
        if isinstance(error, cls):
            return label
    return 'other'


def query_diagnostic(cycle, outcome, phase, kind, calls):
    # One safe summary per returned query. Logging cannot affect the result.
    try:
        safe_month = cycle if type(cycle) is str and re.fullmatch(r'20[0-9]{2}-(?:0[1-9]|1[0-2])', cycle) else 'unknown'
        data = outcome if type(outcome) is dict else {}
        status, reason, complete = data.get('status'), data.get('reason'), data.get('complete')
        safe_status = status if type(status) is str and status in ('available', 'unavailable') else 'unknown'
        safe_reason = 'success' if reason is None and safe_status == 'available' else reason if type(reason) is str and reason in REASONS else 'unknown'
        safe_complete = ('true' if complete else 'false') if type(complete) is bool else 'unknown'
        safe_phase = phase if type(phase) is str and phase in _DIAGNOSTIC_PHASES else 'unknown'
        safe_kind = kind if type(kind) is str and kind in _EXCEPTION_KINDS else 'other'
        safe_calls = calls if type(calls) is int and 0 <= calls <= MAX_CALLS else 'unknown'
        _LOGGER.warning('provider_bss_query action=DescribeInstanceBill month=%s status=%s reason=%s complete=%s phase=%s exception_kind=%s sdk_calls=%s',
            safe_month, safe_status, safe_reason, safe_complete, safe_phase, safe_kind, safe_calls)
    except Exception:
        pass


def purchase_status_text(outcome):
    # Visible in the existing summary coverage paragraph, separately labelled.
    if type(outcome) is not dict:
        message = '读取未完成，数据未知。'
    elif type(outcome.get('status')) is str and outcome['status'] == 'available' and outcome.get('complete') is True:
        message = '已完整读取；购买数量与应付金额不代表发送量、套餐余额或现金实付。'
    else:
        reason = outcome.get('reason')
        message = _PURCHASE_MESSAGES.get(reason, '读取未完成，数据未知。') if type(reason) is str else '读取未完成，数据未知。'
    return '短信认证套餐购买账单：' + message


class BssFailure(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else 'invalid_response'
        super().__init__(self.reason)


def result(cycle, reason=None):
    return dict(status='unavailable' if reason else 'available', reason=reason,
        source='aliyun_bss_instance_bill', billingCycle=cycle, currency='CNY',
        purchaseQuantity=None, payableAmount=None, originalAmount=None,
        invoiceDiscount=None, cashPaid=None, matchedRows=None, complete=False,
        coverage='verified_sms_auth_package_purchases_only',
        billingDelayHours=24, currentMonthProvisionalRule=True,
        finalBillRule='next_month_day_3_after_12_beijing')


def decimal(value):
    # Native JSON numbers/strings only. Never invoke arbitrary repr/str hooks.
    if type(value) is int:
        value = str(value)
    elif type(value) is float:
        value = str(value)
    if type(value) is not str or not DECIMAL.fullmatch(value):
        raise BssFailure('invalid_response')
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise BssFailure('invalid_response') from None
    if not number.is_finite() or number < 0 or number > Decimal('100000000000000'):
        raise BssFailure('invalid_response')
    return number


def text(number):
    return format(number, 'f')


def nat(value, maximum=MAX_CALLS * PAGE_SIZE):
    if type(value) is not int or not 0 <= value <= maximum:
        raise BssFailure('incomplete')
    return value


def purchase(row):
    if type(row) is not dict:
        raise BssFailure('invalid_response')
    identity = ('ProductCode', 'ProductType', 'CommodityCode', 'BillingItemCode', 'Item', 'SubscriptionType')
    expected = (PRODUCT, COMMODITY, COMMODITY, BILLING_ITEM, 'SubscriptionOrder', 'Subscription')
    if any(type(row.get(k)) is not str or row[k] != v for k, v in zip(identity, expected)):
        return None
    if row.get('UsageUnit') != '次' or row.get('Currency') != 'CNY':
        raise BssFailure('invalid_response')
    usage = decimal(row.get('Usage'))
    if usage != usage.to_integral_value():
        raise BssFailure('invalid_response')
    payable = decimal(row.get('PretaxAmount'))
    optional = []
    for name in ('PretaxGrossAmount', 'InvoiceDiscount'):
        value = row.get(name)
        optional.append(None if value is None else decimal(value))
    # The scalar DeductedByResourcePackage has no verified unit here. It is not
    # added to monetary totals, purchase quantity, or a send count.
    return usage, payable, *optional


def project(rows, cycle):
    matches = [p for row in rows if (p := purchase(row)) is not None]
    if not matches:
        return result(cycle, 'no_matching_bill')
    out = result(cycle)
    out.update(purchaseQuantity=dict(value=text(sum((p[0] for p in matches), Decimal(0))), unit='次'),
        payableAmount=text(sum((p[1] for p in matches), Decimal(0))),
        matchedRows=len(matches), complete=True)
    for index, key in ((2, 'originalAmount'), (3, 'invoiceDiscount')):
        values = [p[index] for p in matches]
        out[key] = text(sum(values, Decimal(0))) if all(v is not None for v in values) else None
    return out


def page(response, cycle):
    if type(response) is not dict:
        raise BssFailure('invalid_response')
    status = response.get('statusCode')
    body = response.get('body')
    if type(body) is not dict:
        raise BssFailure('invalid_response')
    code = body.get('Code')
    if type(status) is not int or status != 200 or body.get('Success') is not True or code != 'Success':
        if status in (401, 403) or type(code) is str and code in PERMISSION_CODES:
            raise BssFailure('permission')
        raise BssFailure('provider')
    data = body.get('Data')
    if type(data) is not dict or data.get('BillingCycle') != cycle:
        raise BssFailure('invalid_response')
    rows = data.get('Items')
    if type(rows) is not list or len(rows) > PAGE_SIZE:
        raise BssFailure('invalid_response')
    total = nat(data.get('TotalCount'))
    token = data.get('NextToken')
    if token is None:
        token = ''
    if type(token) is not str or len(token) > 8192:
        raise BssFailure('invalid_response')
    if 'MaxResults' in data and data['MaxResults'] != PAGE_SIZE:
        raise BssFailure('invalid_response')
    return rows, total, token


def row_identity(row):
    # Stable bill fields plus the private instance ID stay only in memory.
    # Ambiguous identical rows across pages fail closed rather than double-count.
    if type(row) is not dict:
        raise BssFailure('invalid_response')
    keys = ('InstanceID', 'BillingDate', 'ProductCode', 'ProductType', 'CommodityCode',
        'BillingItemCode', 'Item', 'SubscriptionType', 'Usage', 'UsageUnit',
        'Currency', 'PretaxAmount', 'PretaxGrossAmount', 'InvoiceDiscount')
    values = []
    for key in keys:
        value = row.get(key)
        if type(value) not in (str, int, float, type(None)):
            raise BssFailure('invalid_response')
        if type(value) is str and len(value) > 8192:
            raise BssFailure('invalid_response')
        values.append((type(value), value))
    return tuple(values)


def error_reason(error):
    # Exception text, Message and RequestId never become return fields or logs.
    try:
        code = getattr(error, 'code', None)
        status = getattr(error, 'status_code', None)
    except Exception:
        return 'connection'
    if type(code) is str and code in PERMISSION_CODES or type(status) is int and status in (401, 403):
        return 'permission'
    if type(status) is int and 400 <= status <= 599:
        return 'provider'
    return 'connection'


def make_client():
    # Only called after the mixin has authorized an administrator. The values
    # remain in this original server process and are never returned or logged.
    from alibabacloud_tea_openapi.client import Client
    from alibabacloud_tea_openapi import models
    from darabonba.core import DaraCore
    from darabonba.response import DaraResponse
    from darabonba.policy.retry import RetryOptions
    import aiohttp

    key_id = os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID', '')
    key_secret = os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '')
    if not key_id or not key_secret:
        raise BssFailure('configuration')
    config = models.Config(access_key_id=key_id, access_key_secret=key_secret,
        endpoint=ENDPOINT, protocol='HTTPS', retry_options=RetryOptions(retryable=False))
    client = Client(config)

    class FixedCore(DaraCore):
        @staticmethod
        async def async_do_action(request, runtime_option=None):
            # Keep the official signature and request values; restrict only
            # transport. This function is bound to this client, not globally.
            url = DaraCore.compose_url(request)
            parsed = urlsplit(url)
            headers = request.headers
            if (parsed.scheme != 'https' or parsed.hostname != ENDPOINT or
                parsed.port not in (None, 443) or parsed.username is not None or
                parsed.password is not None or parsed.path != '/' or parsed.fragment or
                request.method != 'POST' or headers.get('x-acs-action') != ACTION or
                headers.get('x-acs-version') != VERSION):
                raise BssFailure('configuration')
            body = request.body
            if body is None:
                body = b''
            elif type(body) is str:
                body = body.encode('utf-8')
            if type(body) is not bytes or len(body) > 65536:
                raise BssFailure('configuration')
            timeout = aiohttp.ClientTimeout(total=3, connect=1, sock_read=2.5)
            async with aiohttp.ClientSession(trust_env=False, timeout=timeout) as session:
                async with session.request('POST', url, headers=headers, data=body,
                        allow_redirects=False, proxy=None, ssl=True) as response:
                    payload = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        payload.extend(chunk)
                        if len(payload) > MAX_RESPONSE_BYTES:
                            raise BssFailure('invalid_response')
                    tea = DaraResponse()
                    tea.status_code = response.status
                    tea.headers = {k.lower(): v for k, v in response.headers.items()}
                    tea.body = bytes(payload)
                    return tea

    original = Client.do_request_async
    globals_copy = dict(original.__globals__, DaraCore=FixedCore)
    method = types.FunctionType(original.__code__, globals_copy, original.__name__,
        original.__defaults__, original.__closure__)
    method.__kwdefaults__ = original.__kwdefaults__
    client.do_request_async = types.MethodType(method, client)
    return client


async def read_package_purchases(cycle, *, client_factory=None):
    phase, kind, calls = 'setup', 'none', 0
    if type(cycle) is not str or not re.fullmatch(r'20[0-9]{2}-(?:0[1-9]|1[0-2])', cycle):
        outcome = result(None, 'configuration')
        query_diagnostic(cycle, outcome, phase, kind, calls)
        return outcome
    try:
        from alibabacloud_tea_openapi import models
        from alibabacloud_openapi_util.client import Client as Util
        from darabonba.runtime import RuntimeOptions
        async with asyncio.timeout(TIMEOUT_SECONDS) as timer:
            client = (client_factory or make_client)()
            params = models.Params(action=ACTION, version=VERSION, protocol='HTTPS',
                pathname='/', method='POST', auth_type='AK', style='RPC',
                req_body_type='formData', body_type='json')
            runtime = RuntimeOptions(connect_timeout=1000, read_timeout=2500,
                autoretry=False, max_attempts=1)
            rows, tokens, expected_total, token = [], set(), None, ''
            previous_page_rows = set()
            for _ in range(MAX_CALLS):
                query = dict(BillingCycle=cycle, ProductCode=PRODUCT, ProductType=COMMODITY,
                    Granularity='MONTHLY', IsBillingItem=True, IsHideZeroCharge=False,
                    MaxResults=PAGE_SIZE)
                if token:
                    query['NextToken'] = token
                phase = 'request'
                calls += 1
                response = await client.call_api_async(params,
                    models.OpenApiRequest(query=Util.query(query)), runtime)
                if timer.expired():
                    raise BssFailure('timeout')
                phase = 'validate'
                items, total, next_token = page(response, cycle)
                if expected_total is not None and total != expected_total:
                    raise BssFailure('incomplete')
                expected_total = total
                page_rows = {row_identity(item) for item in items}
                if previous_page_rows.intersection(page_rows):
                    raise BssFailure('incomplete')
                previous_page_rows.update(page_rows)
                rows.extend(items)
                if len(rows) > total:
                    raise BssFailure('incomplete')
                if not next_token:
                    if len(rows) != total:
                        raise BssFailure('incomplete')
                    phase = 'project'
                    outcome = project(rows, cycle)
                    query_diagnostic(cycle, outcome, phase, kind, calls)
                    return outcome
                if not items or next_token in tokens or len(rows) >= total:
                    raise BssFailure('incomplete')
                tokens.add(next_token)
                token = next_token
            raise BssFailure('incomplete')
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        kind = 'timeout_error'
        outcome = result(cycle, 'timeout')
    except BssFailure as error:
        outcome = result(cycle, error.reason)
    except (ImportError, AttributeError) as error:
        kind = exception_kind(error)
        outcome = result(cycle, 'configuration')
    except Exception as error:
        kind = exception_kind(error)
        outcome = result(cycle, error_reason(error))
    query_diagnostic(cycle, outcome, phase, kind, calls)
    return outcome

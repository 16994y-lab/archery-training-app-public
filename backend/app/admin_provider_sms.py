"""Administrator-initiated PNVS aggregates. No sends, hooks, background jobs or DDL."""
import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import logging
import os
import re
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

STATISTICS_AUTHENTICATION_TYPE = 3
BILLING_AUTHENTICATION_TYPE = 4
QUERY_TIMEOUT_SECONDS = 4.0
MAX_EXTERNAL_CALLS = 7
BEIJING = timezone(timedelta(hours=8))
_LOGGER = logging.getLogger(__name__)
_ACTIONS = {'usage': 'QueryGateVerifyStatisticPublic', 'billing': 'QueryGateVerifyBillingPublic'}
_PERMISSION_CODES = frozenset(('Forbidden.NoPermission', 'Forbidden.RAM', 'NoPermission',
    'isp.RAM_PERMISSION_DENY', 'isv.RAM_PERMISSION_DENY'))
# Exact '200' is an observed Explorer response, not a documented numeric-code range.
_DIAGNOSTIC_CODES = _PERMISSION_CODES | frozenset(('OK', '200', 'isv.PRODUCT_UNSUBSCRIBE',
    'isv.PRODUCT_UN_SUBSCRIPT', 'isv.INVALID_PARAMETERS', 'isv.FORBIDDEN_ACTION',
    'isv.ACCOUNT_NOT_EXISTS', 'isv.ACCOUNT_ABNORMAL', 'isv.OUT_OF_SERVICE',
    'isp.UNKNOWN', 'isp.SYSTEM_ERROR', 'isp.RES_OWNER_ID_UNKNOWN', 'isp.QPS_LIMIT',
    'InvalidParameter.MissingCustomerId', 'isv.SCENE_QUERY_FAIL',
    'SignatureDoesNotMatch', 'InvalidAccessKeyId.NotFound', 'InvalidTimeStamp.Expired'))
_DIAGNOSTIC_PHASES = frozenset(('configuration', 'response', 'exception', 'timeout', 'cancelled'))
# Public catalog only; it does not prove which codes either query returns.
# https://help.aliyun.com/zh/pnvs/developer-reference/api-return-code
_DIAGNOSTIC_CODES |= frozenset((
    'isv.VERIFY_SCHEME_NOT_EXIST', 'isv.VERIFY_SCHEME_CONFLICT', 'isv.PACK_SIGN_CONFLICT',
    'isv.BUNDLE_ID_CONFLICT', 'isv.TOKEN_INVALID', 'isv.TOKEN_UNAUTHORIZED_USED',
    'isv.PARAMETERS_MISMATCH', 'isv.MOBILE_NUMBER_ILLEGAL', 'isv.INVALID_APP',
    'isv.CSRF_CHECK_FAILED', 'isv.ACCESS_CODE_ILLEGAL', 'isp.OPERATOR_LIMIT',
    'InvalidParameter.MissingPackageName', 'InvalidParameter.MissingSignName',
    'InvalidParameter.MissingBundleId', 'InvalidParameter.SmsTemplateCode',
    'InvalidParameter.OsType', 'InvalidParameter.MisMatchWithSceneCode',
    'InvalidPhoneNumber.Check', 'InvalidBizToken.Expired', 'LimitExceeded.SmsCode',
    'InvalidBizToken.Check', 'EntityNotExist.SceneCode', 'EntityNotExist.SmsTemplateCode',
    'EntityNotExist.SmsSignName', 'EncryptError.BizToken', 'QueryFail.SceneCode',
    'CreateFail.StsToken', 'CreateFail.SmsCode', 'CreateFail.VerifyKey', 'GET_MOBILE_FAILED',
    'FUNCTION_NOT_OPENED', 'biz.FREQUENCY', 'isv.BUSINESS_LIMIT_CONTROL', 'isv.ValidateFail'))
_MISSING = object()
_KINDS = frozenset(('mapping', 'array', 'string', 'integer', 'number', 'boolean',
    'null', 'missing', 'other', 'unavailable', 'unknown'))
_SHAPE_VALUES = {
    'shape_layer': frozenset(('decoded', 'unknown')),
    'body_kind': _KINDS,
    'code_presence': frozenset(('missing', 'null', 'present', 'unavailable', 'unknown')),
    'code_kind': _KINDS,
    'code_shape': frozenset(('known', 'numeric_text', 'empty', 'unlisted',
        'not_string', 'unavailable', 'unknown')),
    'data_presence': frozenset(('missing', 'null', 'present', 'unavailable', 'unknown')),
    'code_keys': frozenset(('canonical', 'lowercase', 'both', 'absent', 'unavailable', 'unknown')),
    'data_keys': frozenset(('canonical', 'lowercase', 'both', 'absent', 'unavailable', 'unknown')),
}
_MESSAGES = {
    'permission': '当前供应商认证或查询权限未通过，数据未知。',
    'configuration': '供应商只读查询尚未配置，数据未知。',
    'timeout': '供应商查询超时，数据未知；未自动重试。',
    'connection': '供应商连接未完成，数据未知；未自动重试。',
    'provider': '供应商未返回成功结果，数据未知。',
    'invalid_response': '供应商返回数据无法核对，数据未知。',
}


def _value_kind(value):
    # No repr, str, dynamic type names or traversal of non-native containers.
    if value is _MISSING:return 'missing'
    if value is None:return 'null'
    for native, label in ((dict, 'mapping'), (list, 'array'), (str, 'string'),
            (bool, 'boolean'), (int, 'integer'), (float, 'number')):
        if type(value) is native:return label
    return 'other'


def _presence(value):
    if value is _MISSING:return 'missing'
    return 'null' if value is None else 'present'


def _key_case(body, canonical, lowercase):
    # Inspect only these two public key names; never inspect lowercase values.
    upper, lower = canonical in body, lowercase in body
    return 'both' if upper and lower else 'canonical' if upper else 'lowercase' if lower else 'absent'


def _decoded_shape(decoded):
    result = dict(shape_layer='decoded', body_kind='unavailable',
        code_presence='unavailable', code_kind='unavailable', code_shape='unavailable',
        data_presence='unavailable', code_keys='unavailable', data_keys='unavailable')
    if type(decoded) is not dict:return result
    body = decoded.get('body', _MISSING)
    result['body_kind'] = _value_kind(body)
    if type(body) is not dict:return result
    code = body.get('Code', _MISSING)
    result['code_presence'] = _presence(code)
    result['code_kind'] = _value_kind(code)
    result['data_presence'] = _presence(body.get('Data', _MISSING))
    result['code_keys'] = _key_case(body, 'Code', 'code')
    result['data_keys'] = _key_case(body, 'Data', 'data')
    result['code_shape'] = ('not_string' if type(code) is not str else
        'known' if code in _DIAGNOSTIC_CODES else 'empty' if code == '' else
        'numeric_text' if code.isascii() and code.isdecimal() else 'unlisted')
    return result


def _observe_decoded_call(client, shape):
    # Same SDK call, before from_map loses absent/null details; no raw retention.
    try:
        original = client.call_api_async
        if not callable(original):return
        async def observed(*args, **kwargs):
            decoded = await original(*args, **kwargs)
            try:
                shape.update(_decoded_shape(decoded))
            except Exception:
                pass  # Observation failure cannot change the returned result.
            return decoded
        client.call_api_async = observed
    except Exception:
        pass  # Unsupported instrumentation leaves the original client intact.


def query_diagnostic(kind, phase, reason, status=None, code=None, shape=None):
    """Closed diagnostic vocabulary only; no provider message, request ID or data."""
    if type(kind) is not str or kind not in _ACTIONS:
        return
    safe_phase = phase if type(phase) is str and phase in _DIAGNOSTIC_PHASES else 'unknown'
    safe_reason = reason if type(reason) is str and reason in (*_MESSAGES, 'success', 'cancelled') else 'unknown'
    safe_status = status if type(status) is int and 100 <= status <= 599 else 'UNKNOWN'
    safe_code = code if type(code) is str and code in _DIAGNOSTIC_CODES else 'UNKNOWN'
    try:
        log = _LOGGER.info if safe_reason == 'success' else _LOGGER.warning
        safe_shape = [shape.get(key) if type(shape) is dict and
            type(shape.get(key)) is str and shape.get(key) in allowed else 'unknown'
            for key, allowed in _SHAPE_VALUES.items()]
        log('provider_sms_query action=%s phase=%s http_status=%s provider_code=%s reason=%s'
            ' shape_layer=%s body_kind=%s code_presence=%s code_kind=%s code_shape=%s data_presence=%s'
            ' code_keys=%s data_keys=%s',
            _ACTIONS[kind], safe_phase, safe_status, safe_code, safe_reason, *safe_shape,
            exc_info=False, stack_info=False)
    except Exception:
        # A diagnostic sink failure must not change the provider result or retry it.
        pass


def unavailable(reason):
    return dict(status='unavailable', reason=reason, message=_MESSAGES[reason])


def query_window(body, now):
    if type(body) is not dict or set(body) != {'days', 'month'} or type(body['days']) is not int or body['days'] not in (7,30) or type(body['month']) is not str or body['month'] not in ('current','previous'):
        raise HTTPException(422, '供应商查询条件无效')
    today=now.astimezone(BEIJING).date()
    month=today.replace(day=1)
    if body['month']=='previous':month=(month-timedelta(days=1)).replace(day=1)
    return dict(start=(today-timedelta(days=body['days']-1)).strftime('%Y%m%d'),
        end=today.strftime('%Y%m%d'), month=month.strftime('%Y%m'))


def count(value, string=False):
    if string:
        if type(value) is not str or not re.fullmatch(r'\d{1,15}',value,re.ASCII):raise ValueError()
        value=int(value)
    if type(value) is not int or not 0<=value<=9007199254740991:raise ValueError()
    return value


def money(value):
    if type(value) is not str or not re.fullmatch(r'-?\d{1,12}(?:\.\d{1,6})?',value,re.ASCII):raise ValueError()
    amount=Decimal(value)
    if not amount.is_finite():raise ValueError()
    return format(amount,'f')


def statistics(data, window):
    totals=dict(total=count(data.total),success=count(data.total_success),
        failure=count(data.total_fail),unknown=count(data.total_unknown))
    if totals['total'] != totals['success'] + totals['failure'] + totals['unknown']:raise ValueError()
    if type(data.day_statistic) is not list or len(data.day_statistic)>30:raise ValueError()
    rows=[];dates=set()
    for item in data.day_statistic:
        day=item.statistic_date_str
        if type(day) is not str or not re.fullmatch(r'\d{8}',day,re.ASCII) or not window['start']<=day<=window['end'] or day in dates:raise ValueError()
        datetime.strptime(day,'%Y%m%d');dates.add(day)
        rows.append(dict(date=day,success=count(item.total_success),failure=count(item.total_fail),unknown=count(item.total_unknown)))
    if any(sum(row[key] for row in rows) != totals[key] for key in ('success','failure','unknown')):raise ValueError()
    return dict(status='available',**totals,days=sorted(rows,key=lambda row:row['date']))


def billing(data):
    amount=money(data.amount_sum)
    if type(data.scene_billing_list) is not list or len(data.scene_billing_list)>1000:raise ValueError()
    quantity=0
    for item in data.scene_billing_list:
        quantity+=count(item.add,string=True)
        money(item.amount)  # Validate without exporting business names or scene identifiers.
    return dict(status='available',quantity=count(quantity) if data.scene_billing_list else None,amount=amount,currency='CNY')


def error_reason(error):
    code=getattr(error,'code',None)
    status=getattr(error,'status_code',None)
    if status is None:status=getattr(error,'statusCode',None)
    if type(code) is str and code in _PERMISSION_CODES:
        return 'permission'
    if type(status) is int and status in (401,403):return 'permission'
    if type(status) is int and 400<=status<=599:return 'provider'
    return 'connection'


async def read_provider(window, *, client_factory=None):
    """At most one call per fixed read action. Never load credentials before authorization."""
    try:
        from alibabacloud_dypnsapi20170525.client import Client
        from alibabacloud_dypnsapi20170525 import models
        from alibabacloud_tea_openapi import models as openapi_models
        from alibabacloud_tea_util import models as util_models
        from darabonba.policy.retry import RetryOptions
        if client_factory is None:
            key_id=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID','')
            key_secret=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET','')
            if not key_id or not key_secret:
                for kind in _ACTIONS:query_diagnostic(kind, 'configuration', 'configuration')
                return dict(usage=unavailable('configuration'),billing=unavailable('configuration'))
            def client_factory():
                config=openapi_models.Config(access_key_id=key_id,access_key_secret=key_secret)
                config.endpoint='dypnsapi.aliyuncs.com';config.protocol='HTTPS'
                config.retry_options=RetryOptions(retryable=False)
                return Client(config)
    except (ImportError,AttributeError):
        for kind in _ACTIONS:query_diagnostic(kind, 'configuration', 'configuration')
        return dict(usage=unavailable('configuration'),billing=unavailable('configuration'))

    async def one(kind):
        shape = {}
        try:
            client=client_factory()
            _observe_decoded_call(client, shape)
            runtime=util_models.RuntimeOptions(connect_timeout=1000,read_timeout=2500,autoretry=False,max_attempts=1)
            async with asyncio.timeout(QUERY_TIMEOUT_SECONDS) as timer:
                if kind=='usage':
                    request=models.QueryGateVerifyStatisticPublicRequest(authentication_type=STATISTICS_AUTHENTICATION_TYPE,
                        start_date=window['start'],end_date=window['end'])
                    response=await client.query_gate_verify_statistic_public_with_options_async(request,runtime)
                else:
                    request=models.QueryGateVerifyBillingPublicRequest(authentication_type=BILLING_AUTHENTICATION_TYPE,month=window['month'])
                    response=await client.query_gate_verify_billing_public_with_options_async(request,runtime)
            if timer.expired():
                query_diagnostic(kind, 'timeout', 'timeout', shape=shape)
                return unavailable('timeout')
            body=getattr(response,'body',None)
            code=getattr(body,'code',None)
            status=getattr(response,'status_code',None)
            if type(status) is not int or status!=200 or type(code) is not str or code not in ('OK','200'):
                reason='permission' if type(code) is str and code in _PERMISSION_CODES or type(status) is int and status in (401,403) else 'provider'
                query_diagnostic(kind, 'response', reason, status, code, shape)
                return unavailable(reason)
            try:result=statistics(body.data,window) if kind=='usage' else billing(body.data)
            except (AttributeError,TypeError,ValueError,InvalidOperation,OverflowError):
                query_diagnostic(kind, 'response', 'invalid_response', status, code, shape)
                return unavailable('invalid_response')
            query_diagnostic(kind, 'response', 'success', status, code, shape)
            return result
        except TimeoutError:
            query_diagnostic(kind, 'timeout', 'timeout', shape=shape)
            return unavailable('timeout')
        except asyncio.CancelledError:
            query_diagnostic(kind, 'cancelled', 'cancelled', shape=shape)
            raise
        except Exception as error:
            reason=error_reason(error)
            status=getattr(error,'status_code',None)
            if status is None:status=getattr(error,'statusCode',None)
            query_diagnostic(kind, 'exception', reason, status, getattr(error,'code',None), shape)
            return unavailable(reason)
    usage,fees=await asyncio.gather(one('usage'),one('billing'))
    return dict(usage=usage,billing=fees)


class AdminProviderSmsMixin:
    def _provider_admin_verified(self, actor):
        self.ready()
        with self.transaction(actor) as db:
            self._admin(db,actor)

    async def provider_sms_summary(self, actor, body):
        window=query_window(body,self.now())
        await run_in_threadpool(self._provider_admin_verified,actor)
        # Authorization's protected DB connection and global lock are now released.
        reader=self.provider_reader or read_provider
        from .admin_provider_bss import read_package_purchases, result as bss_result, purchase_status_text
        bss_reader=getattr(self,'package_purchases_reader',None)
        if bss_reader is None:
            if self.provider_reader is not None:
                # Existing injected readers must remain free of new external I/O.
                async def bss_reader(cycle):return bss_result(cycle,'configuration')
            else:bss_reader=read_package_purchases
        result,package_purchases=await asyncio.gather(reader(window),
            bss_reader(window['month'][:4]+'-'+window['month'][4:]))
        # A revoked session/ownership while the provider was responding cannot leak data.
        await run_in_threadpool(self._provider_admin_verified,actor)
        return dict(**result,packagePurchases=package_purchases,generatedAt=self.stamp(),range=dict(start=window['start'],end=window['end'],month=window['month']),
            scope='当前阿里云账号下全部短信认证，未限定到弓行记方案。',
            definition='阿里云短信认证服务调用统计；成功调用不等于手机送达或App登录成功。缺少日期不补算为零。',
            billingDefinition='供应商返回的该月计费量与消费金额，可能更新；不是现金已扣款或套餐余额。',
            coverage='查询日期按北京时间生成；供应商日界、数据延迟及当前API版历史覆盖待控制台同范围核对。' + purchase_status_text(package_purchases),
            delivery=None,packageRemaining=None,cashPaid=None,maxExternalCalls=MAX_EXTERNAL_CALLS)

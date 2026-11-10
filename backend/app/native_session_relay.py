"""Fixed original-project Auth operations for an unavailable device network path.

No alternate identity provider, admin credential, or redirect. Only the phone OTP
relay may retry a server-bound, durable pre-write failure within its fixed lease.
Credentials remain in the original TLS request/response only.
"""
import json
import os
import re
import time
import asyncio
from urllib.error import HTTPError, URLError
from urllib.request import Request as UpstreamRequest, HTTPRedirectHandler, build_opener

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.auth import authenticated_user_id

ORIGIN = 'https://auth-4.example.invalid'
MAX_BODY = 4096
MAX_RESPONSE = 512 * 1024


def native_session_request(path, method, body=None, bearer=None):
    allowed = {('/user', 'GET'), ('/user', 'PUT'), ('/token?grant_type=password', 'POST'),
               ('/token?grant_type=refresh_token', 'POST'), ('/otp', 'POST'), ('/verify', 'POST')}
    key = os.getenv('SUPABASE_PUBLISHABLE_KEY', '')
    if (path, method) not in allowed or os.getenv('SUPABASE_URL', '').rstrip('/') != ORIGIN or not key or key.startswith('sb_secret_'):
        raise HTTPException(503, '原账号服务尚未安全接通')
    headers = {'Content-Type': 'application/json', 'apikey': key}
    if bearer:
        headers['Authorization'] = bearer
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = UpstreamRequest(ORIGIN + '/auth/v1' + path, method=method, headers=headers,
                              data=None if body is None else json.dumps(body).encode())
    try:
        with build_opener(NoRedirect).open(request, timeout=6) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError('bounded_response')
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError('response_shape')
        return result
    except HTTPError as error:
        # Inspect only bounded JSON inside this trusted process. Emit a fixed
        # classification, never a provider message or any private field.
        safe={
            'GXJ_SMS_TOTAL_LIMIT':(429,'gxj_sms_total_limit','短信累计额度已用完，请联系服务方恢复；无需反复发送'),
            'GXJ_SMS_MONTH_LIMIT':(429,'gxj_sms_month_limit','本月短信额度已用完，请在下月或服务方恢复容量后重试'),
            'GXJ_SMS_CAPACITY_EXPIRED':(503,'gxj_sms_capacity_expired','短信套餐已到期，请等待服务方恢复容量；无需反复发送'),
            'GXJ_SMS_DAY_LIMIT':(429,'gxj_sms_day_limit','今日短信额度已用完，请在下一额度周期重试'),
            'GXJ_SMS_PHONE_DAY_LIMIT':(429,'gxj_sms_phone_day_limit','此号码今日短信次数已用完，请在下一额度周期重试'),
            'GXJ_SMS_COOLDOWN':(429,'gxj_sms_cooldown','请间隔至少60秒再申请验证码'),
            'GXJ_SMS_DUPLICATE':(429,'gxj_sms_duplicate','本次请求已处理，请查看已收到的短信；不要重复提交'),
            'GXJ_SMS_RECIPIENT':(422,'gxj_phone_unsupported','暂不支持该手机号，请使用中国大陆手机号'),
            'GXJ_SMS_PROVIDER_UNCONFIRMED':(502,'gxj_sms_unknown','短信发送结果未确认，请查看已收到的短信；不要自动重发'),
            'GXJ_SMS_NOT_DISPATCHED':(422,'gxj_sms_rejected','本次短信明确未发送成功，未计入每日5次；请稍后重新申请'),
            'GXJ_SMS_PROVIDER_REJECTED':(422,'gxj_sms_rejected','本次短信明确未发送成功，未计入每日5次；请稍后重新申请'),
            'GXJ_SMS_GATE_UNAVAILABLE':(503,'gxj_sms_gate_unavailable','短信发送状态暂时无法核对，请稍后核对，不要自动重发'),
            'GXJ_PHONE_SIGNUP_CONFLICT':(409,'gxj_phone_signup_conflict','本次手机号验证暂时无法继续，请稍后重新获取验证码；已收到的验证码可直接填写'),
            'GXJ_PHONE_SIGNUP_UNAVAILABLE':(503,'gxj_phone_signup_unavailable','手机号注册服务暂未就绪，请稍后重试'),
            'GXJ_PHONE_SIGNUP_REJECTED':(422,'gxj_phone_signup_rejected','手机号注册未通过核对，请检查号码或稍后重试'),
            'GXJ_REGISTRATION_INVITE_UNAVAILABLE':(409,'gxj_registration_invite_unavailable','邀请准备未通过，注册未继续；请读取原邀请进度后再操作'),
            'otp_disabled':(422,'otp_disabled','当前手机号未通过本次登录模式核对，短信尚未发送；请核对原账号或进入注册流程'),
            'otp_expired':(422,'otp_expired','验证码不匹配、已使用或已过期，请核对本次最新验证码'),
            'over_sms_send_rate_limit':(429,'gxj_sms_cooldown','请间隔至少60秒再申请验证码'),
            'signup_disabled':(503,'signup_disabled','手机号注册尚未开放，请等待服务接通'),
            'phone_provider_disabled':(503,'phone_provider_disabled','短信验证服务暂未就绪，请等待服务接通'),
            'hook_timeout':(502,'gxj_sms_unknown','短信服务等待超时，发送结果未确认；请查看短信，不要自动重发'),
            'same_password':(422,'same_password','新密码不能与当前密码相同，请更换新密码'),
            'invalid_credentials':(400,'gxj_invalid_credentials','手机号或密码不正确，请核对后重试'),
            'weak_password':(422,'weak_password','新密码未通过安全规则，请使用至少8位的英文字母、数字和特殊符号组合'),
            'reauthentication_needed':(401,'reauthentication_needed','本次找回验证已失效，请返回验证码步骤重新验证；不会自动发送短信'),
            'reauthentication_not_valid':(401,'reauthentication_not_valid','本次找回验证未通过，请返回验证码步骤重新验证；不会自动发送短信'),
        }
        classification=None
        retry_after=None
        retry_signal=None
        auth_frequency_wait=None
        try:
            raw=error.read(8193)
            value=json.loads(raw) if len(raw)<=8192 else {}
            public_code=value.get('error_code',value.get('code')) if isinstance(value,dict) else None
            upstream_message = value.get('msg',value.get('message','')) if isinstance(value,dict) else ''
            if isinstance(upstream_message, str):
                match = re.search(r'\bGXJ_RETRY_AFTER_SECONDS=([0-9]{1,2})(?![0-9])', upstream_message)
                if match and int(match.group(1)) <= 60:
                    retry_after = int(match.group(1))
                elif public_code == 'over_sms_send_rate_limit':
                    # Auth's per-phone frequency response has a computed wait.
                    # A project-wide rate limit may omit it: do not invent one.
                    match = re.fullmatch(r'For security purposes, you can only request this after ([0-9]{1,2}) seconds\.?', upstream_message)
                    if match and int(match.group(1)) <= 60:
                        retry_after = int(match.group(1))
                        if path == '/otp' and method == 'POST' and error.code == 429:
                            auth_frequency_wait = retry_after
            if path=='/otp' and error.code==422 and public_code != 'otp_disabled':
                from app.sms_retry_operation import parse_receipt
                retry_signal=parse_receipt(upstream_message,retry_after)
            # Only Auth's exact OTP 422 is evidence of a pre-send mode rejection.
            if public_code in safe and (public_code != 'otp_disabled' or (path == '/otp' and error.code == 422)):
                classification=safe[public_code]
            elif isinstance(value,dict):
                message=value.get('msg',value.get('message',''))
                if isinstance(message,str):
                    classification=next((item for marker,item in safe.items() if marker.startswith('GXJ_') and marker+':' in message),None)
        except Exception:
            pass
        if auth_frequency_wait is not None:
            from app.sms_retry_operation import AuthFrequencyLimited
            raise AuthFrequencyLimited(auth_frequency_wait) from None
        if retry_signal is not None:
            raise retry_signal from None
        if classification:
            status,code,message=classification
            if public_code == 'over_sms_send_rate_limit' and retry_after is None:
                code, message = 'gxj_sms_rate_limit', '短信服务当前请求过多，请稍后再试'
            detail={'code':code,'message':message}
            if code.startswith('gxj_sms_') and retry_after is not None:
                detail['retryAfterSeconds']=retry_after
            raise HTTPException(status,detail) from None
        if path == '/otp' and error.code >= 500:
            raise HTTPException(502, {'code':'gxj_sms_unknown',
                'message':'短信发送结果未确认，请查看已收到的短信；不要自动重发'}) from None
        messages = {400: '账号或验证码未通过核验，请核对本次输入',
                    401: '登录状态已失效，请使用原账号重新登录',
                    403: '账号验证未通过，请核对原账号',
                    422: '账号验证请求未通过核对',
                    429: '请求过于频繁，请稍后重试'}
        raise HTTPException(error.code if error.code in messages else 502,
                            messages.get(error.code, '账号服务结果未确认，请勿自动重发')) from None
    except (URLError, OSError, ValueError):
        if path == '/otp':
            raise HTTPException(502, {'code':'gxj_sms_unknown',
                'message':'短信发送结果未确认，请查看已收到的短信；不要自动重发'}) from None
        raise HTTPException(502, '账号服务结果未确认，原资料保持；请勿自动重发') from None


async def _body(request, fields):
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        raise HTTPException(415, '请使用正确的账号请求格式')
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY:
            raise HTTPException(413, '账号请求过大')
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) - fields:
            raise ValueError('fields')
        return value
    except (ValueError, UnicodeError):
        # FastAPI's ordinary validation input echo is deliberately avoided.
        raise HTTPException(422, '账号请求格式未通过核对') from None


def _phone(value):
    if not isinstance(value, str) or not re.fullmatch(r'\+861[3-9]\d{9}', value):
        raise HTTPException(422, '请输入有效的中国大陆手机号')
    return value


def _session(result):
    if (not isinstance(result.get('access_token'), str) or not 1 <= len(result['access_token']) <= 16384
            or not isinstance(result.get('refresh_token'), str) or not 1 <= len(result['refresh_token']) <= 4096
            or type(result.get('expires_in')) is not int or not 0 < result['expires_in'] <= 86400):
        raise HTTPException(502, '账号会话结果未能核对，请勿自动重发')
    return {name: result[name] for name in ('access_token', 'refresh_token', 'expires_in')}


def _admitted_session(result):
    session = _session(result)
    private_headers = {'Cache-Control': 'no-store', 'Pragma': 'no-cache'}
    # The upstream may have issued/rotated credentials just before deletion
    # became pending. Only trusted server configuration activates this check.
    if os.getenv('GONGXINGJI_SERVERLESS_DB') != '1' and os.getenv('ACCOUNT_DELETION_ENABLED') != '1':
        return session
    if os.getenv('AUTH_MODE') != 'supabase':
        raise HTTPException(503, '账号会话结果尚未核对，请勿自动重发', headers=private_headers)
    try:
        authenticated_user_id('Bearer '+session['access_token'])
    except HTTPException as error:
        if error.status_code in (401, 403):
            raise HTTPException(401, '账号会话已失效或正在注销，请读取原注销进度', headers=private_headers) from None
        raise HTTPException(503, '账号会话结果尚未核对，请勿自动重发', headers=private_headers) from None
    except Exception:
        raise HTTPException(503, '账号会话结果尚未核对，请勿自动重发', headers=private_headers) from None
    # A failed admission never repeats the upstream password/refresh/verify
    # operation. In particular, an unknown refresh must not rotate twice.
    return session


def _reply(value):
    return JSONResponse(value, headers={'Cache-Control': 'no-store', 'Pragma': 'no-cache'})


def _sms_retry_after(phone):
    # Auth does not forward arbitrary hook output fields. Read the shared ledger
    # after a successful Auth response; never restart a 60s interval at response.
    from app.db import SessionLocal
    from app.sms_send_gate import PostgresSendGate, SmsSendBudget
    return PostgresSendGate(SessionLocal, SmsSendBudget.from_env()).retry_after(phone, time.time())


def create_native_session_router(upstream=native_session_request, *, registration_rewards_enabled=False,
                                 sms_cooldown_reader=_sms_retry_after, sms_retry_store=None):
    router = APIRouter(prefix='/api/auth/native-session')

    @router.get('/user')
    def user(authorization: str | None = Header(default=None)):
        if not authorization or len(authorization) > 16391:
            raise HTTPException(401, '请先登录')
        owner = authenticated_user_id(authorization)
        result = upstream('/user', 'GET', None, authorization)
        if result.get('id') != owner or result.get('is_anonymous') is not False:
            raise HTTPException(401, '原账号身份未能核对')
        return _reply({name: result.get(name) for name in ('id', 'email', 'phone', 'phone_confirmed_at', 'created_at')})

    @router.post('/password')
    async def password(request: Request):
        body = await _body(request, {'phone', 'email', 'password'})
        secret = body.get('password')
        if not isinstance(secret, str) or not 1 <= len(secret) <= 1024 or ('phone' in body) == ('email' in body):
            raise HTTPException(422, '请填写原账号和密码')
        if 'phone' in body:
            _phone(body['phone'])
        elif not isinstance(body['email'], str) or len(body['email']) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', body['email']):
            raise HTTPException(422, '请输入有效邮箱')
        result = await run_in_threadpool(upstream, '/token?grant_type=password', 'POST', body)
        return _reply(await run_in_threadpool(_admitted_session, result))

    @router.put('/user')
    async def update_password(request: Request, authorization: str | None = Header(default=None)):
        if not authorization or len(authorization) > 16391:
            raise HTTPException(401, '请先完成原账号验证')
        owner = await run_in_threadpool(authenticated_user_id, authorization)
        body = await _body(request, {'password'})
        secret = body.get('password')
        if (not isinstance(secret, str) or not 8 <= len(secret) <= 1024
                or not re.search(r'[A-Za-z]', secret) or not re.search(r'[0-9]', secret)
                or not re.search(r'[!-/:-@\[-`{-~]', secret)):
            raise HTTPException(422, '新密码须至少8位，包含英文字母、数字和特殊符号')
        # Check the live original account before the one permitted mutation.
        user = await run_in_threadpool(upstream, '/user', 'GET', None, authorization)
        if user.get('id') != owner or user.get('is_anonymous') is not False:
            raise HTTPException(401, '原账号身份未能核对，未提交新密码')
        result = await run_in_threadpool(upstream, '/user', 'PUT', body, authorization)
        # A malformed acknowledgement after dispatch is unknown, never a refusal
        # that would authorize a second password write.
        if result.get('id') != owner or result.get('is_anonymous') is not False:
            raise HTTPException(502, '新密码提交结果未确认，请用新密码核对登录；不要重复改密')
        return _reply({'id': owner, 'password_updated': True})

    @router.post('/refresh')
    async def refresh(request: Request):
        body = await _body(request, {'refresh_token'})
        token = body.get('refresh_token')
        if not isinstance(token, str) or not 1 <= len(token) <= 3000:
            raise HTTPException(422, '登录续接请求未通过核对')
        result = await run_in_threadpool(upstream, '/token?grant_type=refresh_token', 'POST', body)
        return _reply(await run_in_threadpool(_admitted_session, result))

    @router.post('/phone-otp')
    async def phone_otp(request: Request):
        body = await _body(request, {'phone', 'create_user', 'channel', 'data'})
        _phone(body.get('phone'))
        if type(body.get('create_user')) is not bool or body.get('channel') != 'sms':
            raise HTTPException(422, '请使用正确的手机号验证方式')
        if body['create_user'] and os.getenv('PUBLIC_PHONE_REGISTRATION_ENABLED') != '1':
            raise HTTPException(503, '手机号注册尚未开放，请等待服务接通')
        if 'data' in body:
            metadata = body['data']
            if (registration_rewards_enabled is not True or body['create_user'] is not True
                    or not isinstance(metadata, dict) or set(metadata) != {'gxj_reward_registration'}
                    or not isinstance(metadata['gxj_reward_registration'], str)
                    or not re.fullmatch(r'[A-Za-z0-9_-]{43}', metadata['gxj_reward_registration'])):
                raise HTTPException(422, '注册进度绑定未通过核对')
        if sms_retry_store is None:
            await run_in_threadpool(upstream, '/otp', 'POST', body)
        else:
            from app.sms_retry_operation import send_phone_otp
            operation_remaining=await send_phone_otp(upstream,sms_retry_store,body)
        result = {'sent': True, 'deliveryStatus': 'accepted'}
        if sms_retry_store is not None:
            if type(operation_remaining) is int and 0<=operation_remaining<=60:
                result['retryAfterSeconds']=operation_remaining
            return _reply(result)
        try:
            remaining = await asyncio.wait_for(asyncio.to_thread(sms_cooldown_reader, body['phone']),timeout=0.5)
            if type(remaining) is int and 0 <= remaining <= 60:
                result['retryAfterSeconds'] = remaining
        except Exception:
            # The Auth send already succeeded. Missing ancillary countdown is
            # not a failed send and must never trigger a second request.
            pass
        return _reply(result)

    @router.post('/phone-verify')
    async def phone_verify(request: Request):
        body = await _body(request, {'phone', 'token', 'type'})
        _phone(body.get('phone'))
        if body.get('type') != 'sms' or not isinstance(body.get('token'), str) or not re.fullmatch(r'\d{6}', body['token']):
            raise HTTPException(422, '请核对本次六位验证码')
        result = await run_in_threadpool(upstream, '/verify', 'POST', body)
        return _reply(await run_in_threadpool(_admitted_session, result))

    return router

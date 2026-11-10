"""Allow recovery/login only after independent, phone-first email proof.

Unapproved signup emails remain rejected. A hook success means delivery via
the configured mail transport; returning {} alone does not invoke native SMTP.
"""
import json
import os
import time
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from app.sms_hook import MAX_BODY_BYTES, InvalidHookSignature, verify_standard_webhook
from app.sms_hook import canonical_mainland_phone

def create_email_auth_hook_router(secret=None,clock=time.time,recovery_store=None,binding_store=None,enrollment_store=None,change_store=None):
    router=APIRouter()
    configured=secret if secret is not None else os.getenv('SUPABASE_SEND_EMAIL_HOOK_SECRET','')

    @router.post('/auth/hooks/send-email')
    async def guard_email_credentials(request:Request):
        body=bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body)>MAX_BODY_BYTES:
                return JSONResponse(status_code=413,content={'error':{'http_code':413,'message':'请求过大'}})
        try:
            verify_standard_webhook(bytes(body),request.headers,configured,clock())
        except (InvalidHookSignature,ValueError):
            return JSONResponse(status_code=401,content={'error':{'http_code':401,'message':'请求未通过验证'}})
        try:
            payload=json.loads(bytes(body))
            data=payload.get('email_data') if isinstance(payload,dict) else None
            user=payload.get('user') if isinstance(payload,dict) else None
            if (recovery_store is not None and isinstance(data,dict)
                    and data.get('email_action_type')=='magiclink'
                    and isinstance(user,dict) and canonical_mainland_phone(user.get('phone'))):
                from fastapi import HTTPException
                try:
                    await run_in_threadpool(recovery_store.login,request.headers.get('webhook-id'),user,data.get('token'))
                except HTTPException as error:
                    # Native Auth retries transport 5xx. A completed hook
                    # response with an error rejects Auth without replaying
                    # an unknown SMTP send and hiding it behind a cooldown.
                    return JSONResponse(status_code=200 if error.status_code>=500 else error.status_code,content={'error':{'http_code':error.status_code,'message':error.detail}})
                return {}
            if enrollment_store is not None and isinstance(data,dict) and data.get('email_action_type') in ('signup','magiclink'):
                from fastapi import HTTPException
                try:
                    await run_in_threadpool(enrollment_store.hook,request.headers.get('webhook-id'),payload.get('user'),data)
                except HTTPException as error:
                    return JSONResponse(status_code=error.status_code,content={'error':{'http_code':error.status_code,'message':error.detail}})
                return {}
            if (binding_store is not None or change_store is not None) and isinstance(data,dict) and data.get('email_action_type')=='email_change':
                from fastapi import HTTPException
                try:
                    user=payload.get('user')
                    if not isinstance(user,dict):
                        raise HTTPException(403,'invalid_signed_user')
                    if user.get('email') not in (None,'') and change_store is not None:
                        await run_in_threadpool(change_store.capture_email_change,request.headers.get('webhook-id'),user,data)
                    else:
                        if binding_store is None:
                            raise HTTPException(403,'first_binding_unavailable')
                        if change_store is not None:
                            await run_in_threadpool(change_store.assert_first_email_target_available,user)
                        await run_in_threadpool(binding_store.hook,request.headers.get('webhook-id'),user,data)
                except HTTPException as error:
                    return JSONResponse(status_code=error.status_code,content={'error':{'http_code':error.status_code,'message':error.detail}})
                return {}
            if recovery_store is not None and isinstance(data,dict) and data.get('email_action_type')=='recovery':
                from fastapi import HTTPException
                try:
                    await run_in_threadpool(recovery_store.recovery,request.headers.get('webhook-id'),payload.get('user'),data.get('token'))
                except HTTPException as error:
                    return JSONResponse(status_code=error.status_code,content={'error':{'http_code':error.status_code,'message':error.detail}})
                return {}
        except (ValueError,UnicodeDecodeError,TypeError):
            return JSONResponse(status_code=400,content={'error':{'http_code':400,'message':'邮件请求无效'}})
        return JSONResponse(status_code=403,content={'error':{'http_code':403,'message':'请先验证手机，并在账号安全验证邮箱；也可使用已验证手机找回'}})
    return router

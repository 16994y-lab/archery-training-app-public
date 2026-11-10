"""Default-closed, signed Before User Created hook for a controlled phone trial."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.sms_hook import (
    MAX_BODY_BYTES, InvalidHookSignature, _decoded_secrets, verify_standard_webhook,
)
from app.sms_send_gate import SmsSendBudget


@dataclass(frozen=True)
class PhoneSignupSettings:
    enabled: bool = False
    signing_secrets: str = ""

    @classmethod
    def from_env(cls) -> PhoneSignupSettings:
        return cls(os.getenv("PHONE_SIGNUP_HOOK_ENABLED") == "1",
                   os.getenv("SUPABASE_BEFORE_USER_CREATED_HOOK_SECRET", ""))

    def ready(self) -> bool:
        if not self.enabled:
            return False
        try:
            _decoded_secrets(self.signing_secrets)
        except ValueError:
            return False
        return True


def _reject(status: int, *, acknowledged=False, code='GXJ_PHONE_SIGNUP_REJECTED') -> JSONResponse:
    # Use the Supabase hook error contract; never reflect payload data or secrets.
    return JSONResponse(status_code=200 if acknowledged else status, content={"error": {
        "http_code": status, "message": code+': 手机号注册未能完成，请核对号码和服务状态',
    }})


def create_phone_signup_router(*, settings: PhoneSignupSettings | None = None,
                               budget: SmsSendBudget | None = None,
                               clock=time.time, signup_guard=None,
                               allow_email: bool | None = None, email_enrollment=None, registration_receipts=None) -> APIRouter:
    settings = settings if settings is not None else PhoneSignupSettings.from_env()
    budget = budget if budget is not None else SmsSendBudget.from_env()
    router = APIRouter()
    allow_email = os.getenv('ACCOUNT_PHONE_BINDING_ENABLED')=='1' if allow_email is None else allow_email

    @router.post("/auth/hooks/before-user-created")
    async def before_user_created(request: Request):
        if not settings.ready() or not budget.ready():
            return _reject(503)
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            return _reject(415)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                return _reject(413)
        try:
            verify_standard_webhook(bytes(body), request.headers, settings.signing_secrets, clock())
        except (InvalidHookSignature, ValueError):
            return _reject(401)
        try:
            payload = json.loads(body)
            user = payload["user"]
            phone = user.get("phone")
            email = user.get("email")
            anonymous = user.get("is_anonymous", False)
            provider = user.get("app_metadata", {}).get("provider")
        except (UnicodeDecodeError, ValueError, KeyError, TypeError, AttributeError):
            return _reject(400)
        if allow_email and provider=='email' and anonymous is False and phone in (None,'') and isinstance(email,str) and len(email)<=254 and re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):
            if email_enrollment is not None:
                try:
                    return await run_in_threadpool(email_enrollment.before_create, request.headers.get('webhook-id'), user)
                except Exception:
                    return _reject(403,acknowledged=True)
            # Email is a password-login identifier, never proof of ownership.
            # It creates only a pending identity; backend business routes still
            # require a confirmed mainland phone on this very same UID.
            return {}
        if email not in (None, "") or anonymous is not False or provider != "phone":
            return _reject(403,acknowledged=True)
        if budget.registration_phone_digest(phone) is None:
            return _reject(403,acknowledged=True)
        if budget.public_phone_registration and signup_guard is None:
            return _reject(503,acknowledged=True,code='GXJ_PHONE_SIGNUP_UNAVAILABLE')
        if signup_guard is not None:
            try:
                await run_in_threadpool(signup_guard,phone,user.get('id'))
            except HTTPException as error:
                status,code={409:(409,'GXJ_PHONE_SIGNUP_CONFLICT'),429:(429,'GXJ_SMS_COOLDOWN')}.get(error.status_code,(503,'GXJ_PHONE_SIGNUP_UNAVAILABLE'))
                return _reject(status,acknowledged=True,code=code)
            except Exception:
                return _reject(503,acknowledged=True,code='GXJ_PHONE_SIGNUP_UNAVAILABLE')
        # No invitation keeps the existing public signup path. An explicitly
        # selected invitation must bind successfully before Auth creates a UID.
        metadata = user.get('user_metadata')
        invitation_selected = isinstance(metadata, dict) and 'gxj_reward_registration' in metadata
        if invitation_selected and registration_receipts is None:
            return _reject(503,acknowledged=True,code='GXJ_REGISTRATION_INVITE_UNAVAILABLE')
        if registration_receipts is not None:
            try:
                await run_in_threadpool(registration_receipts.before_create, request.headers.get('webhook-id'), user)
            except Exception:
                # No payload/exception logging: later authenticated read reports unproven.
                if invitation_selected:
                    return _reject(503,acknowledged=True,code='GXJ_REGISTRATION_INVITE_UNAVAILABLE')
        # New mode retains a private ownership reservation before Auth creates
        # the future UID. No provider request or SMS-send reservation occurs.
        return {}

    return router

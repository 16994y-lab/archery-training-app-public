"""Proposed replacement router. Root owns registration/capabilities/Hook wiring.

All routes retain actual JWT authenticated_user_id. An unchanged closed store
still denies phone actions. No dependency overrides, token returns or Admin API.
"""
from typing import Literal
from fastapi import APIRouter,Depends,Header,HTTPException
from pydantic import BaseModel,ConfigDict,Field
from uuid import UUID
from app.auth import authenticated_user_id

class Strict(BaseModel):model_config=ConfigDict(extra='forbid',strict=True)
class Begin(Strict):
    kind:Literal['email','phone']
    target:str=Field(min_length=3,max_length=254)
    lost_channel:bool=False
class Intent(Strict):intent:str=Field(pattern=r'^[0-9a-f-]{36}$')
class Target(Intent):target:str=Field(min_length=3,max_length=254)
class Verify(Target):
    leg:Literal['old','new']
    # Preliminary union only: the owned PG intent selects exact 8/6 below.
    token:str=Field(pattern=r'^(?:[0-9]{8}|[0-9]{6})$')
class Authority(Strict):
    intent:str=Field(pattern=r'^[0-9a-f-]{36}$')
    target:str=Field(min_length=3,max_length=254)
    token:str=Field(pattern=r'^[0-9]{6}$')
class Preflight(Strict):
    kind:Literal['email','phone']
    target:str=Field(min_length=3,max_length=254)

def create_round10_router(store,preflight):
    router=APIRouter(prefix='/api/auth/channel-change')
    def call(method,owner,*args):
        try:return getattr(store,method)(str(UUID(owner)),*args)
        except HTTPException:raise
        except (ValueError,TypeError,AttributeError):raise HTTPException(401,'account_identity_invalid') from None
        except Exception:raise HTTPException(503,'channel_change_result_unknown') from None
    @router.get('/status')
    def status(owner=Depends(authenticated_user_id)):return call('status',owner)
    @router.post('/begin')
    def begin(body:Begin,owner=Depends(authenticated_user_id)):return call('begin',owner,body.kind,body.target,body.lost_channel)
    @router.post('/target-check')
    def target_check(body:Preflight,owner=Depends(authenticated_user_id)):
        try:return preflight.check(str(UUID(owner)),body.kind,body.target)
        except HTTPException:raise
        except Exception:raise HTTPException(503,'target_check_unknown') from None
    @router.post('/old-start')
    def old_start(body:Intent,authorization:str|None=Header(default=None),owner=Depends(authenticated_user_id)):
        return call('old_start',owner,body.intent,authorization)
    @router.post('/old-verify')
    def old_verify(body:Authority,authorization:str|None=Header(default=None),owner=Depends(authenticated_user_id)):
        return call('old_verify',owner,body.intent,body.token,body.target,authorization)
    @router.post('/request')
    def request(body:Target,authorization:str|None=Header(default=None),owner=Depends(authenticated_user_id)):
        return call('request_native',owner,body.intent,body.target,authorization)
    @router.post('/verify')
    def verify(body:Verify,authorization:str|None=Header(default=None),owner=Depends(authenticated_user_id)):
        return call('verify_native',owner,body.intent,body.leg,body.token,body.target,authorization)
    @router.post('/cancel')
    def cancel(body:Intent,owner=Depends(authenticated_user_id)):return call('cancel',owner,body.intent)
    @router.post('/reconcile')
    def reconcile(body:Intent,authorization:str|None=Header(default=None),owner=Depends(authenticated_user_id)):
        return call('status',owner,body.intent,authorization)
    return router

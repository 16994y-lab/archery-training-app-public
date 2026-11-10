"""Separate bounded cron endpoint. No secret in URL, body, logs or response."""
import hmac
import os
from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse

MAX_BATCH=25
PATH='/api/photo-contributions/cleanup'


def create_contribution_cleanup_router(cleanup, *, environment=None):
    router=APIRouter()
    def reply(status,code,**values):
        return JSONResponse({'state':code,**values},status_code=status,headers={'Cache-Control':'no-store'})
    @router.get(PATH)
    def run(request:Request,authorization:str|None=Header(default=None)):
        # Even authenticated callers cannot choose a table, owner, path or batch.
        if request.query_params or request.headers.get('content-length','0')!='0' or request.headers.get('transfer-encoding'):
            return reply(422,'CONTRIBUTION_CLEANUP_INVALID_REQUEST')
        try:
            env=os.environ if environment is None else environment
            secret=env.get('CRON_SECRET','')
            if not isinstance(secret,str) or not 32<=len(secret)<=8192:
                return reply(503,'CONTRIBUTION_CLEANUP_NOT_CONFIGURED')
            expected='Bearer '+secret
            if not authorization or len(authorization)!=len(expected) or not hmac.compare_digest(authorization,expected):
                return reply(401,'CONTRIBUTION_CLEANUP_UNAUTHORIZED')
            result=cleanup(MAX_BATCH)
            if (type(result) is not dict or set(result)!={'examined','deleted','unknown'}
                or any(type(n) is not int or not 0<=n<=MAX_BATCH for n in result.values())
                or result['deleted']+result['unknown']!=result['examined']):
                return reply(503,'CONTRIBUTION_CLEANUP_UNCONFIRMED')
            # Unknown DELETE remains read-only on future runs in the worker.
            state='PENDING_READBACK' if result['unknown'] else ('BATCH_LIMIT_REACHED' if result['examined']==MAX_BATCH else 'BATCH_CHECKED')
            # These counts describe this bounded batch only. No aggregate scan
            # or natural scheduler evidence exists to assert a deadline SLA.
            return reply(200,state,counts=result,deadlineState='deadlineUnknown',
                         pendingInBatch=result['unknown'],queueRemaining='unknown')
        except Exception:
            return reply(503,'CONTRIBUTION_CLEANUP_UNCONFIRMED')
    return router

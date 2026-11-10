"""Owned read-only target preflight. No reservation/send and no epoch creation."""
from fastapi import HTTPException
from sqlalchemy import text
from app.account_next_compat import admit,FeatureScope,schema_revision,REVISION
from app.account_next_channel import reject

class PostgresTargetPreflight:
    def __init__(self,changes):self.changes=changes
    def check(self,owner,kind,target):
        c=self.changes;c._require_channel(kind)
        probing=not c.enabled and c.contract_probe is not None
        if probing and not c.contract_probe.owner_live(owner,c.clock()):reject('channel_change_closed',503)
        with c.factory.begin() as s:
            user,epoch=c._inspect(s,owner)
            if schema_revision(s)!=REVISION:reject('channel_migration_required',503)
            scope=FeatureScope((c.contract_probe.owner,),()) if probing else c.scope
            admit(s,owner,user,scope,legacy_owners=c.allowed)
            if s.execute(text('SELECT enabled FROM account_next.policy WHERE singleton')).scalar_one() is not True:
                reject('channel_change_closed',503)
            address,digest=c._address(kind,target,owner,session=s)
            if probing and not c.contract_probe.target_matches(digest):reject('contract_probe_scope_mismatch',403)
            if c._address(kind,user[kind],owner,session=s)[0]==address:
                return {'available':False,'reason':'unchanged','reservationCreated':False}
            try:c._available(s,owner,kind,address,digest)
            except HTTPException as error:
                if error.status_code!=409:raise
                return {'available':False,'reason':'unavailable','reservationCreated':False}
        return {'available':True,'reason':'available_at_read','reservationCreated':False}

# This is an observation only; begin repeats checks atomically and owns the
# unique reservation. A preflight true is neither a grant nor a stable promise.

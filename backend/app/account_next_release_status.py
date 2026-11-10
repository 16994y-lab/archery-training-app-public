"""Additive owned facts for Root's status wiring; no authority or mutation."""
from sqlalchemy import text
from fastapi import HTTPException

def owned_release_status(session,owner,intent):
    op=session.execute(text('SELECT intent,kind,target_digest FROM account_next.intents WHERE intent=CAST(:intent AS uuid) AND owner=CAST(:owner AS uuid)'),{'intent':intent,'owner':owner}).mappings().one_or_none()
    if not op:raise HTTPException(404,'intent_not_found')
    held=session.execute(text('SELECT count(*) FROM account_next.reservations WHERE intent=:intent AND owner=CAST(:owner AS uuid) AND kind=:kind AND target_digest=:digest'),{'intent':op['intent'],'owner':owner,'kind':op['kind'],'digest':op['target_digest']}).scalar_one()
    available=session.execute(text("SELECT to_regclass('account_next.support_release_audits') IS NOT NULL")).scalar_one()
    audited=False
    if available is True:
        audited=session.execute(text('SELECT EXISTS(SELECT 1 FROM account_next.support_release_audits WHERE intent=:intent)'),{'intent':op['intent']}).scalar_one() is True
    # An absent row alone is UNKNOWN, never a successful support release.
    return {'reservationHeld':True if held else False if audited else None,'releaseRecorded':audited}

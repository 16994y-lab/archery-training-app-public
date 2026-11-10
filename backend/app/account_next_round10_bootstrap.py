"""Root registration candidate. All new account capabilities default closed.

Phone capability has its OWN default-false Native attestation; accepting the
email R01 contract does not open phone rebind. Invitations remain independent.
"""
import os
from fastapi import Depends
from app.account_next_probe import from_environment
from app.account_next_compat import REVISION
from app.account_next_channel import PostgresChannelChanges
from app.account_next_delivery import ChannelChangeDelivery
from app.account_next_round10_router import create_round10_router
from app.account_next_target import PostgresTargetPreflight
from app.account_next_invitations import PostgresInvitations,create_invitations_router

def configure_round10(app,factory,account,email,migration_ready, *, native_redirect_base=''):
    guard=os.getenv('ACCOUNT_NEXT_GUARD_ENABLED')=='1'
    requested={name:os.getenv(name)=='1' for name in ('ACCOUNT_CHANNEL_CHANGE_ENABLED','ACCOUNT_CHANNEL_EMAIL_CHANGE_ENABLED','ACCOUNT_CHANNEL_PHONE_CHANGE_ENABLED','ACCOUNT_INVITATIONS_ENABLED')}
    if not guard:
        if any(requested.values()):raise RuntimeError('persistent_account_next_guard_required')
        return None,None
    if not account or not email:raise RuntimeError('existing_account_email_guards_required')
    probe=from_environment(os.environ)  # rejects probe/ordinary overlap
    phone=requested['ACCOUNT_CHANNEL_PHONE_CHANGE_ENABLED'] and os.getenv('ACCOUNT_PHONE_CHANNEL_HOSTED_CONTRACT_VERIFIED')=='1'
    channels=tuple(x for x,on in [('email',requested['ACCOUNT_CHANNEL_EMAIL_CHANGE_ENABLED'] or probe is not None),('phone',phone)] if on)
    split=lambda name:tuple(x.strip() for x in os.getenv(name,'').split(',') if x.strip())
    changes=PostgresChannelChanges(email,account,__import__('app.account_auth',fromlist=['auth_upstream']).auth_upstream,
        enabled=requested['ACCOUNT_CHANNEL_CHANGE_ENABLED'],enabled_channels=channels,contract_probe=probe,
        hosted_contract_verified=os.getenv('ACCOUNT_CHANNEL_HOSTED_CONTRACT_VERIFIED')=='1',reservation_guard_installed=True,
        change_delivery=ChannelChangeDelivery(email.delivery.settings),test_owner_ids=split('ACCOUNT_CHANNEL_TEST_OWNER_IDS'),
        enrollment_test_digests=split('ACCOUNT_CHANNEL_ENROLLMENT_TEST_DIGESTS'), native_redirect_base=native_redirect_base)
    email.probe_send_guard=changes.probe_send_allowed if probe else None
    email.post_change_authorizer=changes.post_change_mail_allowed
    email.recovery_authorizer=changes.proven_email_recovery_allowed
    gate=lambda:migration_ready(REVISION)
    app.include_router(create_round10_router(changes,PostgresTargetPreflight(changes)),dependencies=[Depends(gate)])
    invites=PostgresInvitations(account,os.getenv('SMS_HOOK_PHONE_HASH_KEY',''),allowed_owners=split('ACCOUNT_INVITATION_TEST_OWNER_IDS'),
        enabled=requested['ACCOUNT_INVITATIONS_ENABLED'],email_security=email,enrollment_test_digests=split('ACCOUNT_INVITATION_ENROLLMENT_TEST_DIGESTS'))
    app.include_router(create_invitations_router(invites),dependencies=[Depends(gate)])
    return changes,invites

def sms_recipient_policy(account,changes):
    # Existing first-binding/login/recovery policy is FIRST, quota unchanged.
    def approve(phone):return account.approved_recipient(phone) or changes.approved_sms_recipient(phone)
    return approve

# Root's index.py must inject changes into signed SMS dispatch AFTER signature
# validation and BEFORE unchanged gate.reserve/transport (separate patch).
# No support-release public registration exists here.

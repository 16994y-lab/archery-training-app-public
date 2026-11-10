"""Wire existing identity and private operations, without DDL or network I/O."""
import os
from sqlalchemy import select
from app.rewards import RewardsWorkspace, create_rewards_router
from app.registration_rewards import RegistrationRewards, create_registration_rewards_router
from app.registration_models import RegistrationPair
from app.admin_operations import AdminOperations, create_operations_router


def install_product_operations(app, factory, team_schema_gate):
    from fastapi import Depends
    team_enabled = os.getenv("TEAM_WORKSPACE_ENABLED") == "1"
    rewards_enabled = team_enabled and os.getenv("REWARDS_ENABLED") == "1"
    reward_writes = rewards_enabled and os.getenv("REWARDS_WRITES_ENABLED") == "1"
    registration_enabled = reward_writes and os.getenv("REGISTRATION_REWARDS_ENABLED") == "1"
    operations_enabled = team_enabled and os.getenv("PRODUCT_OPERATIONS_ENABLED") == "1"
    secret = os.getenv("SMS_HOOK_PHONE_HASH_KEY", "")
    rewards = RewardsWorkspace(factory, enabled=rewards_enabled, writes_enabled=reward_writes,
                               secret=secret, service=os.getenv("SUPABASE_URL", ""))
    registration = RegistrationRewards(rewards, secret, enabled=registration_enabled)
    rewards.invitation_revoker = registration.revoke_pair

    def registration_profile(db, uid):
        incoming = db.scalar(select(RegistrationPair).where(RegistrationPair.service == rewards.service,
                                                          RegistrationPair.invitee_id == uid))
        outgoing = db.scalars(select(RegistrationPair).where(RegistrationPair.service == rewards.service,
            RegistrationPair.inviter_id == uid).order_by(RegistrationPair.registration_id).limit(51)).all()
        return {"inviterId": incoming.inviter_id if incoming else None,
                "state": incoming.state if incoming else None,
                "invitees": [{"userId": row.invitee_id, "state": row.state} for row in outgoing[:50]],
                "hasMore": len(outgoing)>50, "status": "available"}

    operations = AdminOperations(factory, enabled=operations_enabled, rewards=rewards, registration_profile=registration_profile)
    app.include_router(create_rewards_router(service_instance=rewards, failure_observer=operations.observe_failure), dependencies=[Depends(team_schema_gate)])
    # Signed pre-create recording is attached to the ORIGINAL Hook below. Anonymous
    # preparation has its own readiness/abuse bounds and must not require a session.
    app.include_router(create_registration_rewards_router(registration))
    app.include_router(create_operations_router(service_instance=operations), dependencies=[Depends(team_schema_gate)])
    return registration, registration_enabled, operations.observe_failure

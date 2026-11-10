"""Explicit record-save rollout; reads never enable uploads or contribution."""
import os
from uuid import UUID
from fastapi import Depends, Header, HTTPException
from sqlalchemy.exc import SQLAlchemyError


def backup_verified_actor(authorization: str | None = Header(default=None)) -> str:
    # Lazy import: the existing team score projection imports mobile validators.
    from app.team_workspace import team_actor, team_verified_user_id
    try:
        owner = team_verified_user_id(authorization)
        return team_actor(owner, authorization)
    except SQLAlchemyError:
        raise HTTPException(503, '云记录身份核验暂不可用') from None


def manual_backup_actor(owner: str = Depends(backup_verified_actor)) -> str:
    if os.getenv('AUTH_MODE') != 'supabase':
        raise HTTPException(503, '完整云备份尚未开放')
    # Both branches use the original verified-phone actor and the transaction
    # checks its live Auth session. GET does not opt this device into PUT.
    if os.getenv('AUTOMATIC_RECORDS_SAVE_ENABLED') == '1':
        return owner
    if os.getenv('MANUAL_BACKUP_ENABLED') != '1':
        raise HTTPException(503, '完整云备份尚未开放')
    allowed = tuple(filter(None, (v.strip() for v in os.getenv('MANUAL_BACKUP_ALLOWED_OWNER_IDS', '').split(','))))
    try:
        if not allowed or len(set(allowed)) != len(allowed) or any(str(UUID(v)) != v for v in allowed):
            raise ValueError('invalid allowlist')
    except ValueError:
        raise HTTPException(503, '完整云备份账号范围尚未配置') from None
    if owner not in allowed:
        raise HTTPException(403, '此账号尚未获准使用完整云备份')
    return owner

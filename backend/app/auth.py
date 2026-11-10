"""Verifier for Supabase asymmetric access tokens.

Production never receives a Supabase signing secret. It downloads the public
JWKS document for the configured project, caches it briefly, and only accepts
the ES256 tokens issued for that project.
"""
import json
import os
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import jwt
from fastapi import Header, HTTPException


LOCAL_USER_ID = "local-dev"
JWKS_CACHE_SECONDS = 3600
_jwks_cache: tuple[float, dict[str, dict]] | None = None


def _supabase_url() -> str:
    """Return a safe project origin rather than trusting a client token issuer."""
    value = os.getenv("SUPABASE_URL", "").rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path:
        raise HTTPException(503, "认证服务尚未配置")
    return value


def _fetch_jwks(jwks_url: str) -> dict[str, dict]:
    """Fetch only Supabase public keys; no secret is ever requested."""
    try:
        request = Request(jwks_url, headers={"Accept": "application/json"})
        with urlopen(request, timeout=5) as response:  # nosec B310: URL is validated project config
            payload = json.loads(response.read())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(503, "认证公钥暂时不可用") from error
    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not isinstance(keys, list):
        raise HTTPException(503, "认证公钥格式无效")
    indexed = {item["kid"]: item for item in keys if isinstance(item, dict) and isinstance(item.get("kid"), str)}
    if not indexed:
        raise HTTPException(503, "认证公钥暂时不可用")
    return indexed


def _jwks_for(url: str, *, refresh: bool = False) -> dict[str, dict]:
    global _jwks_cache
    now = time.monotonic()
    if not refresh and _jwks_cache and _jwks_cache[0] > now:
        return _jwks_cache[1]
    keys = _fetch_jwks(f"{url}/auth/v1/.well-known/jwks.json")
    _jwks_cache = (now + JWKS_CACHE_SECONDS, keys)
    return keys


def _verification_key(url: str, token: str):
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as error:
        raise HTTPException(401, "登录凭证格式无效") from error
    if header.get("alg") != "ES256" or not isinstance(header.get("kid"), str):
        raise HTTPException(401, "登录凭证无效")
    key_id = header["kid"]
    jwk = _jwks_for(url).get(key_id)
    if jwk is None:
        jwk = _jwks_for(url, refresh=True).get(key_id)
    if jwk is None:
        raise HTTPException(401, "登录凭证无效")
    try:
        return jwt.algorithms.ECAlgorithm.from_jwk(json.dumps(jwk))
    except (TypeError, ValueError, jwt.PyJWTError) as error:
        raise HTTPException(503, "认证公钥格式无效") from error


def verified_access_claims(authorization: str | None) -> dict:
    """Cryptographic verification only; privileged callers also check live state."""
    if not isinstance(authorization, str) or len(authorization) > 16391 or not authorization.startswith("Bearer "):
        raise HTTPException(401, "请先登录")
    url = _supabase_url()
    token = authorization.removeprefix("Bearer ")
    try:
        claims = jwt.decode(
            token,
            _verification_key(url, token),
            algorithms=["ES256"],
            audience="authenticated",
            issuer=f"{url}/auth/v1",
            options={"require": ["aud", "exp", "sub"]},
        )
    except jwt.ExpiredSignatureError as error:
        raise HTTPException(401, "登录已过期") from error
    except jwt.PyJWTError as error:
        raise HTTPException(401, "登录凭证无效") from error
    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise HTTPException(401, "登录凭证无效")
    return claims


def authenticated_user_id(authorization: str | None = Header(default=None)) -> str:
    """Verified UID plus live admission after account deletion is deployed.

    Database barriers, not this admission query, stop concurrent post-delete DML.
    Development remains local-only and can never use the deletion router.
    """
    if os.getenv("AUTH_MODE", "development") == "development":
        return LOCAL_USER_ID
    claims = verified_access_claims(authorization)
    if os.getenv('GONGXINGJI_SERVERLESS_DB') == '1' or os.getenv('ACCOUNT_DELETION_ENABLED') == '1':
        from app.account_deletion import require_live_account_session
        require_live_account_session(claims)
    return claims['sub']


def current_user_id(authorization: str | None = Header(default=None)) -> str:
    owner=authenticated_user_id(authorization)
    if (os.getenv('AUTH_MODE')=='supabase' and os.getenv('GONGXINGJI_SERVERLESS_DB')=='1'
            and os.getenv('ACCOUNT_PHONE_BINDING_ENABLED')!='1'):
        raise HTTPException(503,'测试账号的手机验证门禁尚未接入')
    if os.getenv('ACCOUNT_PHONE_BINDING_ENABLED')=='1' and os.getenv('AUTH_MODE')=='supabase':
        from app.account_auth import PostgresAccountStore
        from app.db import SessionLocal
        from app.sms_send_gate import SmsSendBudget
        if not PostgresAccountStore(SessionLocal,SmsSendBudget.from_env()).status(owner)['phoneVerified']:
            raise HTTPException(403,'请先绑定并验证中国大陆手机号')
    return owner

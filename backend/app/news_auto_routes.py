"""Server-only Cron authentication; public output contains only news material."""
import hmac
import os
from datetime import datetime, timezone
from fastapi import APIRouter, Header, HTTPException, Response
from .news_auto import BudgetFetcher, collect, encode
from .news_auto_store import NewsStore

def news_router(sessions, fetch_factory=BudgetFetcher):
    router = APIRouter()
    store = NewsStore(sessions)

    def enabled():
        if os.getenv('GONGXINGJI_NEWS_AUTO_READY') != 'true':
            raise HTTPException(503, 'NEWS_NOT_ENABLED')

    @router.get('/api/news/publication.v1.json')
    def publication():
        enabled()
        try:
            raw = encode(store.read())
        except Exception:
            raise HTTPException(503, 'NEWS_TEMPORARILY_UNAVAILABLE') from None
        return Response(raw, media_type='application/json', headers={
            'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'})

    @router.get('/api/news/refresh')
    def refresh(authorization: str | None = Header(default=None)):
        enabled()
        secret = os.getenv('CRON_SECRET', '')
        if len(secret) < 32:
            raise HTTPException(503, 'NEWS_CRON_NOT_CONFIGURED')
        expected = 'Bearer ' + secret
        if not authorization or len(authorization) != len(expected) or not hmac.compare_digest(authorization, expected):
            raise HTTPException(401, 'NEWS_CRON_UNAUTHORIZED')
        day = datetime.now(timezone.utc).date()
        try:
            claim = store.claim(day.isoformat())
        except Exception:
            raise HTTPException(503, 'NEWS_STORAGE_UNAVAILABLE') from None
        if claim is None:
            return {'state': 'ALREADY_CHECKED_OR_RUNNING'}
        token, prior_sha, current = claim
        try:
            bundle, counts = collect(current, fetch_factory(), day)
        except Exception:
            # Network/core failure preserves the last publication; no unknown DB commit replay.
            try:
                store.release(token)
            except Exception:
                pass
            raise HTTPException(503, 'NEWS_COLLECTION_FAILED') from None
        try:
            sha = store.publish(token, prior_sha, bundle, day.isoformat())
        except Exception:
            raise HTTPException(503, 'NEWS_PUBLICATION_UNCONFIRMED') from None
        return {'state': 'PUBLISHED' if counts['published'] else 'UNCHANGED',
                'revision': bundle['feed']['revision'], 'contentSHA256': sha, 'counts': counts}

    return router

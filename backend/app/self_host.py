"""Small authenticated web profile for the public-source training application."""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from app.auth import _jwks_for, current_user_id, verified_access_claims
from app.self_host_db import check_runtime_database, database_engine, postgres_url


def _origin(value, *, local_http=False):
    if not value or any(character.isspace() for character in value):
        return False
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        return False
    if not url.hostname or url.username is not None or url.password is not None or url.path or url.query or url.fragment:
        return False
    if url.hostname.endswith(".invalid") or port == 0:
        return False
    return url.scheme == "https" or (
        local_http and url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
    )


def _training_route(path):
    if path.endswith("/photo-confirmations"):
        return False
    return path in {"/api/targets", "/api/plan-templates"} or any(
        path == prefix or path.startswith(prefix + "/")
        for prefix in ("/api/training-plans", "/api/training-sessions", "/api/history")
    )


def require_identity(authorization: str | None = Header(default=None)):
    # Never select the shared local-development identity in this entry point.
    claims = verified_access_claims(authorization)
    try:
        return str(UUID(claims["sub"]))
    except ValueError:
        raise HTTPException(401, "登录凭证无效") from None


def _serve_web(app, directory):
    root = Path(directory).resolve()
    if not (root / "index.html").is_file() or not (root / "assets").is_dir():
        raise RuntimeError("SELF_HOST_WEB_ROOT must point to the output of the legacy web build")

    @app.get("/", include_in_schema=False)
    @app.get("/index.html", include_in_schema=False)
    def index():
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    def serve_file(path):
        def response():
            return FileResponse(path, headers={"Cache-Control": "no-cache"})
        return response

    for name in ("manifest.webmanifest", "icon.svg", "service-worker.js"):
        if (root / name).is_file():
            app.add_api_route(f"/{name}", serve_file(root / name), include_in_schema=False)
    for name in ("assets", "ui", "fonts"):
        if (root / name).is_dir():
            app.mount(f"/{name}", StaticFiles(directory=root / name), name=name)


def create_app():
    if os.environ.get("AUTH_MODE") != "supabase":
        raise RuntimeError("The self-host backend requires AUTH_MODE=supabase")
    auth_origin = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not _origin(auth_origin):
        raise RuntimeError("SUPABASE_URL must be your own HTTPS Supabase project origin")
    origins = [
        value.strip() for value in os.environ.get("CORS_ORIGINS", "").split(",")
        if value.strip()
    ]
    if not all(_origin(origin, local_http=True) for origin in origins):
        raise RuntimeError("CORS_ORIGINS must list exact HTTPS or local loopback origins")
    database_url = postgres_url("DATABASE_URL")
    if os.environ.get("MIGRATION_DATABASE_URL"):
        raise RuntimeError("Do not pass the migration-owner connection to the web process")

    from app.main import app as existing_api, get_db

    engine = database_engine(database_url)
    runtime_sessions = sessionmaker(bind=engine, autoflush=False)

    def get_runtime_db():
        with runtime_sessions() as session:
            yield session

    @asynccontextmanager
    async def lifespan(app):
        try:
            try:
                check_runtime_database(engine)
            except SQLAlchemyError:
                raise RuntimeError("Self-host PostgreSQL is unavailable or not migrated") from None
            try:
                keys = _jwks_for(auth_origin, refresh=True)
            except HTTPException:
                raise RuntimeError("Supabase public signing keys could not be loaded") from None
            if not any(
                key.get("kty") == "EC" and key.get("crv") == "P-256" and key.get("alg", "ES256") == "ES256"
                for key in keys.values()
            ):
                raise RuntimeError("Supabase must publish a P-256 (ES256) JWT signing key")
            yield
        finally:
            engine.dispose()

    app = FastAPI(title="弓行记自托管训练 API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.dependency_overrides.update({current_user_id: require_identity, get_db: get_runtime_db})
    routes = [route for route in existing_api.routes if isinstance(route, APIRoute) and _training_route(route.path)]
    app.include_router(APIRouter(routes=routes), dependencies=[Depends(require_identity)])

    @app.middleware("http")
    async def protect_api_responses(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(SQLAlchemyError)
    async def database_failure(request, error):
        return JSONResponse(status_code=503, content={"detail": "训练资料服务暂时不可用"})

    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "If-Match"],
        )

    @app.get("/health")
    def health():
        return {"status": "ok"}

    web_root = os.environ.get("SELF_HOST_WEB_ROOT")
    if web_root:
        _serve_web(app, web_root)
    return app

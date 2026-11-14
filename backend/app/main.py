import csv
import io
import json
import os
from datetime import date
from typing import Literal
from uuid import UUID
from collections.abc import Generator

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db import SessionLocal
from app.auth import current_user_id
from app.models import PlanBlock, PlanStatus, TrainingPlan
from app.plans import TEMPLATES, ensure_built_in_targets, get_plan, plan_to_dict, save_plan, start_session
from app.sessions import add_arrow, confirm_end, confirm_session, delete_arrow, delete_history, export_history, get_session, history_detail, history_snapshot, history_statistics, latest_draft, list_history, redo_end, undo_arrow, update_arrow, update_history, update_history_arrow
from app.sessions import confirm_photo_arrows
from app.sessions import finish_early
from app.target_contracts import snapshot_for_target
from app.mobile_documents import router as mobile_documents_router
from app.score_backup import router as score_backup_router
from app.community import router as community_router
from app.private_media import router as private_media_router
from app.media_archive import router as media_archive_router

app = FastAPI(title="Archery Training API", version="0.1.0")
app.include_router(mobile_documents_router)
app.include_router(score_backup_router)
app.include_router(community_router)
app.include_router(private_media_router)
app.include_router(media_archive_router)
if os.getenv("GONGXINGJI_ONLINE_TIMER_DISPLAY") == "1":
    from app.timer_display import create_timer_display_router
    app.include_router(create_timer_display_router(SessionLocal))
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","), allow_methods=["*"], allow_headers=["*"])


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class PlanBlockInput(BaseModel):
    block_type: str
    title: str
    instructions: str | None = None
    end_count: int | None = None
    arrows_per_end: int | None = None
    duration_minutes: int | None = None
    is_scored: bool = False


class PlanInput(BaseModel):
    name: str
    description: str | None = None
    bow_type: str
    distance_m: float
    target_definition_id: str
    default_end_count: int
    default_arrows_per_end: int
    equipment_note: str | None = None
    blocks: list[PlanBlockInput] = Field(min_length=1)


class ArrowInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: UUID | None = None
    score_code: str | None = None
    x_norm: float | None = None
    y_norm: float | None = None
    plot_x_norm: float | None = None
    plot_y_norm: float | None = None
    target_face_index: int | None = None
    source: str


class PhotoArrowInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: UUID
    plot_x_norm: float = Field(ge=0, le=1)
    plot_y_norm: float = Field(ge=0, le=1)
    target_face_index: int = Field(ge=1, le=3)


class PhotoConfirmationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: Literal[True]
    arrows: list[PhotoArrowInput] = Field(min_length=1, max_length=12)


class HistoryInput(BaseModel):
    note: str | None = Field(default=None, max_length=2000)
    equipment_note: str | None = Field(default=None, max_length=500)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def check_revision(current: int, if_match: str | None) -> None:
    """Reject a stale cloud write without discarding the local pending change."""
    if if_match is None:
        return  # Local development and clients predating sync remain usable.
    try:
        expected = int(if_match.strip('"'))
    except ValueError as error:
        raise HTTPException(400, "If-Match 必须是修订号") from error
    if current != expected:
        raise HTTPException(409, "云端记录已在另一台设备更新；本机待同步内容已保留，请处理冲突后重试")


def require_revision(if_match: str | None, label: str = "记分写入") -> int:
    if if_match is None:
        raise HTTPException(428, f"{label}必须携带当前修订号")
    try:
        return int(if_match.strip('"'))
    except ValueError as error:
        raise HTTPException(400, "If-Match 必须是修订号") from error


@app.get("/api/targets")
def list_targets(db: Session = Depends(get_db)) -> list[dict]:
    return [snapshot_for_target(item) for item in ensure_built_in_targets(db)]


@app.get("/api/plan-templates")
def list_templates() -> list[dict]:
    return list(TEMPLATES)


@app.get("/api/training-plans")
def list_plans(db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> list[dict]:
    ensure_built_in_targets(db)
    plans = db.scalars(select(TrainingPlan).options(selectinload(TrainingPlan.blocks)).where(TrainingPlan.owner_id == user_id).order_by(TrainingPlan.status, TrainingPlan.updated_at.desc()))
    return [plan_to_dict(item) for item in plans]


@app.post("/api/training-plans", status_code=201)
def create_plan(payload: PlanInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict:
    ensure_built_in_targets(db)
    return plan_to_dict(save_plan(db, payload.model_dump(), owner_id=user_id))


@app.put("/api/training-plans/{plan_id}")
def update_plan(plan_id: str, payload: PlanInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    ensure_built_in_targets(db)
    plan = get_plan(db, plan_id, user_id)
    check_revision(plan.revision, if_match)
    return plan_to_dict(save_plan(db, payload.model_dump(), plan))


@app.post("/api/training-plans/{plan_id}/copy", status_code=201)
def copy_plan(plan_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict:
    plan = get_plan(db, plan_id, user_id)
    copied = plan_to_dict(plan)
    copied["name"] = f"{plan.name}（副本）"
    return plan_to_dict(save_plan(db, copied, source_plan_id=plan.id, owner_id=user_id))


@app.post("/api/training-plans/{plan_id}/archive")
def archive_plan(plan_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    plan = get_plan(db, plan_id, user_id)
    check_revision(plan.revision, if_match)
    plan.status = PlanStatus.ARCHIVED
    plan.revision += 1
    db.commit()
    return plan_to_dict(get_plan(db, plan_id))


@app.post("/api/training-plans/{plan_id}/start", status_code=201)
def create_session_from_plan(plan_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict:
    session = start_session(db, get_plan(db, plan_id, user_id))
    return {"id": session.id, "status": session.status, "training_plan_id": session.training_plan_id, "planned_end_count": session.planned_end_count, "arrows_per_end": session.arrows_per_end}


@app.get("/api/training-sessions/drafts/latest")
def get_latest_draft(db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict | None:
    return latest_draft(db, user_id)


@app.get("/api/training-sessions/{session_id}")
def get_training_session(session_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict:
    return get_session(db, session_id, user_id)


@app.post("/api/training-sessions/{session_id}/ends/{end_sequence}/arrows")
def create_arrow(session_id: str, end_sequence: int, payload: ArrowInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return add_arrow(db, session_id, end_sequence, payload.model_dump(mode="json"), owner_id=user_id, expected_revision=expected)


@app.post("/api/training-sessions/{session_id}/ends/{end_sequence}/photo-confirmations")
def save_photo_confirmation(session_id: str, end_sequence: int, payload: PhotoConfirmationInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match, "照片确认")
    return confirm_photo_arrows(db, session_id, end_sequence, payload.model_dump(mode="json")["arrows"], expected, user_id)


@app.put("/api/training-sessions/{session_id}/ends/{end_sequence}/arrows/{arrow_sequence}")
def replace_arrow(session_id: str, end_sequence: int, arrow_sequence: int, payload: ArrowInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return update_arrow(db, session_id, end_sequence, arrow_sequence, payload.model_dump(mode="json"), user_id, expected)


@app.delete("/api/training-sessions/{session_id}/ends/{end_sequence}/arrows/{arrow_sequence}")
def remove_arrow(session_id: str, end_sequence: int, arrow_sequence: int, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return delete_arrow(db, session_id, end_sequence, arrow_sequence, user_id, expected)


@app.post("/api/training-sessions/{session_id}/ends/{end_sequence}/undo")
def undo_last_arrow(session_id: str, end_sequence: int, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return undo_arrow(db, session_id, end_sequence, user_id, expected)


@app.post("/api/training-sessions/{session_id}/ends/{end_sequence}/redo")
def clear_end_for_redo(session_id: str, end_sequence: int, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return redo_end(db, session_id, end_sequence, user_id, expected)


@app.post("/api/training-sessions/{session_id}/ends/{end_sequence}/confirm")
def confirm_scored_end(session_id: str, end_sequence: int, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return confirm_end(db, session_id, end_sequence, user_id, expected)


@app.post("/api/training-sessions/{session_id}/confirm")
def confirm_completed_session(session_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match)
    return confirm_session(db, session_id, user_id, expected)["session"]


@app.post("/api/training-sessions/{session_id}/finish-early")
def finish_recorded_session(session_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    return finish_early(db, session_id, user_id, require_revision(if_match, "提前结束"))


@app.get("/api/history")
def get_history(target_id: str | None = None, bow_type: str | None = None, distance_m: float | None = None, db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> list[dict]:
    return list_history(db, target_id, bow_type, distance_m, user_id)


@app.get("/api/history/statistics")
def get_history_statistics(db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict:
    return history_statistics(db, user_id)


@app.get("/api/history/snapshot")
def get_history_snapshot(
    range_kind: Literal["WEEK", "MONTH"] = Query(),
    start_local_date: date = Query(),
    end_local_date_exclusive: date = Query(),
    time_zone: str = Query(min_length=1, max_length=128),
    db: Session = Depends(get_db),
    user_id: str = Depends(current_user_id),
) -> dict:
    return history_snapshot(db, range_kind, start_local_date, end_local_date_exclusive, time_zone, user_id)


@app.get("/api/history/sessions/{session_id}")
def get_history_detail(session_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> dict:
    return history_detail(db, session_id, user_id)


@app.put("/api/history/sessions/{session_id}")
def edit_history(session_id: str, payload: HistoryInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match, "历史写入")
    return update_history(db, session_id, payload.model_dump(), expected, user_id)


@app.put("/api/history/sessions/{session_id}/ends/{end_sequence}/arrows/{arrow_sequence}")
def edit_history_arrow(session_id: str, end_sequence: int, arrow_sequence: int, payload: ArrowInput, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> dict:
    expected = require_revision(if_match, "历史写入")
    return update_history_arrow(db, session_id, end_sequence, arrow_sequence, payload.model_dump(mode="json"), expected, user_id)


@app.delete("/api/history/sessions/{session_id}", status_code=204)
def remove_history(session_id: str, db: Session = Depends(get_db), user_id: str = Depends(current_user_id), if_match: str | None = Header(default=None)) -> Response:
    expected = require_revision(if_match, "历史写入")
    delete_history(db, session_id, expected, user_id)
    return Response(status_code=204)


@app.get("/api/history/export.json")
def export_json(db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> Response:
    return Response(content=json.dumps(export_history(db, user_id), ensure_ascii=False), media_type="application/json", headers={"Content-Disposition": "attachment; filename=archery-history.json"})


@app.get("/api/history/export.csv")
def export_csv(db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> Response:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["session_id", "confirmed_at", "target", "bow_type", "distance_m", "end", "arrow", "score_code", "x_norm", "y_norm"])
    for record in export_history(db, user_id):
        session = record["session"]
        for end in session["ends"]:
            for arrow in end["arrows"]:
                writer.writerow([session["id"], session["confirmed_at"], session["target"]["name"], session.get("bow_type", ""), session["distance_m"], end["sequence"], arrow["sequence"], arrow["score_code"], arrow["x_norm"], arrow["y_norm"]])
    return Response(content="\ufeff" + output.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=archery-history.csv"})


@app.delete("/api/account/data", status_code=204)
def delete_account_data(db: Session = Depends(get_db), user_id: str = Depends(current_user_id)) -> Response:
    """Erase only this user's training data; account deletion stays in Supabase."""
    for item in list_history(db, owner_id=user_id):
        delete_history(db, item["id"], get_session(db, item["id"], user_id)["revision"], user_id)
    for plan in db.scalars(select(TrainingPlan).where(TrainingPlan.owner_id == user_id)).all():
        for block in list(plan.blocks):
            db.delete(block)
        db.delete(plan)
    db.commit()
    return Response(status_code=204)

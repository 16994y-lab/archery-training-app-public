"""Local scoring, confirmed-history, and statistics services."""

import hashlib
import json
from datetime import date, datetime, timezone
from math import isfinite, sqrt
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session, joinedload, selectinload

from app.models import Arrow, ArrowSource, End, EndStatus, SessionStatus, TrainingSession
from app.scoring import ScoreCode, score_from_plot_coordinate, summarize_scores
from app.target_contracts import TargetContractError, resolve_target_contract


def _get_session(db: Session, session_id: str, owner_id: str | None = None) -> TrainingSession:
    query = (
        select(TrainingSession)
        .options(selectinload(TrainingSession.ends).selectinload(End.arrows))
        .where(TrainingSession.id == session_id)
    )
    if owner_id is not None:
        query = query.where(TrainingSession.owner_id == owner_id)
    session = db.scalar(query)
    if session is None:
        raise HTTPException(404, "未找到训练草稿")
    return session


def _arrow_to_dict(arrow: Arrow) -> dict:
    return {"id": arrow.id, "sequence": arrow.sequence, "score_code": arrow.score_code, "x_norm": arrow.x_norm, "y_norm": arrow.y_norm, "plot_x_norm": arrow.plot_x_norm, "plot_y_norm": arrow.plot_y_norm, "target_face_index": arrow.target_face_index, "source": arrow.source}


def _end_to_dict(end: End) -> dict:
    arrows = sorted(end.arrows, key=lambda item: item.sequence)
    summary = summarize_scores(ScoreCode(item.score_code) for item in arrows)
    return {
        "id": end.id,
        "sequence": end.sequence,
        "expected_arrow_count": end.expected_arrow_count,
        "status": end.status,
        "arrows": [_arrow_to_dict(arrow) for arrow in arrows],
        "summary": {"arrow_count": summary.arrow_count, "total_score": summary.total_score, "x_count": summary.x_count, "ten_count": summary.ten_count},
    }


def session_to_dict(session: TrainingSession) -> dict:
    ends = sorted((e for e in session.ends if session.completion_mode != "EARLY" or e.arrows), key=lambda item: item.sequence)
    try:
        target = resolve_target_contract(session.target_snapshot)
    except TargetContractError as error:
        raise HTTPException(422, str(error)) from error
    return {
        "id": session.id, "revision": session.revision,
        "status": session.status,
        "completion_mode": session.completion_mode,
        "bow_type": session.bow_type,
        "target": target,
        "distance_m": session.distance_m,
        "planned_end_count": session.planned_end_count,
        "arrows_per_end": session.arrows_per_end,
        "note": session.note,
        "equipment_note": session.equipment_note,
        "confirmed_at": session.confirmed_at.isoformat() if session.confirmed_at else None,
        "ends": [_end_to_dict(end) for end in ends],
    }


def get_session(db: Session, session_id: str, owner_id: str | None = None) -> dict:
    return session_to_dict(_get_session(db, session_id, owner_id))


def latest_draft(db: Session, owner_id: str | None = None) -> dict | None:
    query = (
        select(TrainingSession)
        .options(selectinload(TrainingSession.ends).selectinload(End.arrows))
        .where(TrainingSession.status != SessionStatus.CONFIRMED)
        .order_by(TrainingSession.updated_at.desc())
    )
    if owner_id is not None:
        query = query.where(TrainingSession.owner_id == owner_id)
    session = db.scalar(query)
    return session_to_dict(session) if session else None


def _target_face_index(target: dict, requested: int | None) -> int | None:
    if target["scoring_mode"] == "SCORE_ONLY":
        if requested is not None:
            raise HTTPException(422, "自定义数字靶面不应填写靶面序号")
        return None
    if target["face_count"] == 1:
        if requested not in (None, 1):
            raise HTTPException(422, "单靶面的靶面序号只能是 1")
        return 1
    valid_faces = {face["index"] for face in target["layout"]["faces"]}
    if requested not in valid_faces:
        raise HTTPException(422, f"多联靶请选择 1–{target['face_count']} 号靶面")
    return requested


def _validate_and_normalize_arrow(target: dict, payload: dict, *, photo_confirmed: bool = False) -> dict:
    try:
        target = resolve_target_contract(target)
    except TargetContractError as error:
        raise HTTPException(422, str(error)) from error
    source = payload.get("source")
    if source not in (ArrowSource.MANUAL_NUMBER, ArrowSource.MANUAL_TARGET) and not (photo_confirmed and source == ArrowSource.VISION_CONFIRMED):
        raise HTTPException(422, "仅支持数字或点击靶面录入")
    face_index = _target_face_index(target, payload.get("target_face_index"))
    x_norm, y_norm = payload.get("x_norm"), payload.get("y_norm")
    plot_x, plot_y = payload.get("plot_x_norm"), payload.get("plot_y_norm")
    if source == ArrowSource.MANUAL_NUMBER:
        if x_norm is not None or y_norm is not None or plot_x is not None or plot_y is not None:
            raise HTTPException(422, "数字录入不能带坐标")
        try:
            score_code = ScoreCode(payload.get("score_code"))
        except (TypeError, ValueError) as error:
            raise HTTPException(422, "请选择有效环数") from error
        if score_code.value not in target["allowed_score_codes"]:
            raise HTTPException(422, "该靶面不支持此环数")
        return {"score_code": score_code.value, "x_norm": None, "y_norm": None, "plot_x_norm": None, "plot_y_norm": None, "target_face_index": face_index, "source": source}
    # MANUAL_TARGET
    if target["scoring_mode"] != "RING_GEOMETRY":
        raise HTTPException(422, "自定义数字靶面不支持点击录入")
    if plot_x is None or plot_y is None or not all(isinstance(v, (int, float)) and isfinite(v) and 0 <= v <= 1 for v in (plot_x, plot_y)):
        raise HTTPException(422, "画布坐标必须成对位于 0–1")
    score_code, target_coords = score_from_plot_coordinate(target, float(plot_x), float(plot_y))
    if score_code.value not in target["allowed_score_codes"]:
        raise HTTPException(422, "该靶面不支持此环数")
    if target_coords is not None:
        tx, ty = target_coords
        return {"score_code": score_code.value, "x_norm": tx, "y_norm": ty, "plot_x_norm": float(plot_x), "plot_y_norm": float(plot_y), "target_face_index": face_index, "source": source}
    # 点在白区：M，有 plot 坐标，x_norm/y_norm 为 NULL
    if "M" not in target["allowed_score_codes"]:
        raise HTTPException(422, "该靶面不支持此环数")
    return {"score_code": "M", "x_norm": None, "y_norm": None, "plot_x_norm": float(plot_x), "plot_y_norm": float(plot_y), "target_face_index": face_index, "source": source}


def _get_or_create_end(db: Session, session: TrainingSession, end_sequence: int) -> End:
    if session.status in (SessionStatus.CONFIRMED, SessionStatus.DISCARDED):
        raise HTTPException(409, "训练已经结束，请在复盘中校正成绩")
    if not 1 <= end_sequence <= session.planned_end_count:
        raise HTTPException(422, "组序号超出本次训练范围")
    for end in session.ends:
        if end.sequence == end_sequence:
            return end
    if any(next((end for end in session.ends if end.sequence == sequence), None) is None or next(end for end in session.ends if end.sequence == sequence).status != EndStatus.CONFIRMED for sequence in range(1, end_sequence)):
        raise HTTPException(409, "请先确认前一组")
    end = End(id=str(uuid4()), training_session_id=session.id, sequence=end_sequence, expected_arrow_count=session.arrows_per_end, status=EndStatus.DRAFT)
    db.add(end)
    session.ends.append(end)
    return end


def _set_session_in_progress(session: TrainingSession) -> None:
    session.status = SessionStatus.IN_PROGRESS


def _make_end_editable(end: End, session: TrainingSession) -> None:
    if end.status == EndStatus.CONFIRMED:
        end.status = EndStatus.DRAFT
        end.confirmed_at = None
    _set_session_in_progress(session)


def _claim_revision(db: Session, session: TrainingSession, expected_revision: int, owner_id: str | None, message: str) -> None:
    clauses = [TrainingSession.id == session.id, TrainingSession.revision == expected_revision]
    if owner_id is not None:
        clauses.append(TrainingSession.owner_id == owner_id)
    claimed = db.execute(
        update(TrainingSession).where(*clauses).values(revision=expected_revision + 1, updated_at=datetime.now())
        .execution_options(synchronize_session="fetch")
    )
    if claimed.rowcount != 1:
        db.rollback()
        raise HTTPException(409, message)


def _check_loaded_revision(session: TrainingSession, expected_revision: int, message: str) -> None:
    """Fast stale-request rejection; _claim_revision remains the concurrency authority."""
    if session.revision != expected_revision:
        raise HTTPException(409, message)


def add_arrow(db: Session, session_id: str, end_sequence: int, payload: dict, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    """Append one arrow atomically; a stable client Arrow ID makes exact replay read-only."""
    try:
        session = _get_session(db, session_id, owner_id)
        if expected_revision is None:
            expected_revision = session.revision
        normalized = _validate_and_normalize_arrow(session.target_snapshot, payload)
        arrow_id = str(payload.get("id") or uuid4())
        existing = db.get(Arrow, arrow_id)
        end = next((item for item in session.ends if item.sequence == end_sequence), None)
        if existing is not None:
            if end is not None and existing.end_id == end.id and all(getattr(existing, key) == value for key, value in normalized.items()):
                return session_to_dict(session)
            raise HTTPException(409, "箭点标识已使用且内容不一致，请核对本组成绩")
        if session.revision != expected_revision:
            raise HTTPException(409, "记录版本已变化；本机待同步内容已保留，请处理冲突后重试")
        if session.status in (SessionStatus.CONFIRMED, SessionStatus.DISCARDED) or (end and end.status == EndStatus.CONFIRMED):
            raise HTTPException(409, "只能向未确认的当前组追加箭点")
        if not 1 <= end_sequence <= session.planned_end_count:
            raise HTTPException(422, "组序号超出本次训练范围")
        if any(not any(item.sequence == seq and item.status == EndStatus.CONFIRMED for item in session.ends) for seq in range(1, end_sequence)):
            raise HTTPException(409, "请先确认前一组")
        count = len(end.arrows) if end else 0
        capacity = end.expected_arrow_count if end else session.arrows_per_end
        if count >= capacity:
            raise HTTPException(409, "本组箭数已满，请先修改、撤销或确认")
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化；本机待同步内容已保留")
        if end is None:
            end = _get_or_create_end(db, session, end_sequence)
        elif end.status == EndStatus.CONFIRMED:
            end.status = EndStatus.DRAFT
            end.confirmed_at = None
        session.status = SessionStatus.IN_PROGRESS
        arrow = Arrow(id=arrow_id, end_id=end.id, sequence=count + 1, **normalized)
        db.add(arrow)
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def update_arrow(db: Session, session_id: str, end_sequence: int, arrow_sequence: int, payload: dict, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        expected_revision = session.revision if expected_revision is None else expected_revision
        _check_loaded_revision(session, expected_revision, "记录版本已变化；修改未覆盖当前成绩")
        end = _get_or_create_end(db, session, end_sequence)
        arrow = next((item for item in end.arrows if item.sequence == arrow_sequence), None)
        if arrow is None:
            raise HTTPException(404, "未找到该箭")
        normalized = _validate_and_normalize_arrow(session.target_snapshot, payload)
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化；修改未覆盖当前成绩")
        _make_end_editable(end, session)
        for key, value in normalized.items():
            setattr(arrow, key, value)
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def confirm_photo_arrows(db: Session, session_id: str, end_sequence: int, arrows: list[dict], expected_revision: int, owner_id: str) -> dict:
    """One reviewed batch, one revision, one transaction. Existing Arrow IDs deduplicate retries.

    No photo, calibration, or unreviewed candidate is persisted. An exact replay is
    read-only, even after subsequent scoring; reused IDs with different data fail.
    """
    try:
        session = _get_session(db, session_id, owner_id)
        ids = [item["id"] for item in arrows]
        if not 1 <= len(ids) <= 12 or len(set(ids)) != len(ids):
            raise HTTPException(422, "照片箭点数量无效或标识重复")
        normalized = [_validate_and_normalize_arrow(session.target_snapshot, {**item, "source": ArrowSource.VISION_CONFIRMED}, photo_confirmed=True) for item in arrows]
        existing = {item.id: item for item in db.scalars(select(Arrow).where(Arrow.id.in_(ids))).all()}
        end = next((item for item in session.ends if item.sequence == end_sequence), None)
        if existing:
            if len(existing) == len(ids) and end is not None and all(
                existing[arrow_id].end_id == end.id and all(getattr(existing[arrow_id], key) == value for key, value in data.items())
                for arrow_id, data in zip(ids, normalized)
            ):
                sequences = [existing[arrow_id].sequence for arrow_id in ids]
                if sequences == list(range(sequences[0], sequences[0] + len(ids))):
                    return session_to_dict(session)
            raise HTTPException(409, "照片确认标识已使用且内容不一致，请核对本组成绩")
        if session.revision != expected_revision:
            raise HTTPException(409, "记录版本已变化；照片候选已保留，请先核对当前成绩")
        if session.status in (SessionStatus.CONFIRMED, SessionStatus.DISCARDED) or (end and end.status == EndStatus.CONFIRMED):
            raise HTTPException(409, "只能向未确认的当前组追加照片箭点")
        if not 1 <= end_sequence <= session.planned_end_count:
            raise HTTPException(422, "组序号超出本次训练范围")
        if any(not any(item.sequence == seq and item.status == EndStatus.CONFIRMED for item in session.ends) for seq in range(1, end_sequence)):
            raise HTTPException(409, "请先确认前一组")
        count = len(end.arrows) if end else 0
        capacity = end.expected_arrow_count if end else session.arrows_per_end
        if count + len(ids) > capacity:
            raise HTTPException(409, "候选箭点超过本组剩余箭数，请先核对")
        # Claim the revision before creating an end or inserting any arrow.
        claimed = db.execute(update(TrainingSession).where(
            TrainingSession.id == session_id, TrainingSession.owner_id == owner_id,
            TrainingSession.revision == expected_revision,
        ).values(revision=expected_revision + 1, status=SessionStatus.IN_PROGRESS, updated_at=datetime.now()).execution_options(synchronize_session=False))
        if claimed.rowcount != 1:
            raise HTTPException(409, "记录版本已变化；照片候选已保留")
        if end is None:
            end = _get_or_create_end(db, session, end_sequence)
        for offset, (arrow_id, data) in enumerate(zip(ids, normalized), 1):
            arrow = Arrow(id=arrow_id, end_id=end.id, sequence=count + offset, **data)
            db.add(arrow)
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def delete_arrow(db: Session, session_id: str, end_sequence: int, arrow_sequence: int, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        expected_revision = session.revision if expected_revision is None else expected_revision
        _check_loaded_revision(session, expected_revision, "记录版本已变化；删除未覆盖当前成绩")
        end = _get_or_create_end(db, session, end_sequence)
        arrow = next((item for item in end.arrows if item.sequence == arrow_sequence), None)
        if arrow is None:
            raise HTTPException(404, "未找到该箭")
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化；删除未覆盖当前成绩")
        _make_end_editable(end, session)
        db.delete(arrow)
        end.arrows.remove(arrow)
        db.flush()
        for sequence, item in enumerate(sorted(end.arrows, key=lambda current: current.sequence), 1):
            item.sequence = sequence
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def undo_arrow(db: Session, session_id: str, end_sequence: int, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    session = _get_session(db, session_id, owner_id)
    end = _get_or_create_end(db, session, end_sequence)
    if not end.arrows:
        raise HTTPException(409, "本组还没有可撤销的箭")
    return delete_arrow(db, session_id, end_sequence, max(arrow.sequence for arrow in end.arrows), owner_id, expected_revision)


def redo_end(db: Session, session_id: str, end_sequence: int, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        expected_revision = session.revision if expected_revision is None else expected_revision
        _check_loaded_revision(session, expected_revision, "记录版本已变化；重录未覆盖当前成绩")
        end = _get_or_create_end(db, session, end_sequence)
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化；重录未覆盖当前成绩")
        _make_end_editable(end, session)
        for arrow in list(end.arrows):
            db.delete(arrow)
        end.arrows.clear()
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def confirm_end(db: Session, session_id: str, end_sequence: int, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        expected_revision = session.revision if expected_revision is None else expected_revision
        _check_loaded_revision(session, expected_revision, "记录版本已变化；本组确认未覆盖当前成绩")
        end = _get_or_create_end(db, session, end_sequence)
        if len(end.arrows) != end.expected_arrow_count:
            raise HTTPException(422, f"本组还差 {end.expected_arrow_count - len(end.arrows)} 箭，不能确认")
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化；本组确认未覆盖当前成绩")
        end.status = EndStatus.CONFIRMED
        end.confirmed_at = datetime.now()
        confirmed_sequences = {item.sequence for item in session.ends if item.status == EndStatus.CONFIRMED}
        session.status = SessionStatus.PENDING_CONFIRMATION if len(confirmed_sequences) == session.planned_end_count else SessionStatus.IN_PROGRESS
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def _summary_for_arrows(arrows: list[Arrow]) -> dict:
    scores = [ScoreCode(item.score_code) for item in arrows]
    summary = summarize_scores(scores)
    distribution = {code.value: scores.count(code) for code in ScoreCode}
    # coordinate_count 统计有靶面坐标或画布坐标的箭
    coord_count = sum(1 for item in arrows if (item.x_norm is not None and item.y_norm is not None) or (item.plot_x_norm is not None and item.plot_y_norm is not None))
    # dispersion_rms 只用靶面内坐标（x_norm/y_norm），保持口径不变
    points = [(item.x_norm, item.y_norm) for item in arrows if item.x_norm is not None and item.y_norm is not None]
    dispersion = None
    if points:
        center_x = sum(point[0] for point in points) / len(points)
        center_y = sum(point[1] for point in points) / len(points)
        dispersion = sqrt(sum((x - center_x) ** 2 + (y - center_y) ** 2 for x, y in points) / len(points))
    return {
        "arrow_count": summary.arrow_count, "hit_count": summary.hit_count, "total_score": summary.total_score,
        "average_score": summary.average_score, "hit_rate": summary.hit_rate, "x_count": summary.x_count,
        "ten_count": summary.ten_count, "ring_distribution": distribution, "coordinate_count": coord_count,
        "dispersion_rms": dispersion,
    }


def _session_stats(session: TrainingSession) -> dict:
    ends = sorted((e for e in session.ends if e.arrows), key=lambda item: item.sequence)
    end_stats = [{"sequence": end.sequence, **_summary_for_arrows(sorted(end.arrows, key=lambda item: item.sequence))} for end in ends]
    arrows = [arrow for end in ends for arrow in end.arrows]
    split = (len(ends) + 1) // 2
    return {
        **_summary_for_arrows(arrows), "end_stats": end_stats,
        "phase_comparison": {
            "first": _summary_for_arrows([arrow for end in ends[:split] for arrow in end.arrows]),
            "second": _summary_for_arrows([arrow for end in ends[split:] for arrow in end.arrows]),
        },
    }


def _confirmed_query():
    return select(TrainingSession).options(selectinload(TrainingSession.ends).selectinload(End.arrows)).where(TrainingSession.status == SessionStatus.CONFIRMED)


def finish_early(db: Session, session_id: str, owner_id: str, expected_revision: int) -> dict:
    """Explicitly end at the recorded arrow count, without changing plan facts."""
    try:
        session = _get_session(db, session_id, owner_id)
        # Only an exact retry of the terminal operation is idempotent.
        if session.status == SessionStatus.CONFIRMED and session.completion_mode == "EARLY" and session.revision == expected_revision + 1:
            return session_to_dict(session)
        _check_loaded_revision(session, expected_revision, "记录版本已变化，请核对已射成绩后重试")
        if session.status in (SessionStatus.CONFIRMED, SessionStatus.DISCARDED):
            raise HTTPException(409, "训练已经结束，不能再次结束")
        recorded = sorted((e for e in session.ends if e.arrows), key=lambda e: e.sequence)
        if not recorded:
            raise HTTPException(422, "尚未记录箭，保留草稿即可，不生成空成绩")
        if [e.sequence for e in recorded] != list(range(1, recorded[-1].sequence + 1)):
            raise HTTPException(422, "存在未录入的中间组，请先核对记录")
        if any(e.status != EndStatus.CONFIRMED for e in recorded[:-1]):
            raise HTTPException(422, "请先核对之前各组的成绩")
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化，结束操作未覆盖成绩")
        for end in session.ends:
            end.status = EndStatus.CONFIRMED
            if end.arrows and end.confirmed_at is None:
                end.confirmed_at = datetime.now()
        session.status = SessionStatus.CONFIRMED
        session.completion_mode = "EARLY"
        session.confirmed_at = datetime.now()
        db.commit()
        db.expire_all()
        return get_session(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def confirm_session(db: Session, session_id: str, owner_id: str | None = None, expected_revision: int | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        expected_revision = session.revision if expected_revision is None else expected_revision
        _check_loaded_revision(session, expected_revision, "记录版本已变化；整场确认未覆盖当前成绩")
        if session.status != SessionStatus.PENDING_CONFIRMATION or len(session.ends) != session.planned_end_count or any(end.status != EndStatus.CONFIRMED or len(end.arrows) != end.expected_arrow_count for end in session.ends):
            raise HTTPException(422, "请先确认本次训练的每一组，才能存入历史")
        _claim_revision(db, session, expected_revision, owner_id, "记录版本已变化；整场确认未覆盖当前成绩")
        session.status = SessionStatus.CONFIRMED
        session.confirmed_at = datetime.now()
        db.commit()
        db.expire_all()
        confirmed = _get_session(db, session_id, owner_id)
        return {"session": session_to_dict(confirmed), "statistics": _session_stats(confirmed)}
    except Exception:
        db.rollback()
        raise


def list_history(db: Session, target_id: str | None = None, bow_type: str | None = None, distance_m: float | None = None, owner_id: str | None = None) -> list[dict]:
    query = _confirmed_query()
    if target_id:
        query = query.where(TrainingSession.target_definition_id == target_id)
    if bow_type:
        query = query.where(TrainingSession.bow_type == bow_type)
    if distance_m is not None:
        query = query.where(TrainingSession.distance_m == distance_m)
    if owner_id is not None:
        query = query.where(TrainingSession.owner_id == owner_id)
    sessions = db.scalars(query.order_by(TrainingSession.confirmed_at.desc())).all()
    return [{"id": session.id, "confirmed_at": session.confirmed_at.isoformat() if session.confirmed_at else None, "target_name": session.target_snapshot.get("name"), "bow_type": session.bow_type, "distance_m": session.distance_m, "statistics": _session_stats(session)} for session in sessions]


def history_detail(db: Session, session_id: str, owner_id: str | None = None) -> dict:
    session = _get_session(db, session_id, owner_id)
    if session.status != SessionStatus.CONFIRMED:
        raise HTTPException(404, "未找到已确认训练")
    return {"session": session_to_dict(session), "statistics": _session_stats(session)}


def history_statistics(db: Session, owner_id: str | None = None) -> dict:
    sessions = db.scalars(_confirmed_query().order_by(TrainingSession.confirmed_at.asc())).all()
    if owner_id is not None:
        sessions = [session for session in sessions if session.owner_id == owner_id]
    arrows = [arrow for session in sessions for end in session.ends for arrow in end.arrows]
    return {"overall": _summary_for_arrows(arrows), "trend": [{"id": session.id, "confirmed_at": session.confirmed_at.isoformat() if session.confirmed_at else None, "total_score": _session_stats(session)["total_score"], "average_score": _session_stats(session)["average_score"], "hit_rate": _session_stats(session)["hit_rate"], "arrow_count": _session_stats(session)["arrow_count"]} for session in sessions]}


def _next_month(value: date) -> date:
    return date(value.year + (value.month == 12), 1 if value.month == 12 else value.month + 1, 1)


def _validate_history_period(range_kind: str, start_local_date: date, end_local_date_exclusive: date, time_zone: str) -> ZoneInfo:
    try:
        zone = ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise HTTPException(422, "time_zone 必须是有效的 IANA 时区") from error
    if start_local_date >= end_local_date_exclusive:
        raise HTTPException(422, "报告结束日期必须晚于开始日期")
    if range_kind == "WEEK":
        if start_local_date.weekday() != 0 or (end_local_date_exclusive - start_local_date).days != 7:
            raise HTTPException(422, "WEEK 必须从周一开始并使用 7 天左闭右开区间")
    elif range_kind == "MONTH":
        if start_local_date.day != 1 or end_local_date_exclusive != _next_month(start_local_date):
            raise HTTPException(422, "MONTH 必须使用自然月左闭右开区间")
    else:
        raise HTTPException(422, "range_kind 仅支持 WEEK 或 MONTH")
    return zone


def _utc_iso(value: datetime) -> str:
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return aware.isoformat().replace("+00:00", "Z")


def _date_evidence(session: TrainingSession, zone: ZoneInfo, time_zone: str) -> dict:
    confirmed_raw = session.confirmed_at.isoformat() if session.confirmed_at else None
    if session.started_at is not None:
        started_at_utc = _utc_iso(session.started_at)
        instant = session.started_at.replace(tzinfo=timezone.utc) if session.started_at.tzinfo is None else session.started_at.astimezone(timezone.utc)
        return {
            "basis": "STARTED_AT", "local_date": instant.astimezone(zone).date().isoformat(),
            "started_at_utc": started_at_utc, "confirmed_at_raw": confirmed_raw,
            "time_zone": time_zone, "trusted_for_period_comparison": True,
        }
    if session.confirmed_at is not None:
        # Historical confirmation timestamps were stored without a timezone.
        # Preserve their literal calendar date; never reinterpret them as UTC.
        return {
            "basis": "CONFIRMED_AT_LEGACY", "local_date": session.confirmed_at.date().isoformat(),
            "started_at_utc": None, "confirmed_at_raw": confirmed_raw,
            "time_zone": None, "trusted_for_period_comparison": False,
        }
    return {
        "basis": "UNKNOWN", "local_date": None, "started_at_utc": None,
        "confirmed_at_raw": None, "time_zone": None, "trusted_for_period_comparison": False,
    }


def _comparison_specification(session: TrainingSession, target: dict) -> dict:
    blocks = session.plan_snapshot.get("blocks") if isinstance(session.plan_snapshot, dict) else None
    scored_blocks = []
    if isinstance(blocks, list):
        for block in blocks:
            if isinstance(block, dict) and block.get("is_scored") is True:
                scored_blocks.append({
                    "position": block.get("position"), "block_type": block.get("block_type"),
                    "end_count": block.get("end_count"), "arrows_per_end": block.get("arrows_per_end"),
                })
    return {
        "bow_type": session.bow_type, "distance_m": session.distance_m,
        "target": target, "planned_end_count": session.planned_end_count,
        "arrows_per_end": session.arrows_per_end, "completion_mode": session.completion_mode,
        "scored_blocks": scored_blocks,
    }


def _comparison_key(specification: dict) -> str:
    canonical = json.dumps(specification, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def _report_statistics(arrows: list[Arrow]) -> dict:
    statistics = _summary_for_arrows(arrows)
    return {**statistics, "miss_count": statistics["ring_distribution"]["M"]}


def history_snapshot(
    db: Session, range_kind: str, start_local_date: date,
    end_local_date_exclusive: date, time_zone: str, owner_id: str,
) -> dict:
    """Return one owner-scoped, period-only snapshot from a single SQL read.

    The SQL statement supplies a database-consistent row set for sessions,
    ends, and arrows. No broader all-history coverage claim is made.
    """
    zone = _validate_history_period(range_kind, start_local_date, end_local_date_exclusive, time_zone)
    query = (
        select(TrainingSession)
        .options(joinedload(TrainingSession.ends).joinedload(End.arrows))
        .where(TrainingSession.status == SessionStatus.CONFIRMED, TrainingSession.owner_id == owner_id)
    )
    sessions = db.execute(query).unique().scalars().all()
    included = []
    unknown_date_count = 0
    unlocated_legacy_date_count = 0
    legacy_fallback_shown_count = 0
    for session in sessions:
        date_evidence = _date_evidence(session, zone, time_zone)
        local_date = date_evidence["local_date"]
        if local_date is None:
            unknown_date_count += 1
            continue
        if date_evidence["basis"] == "CONFIRMED_AT_LEGACY":
            # Its literal confirmation date can be displayed, but the actual
            # training date may belong to any requested period. Count it before
            # range filtering so no period is incorrectly declared complete.
            unlocated_legacy_date_count += 1
        parsed_local_date = date.fromisoformat(local_date)
        if not start_local_date <= parsed_local_date < end_local_date_exclusive:
            continue
        if date_evidence["basis"] == "CONFIRMED_AT_LEGACY":
            legacy_fallback_shown_count += 1
        try:
            target = resolve_target_contract(session.target_snapshot)
        except TargetContractError as error:
            raise HTTPException(422, str(error)) from error
        specification = _comparison_specification(session, target)
        session_statistics = _session_stats(session)
        included.append({
            "id": session.id, "revision": session.revision, "status": session.status,
            "date_evidence": date_evidence,
            "comparison": {
                "eligible": date_evidence["trusted_for_period_comparison"],
                "reason": None if date_evidence["trusted_for_period_comparison"] else "UNTRUSTED_TRAINING_DATE",
                "key": _comparison_key(specification), "specification": specification,
            },
            "statistics": {**session_statistics, "miss_count": session_statistics["ring_distribution"]["M"]},
        })
    included.sort(key=lambda item: (item["date_evidence"]["local_date"], item["date_evidence"]["started_at_utc"] or item["date_evidence"]["confirmed_at_raw"] or "", item["id"]))

    grouped: dict[str, dict] = {}
    sessions_by_id = {session.id: session for session in sessions}
    for item in included:
        if not item["comparison"]["eligible"]:
            continue
        key = item["comparison"]["key"]
        group = grouped.setdefault(key, {"comparison_key": key, "specification": item["comparison"]["specification"], "items": []})
        group["items"].append(item)
    groups = []
    for key in sorted(grouped):
        group = grouped[key]
        arrows = [
            arrow
            for item in group["items"]
            for end in sorted(sessions_by_id[item["id"]].ends, key=lambda current: current.sequence)
            for arrow in sorted(end.arrows, key=lambda current: current.sequence)
        ]
        groups.append({
            "comparison_key": key, "specification": group["specification"],
            "session_count": len(group["items"]), "statistics": _report_statistics(arrows),
            "trend": [{
                "session_id": item["id"], "local_date": item["date_evidence"]["local_date"],
                "arrow_count": item["statistics"]["arrow_count"],
                "total_score": item["statistics"]["total_score"],
                "average_score": item["statistics"]["average_score"],
            } for item in group["items"]],
        })
    warnings = []
    if unlocated_legacy_date_count:
        warnings.append("UNLOCATED_LEGACY_DATE_PRESENT")
    if legacy_fallback_shown_count:
        warnings.append("LEGACY_CONFIRMATION_DATE_SHOWN")
    if unknown_date_count:
        warnings.append("UNKNOWN_DATE_EXCLUDED")
    return {
        "version": 1, "owner_scope": owner_id,
        "range": {
            "kind": range_kind, "start_local_date": start_local_date.isoformat(),
            "end_local_date_exclusive": end_local_date_exclusive.isoformat(), "time_zone": time_zone,
        },
        "coverage": {
            "kind": "REQUESTED_PERIOD_ONLY", "query_consistency": "SINGLE_SQL_STATEMENT",
            "period_membership": "COMPLETE" if not unlocated_legacy_date_count and not unknown_date_count else "INCOMPLETE_UNTRUSTED_DATES",
            "all_history_claimed": False,
            "unlocated_legacy_date_session_count": unlocated_legacy_date_count,
            "legacy_fallback_shown_count": legacy_fallback_shown_count,
            "unknown_date_session_count": unknown_date_count,
        },
        "sessions": included, "groups": groups, "warnings": warnings,
    }


def update_history(db: Session, session_id: str, payload: dict, expected_revision: int | None = None, owner_id: str | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        if session.status != SessionStatus.CONFIRMED:
            raise HTTPException(404, "未找到已确认训练")
        if expected_revision is None:
            expected_revision = session.revision
        _claim_revision(db, session, expected_revision, owner_id, "历史记录版本已变化，请刷新后重试")
        session.note = payload.get("note")
        session.equipment_note = payload.get("equipment_note")
        db.commit()
        return history_detail(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def update_history_arrow(db: Session, session_id: str, end_sequence: int, arrow_sequence: int, payload: dict, expected_revision: int | None = None, owner_id: str | None = None) -> dict:
    try:
        session = _get_session(db, session_id, owner_id)
        if session.status != SessionStatus.CONFIRMED:
            raise HTTPException(404, "未找到已确认训练")
        if expected_revision is None:
            expected_revision = session.revision
        end = next((item for item in session.ends if item.sequence == end_sequence), None)
        arrow = next((item for item in end.arrows if item.sequence == arrow_sequence), None) if end else None
        if arrow is None:
            raise HTTPException(404, "未找到该箭")
        normalized = _validate_and_normalize_arrow(session.target_snapshot, payload)
        _claim_revision(db, session, expected_revision, owner_id, "历史记录版本已变化，请刷新后重试")
        for key, value in normalized.items():
            setattr(arrow, key, value)
        db.commit()
        return history_detail(db, session_id, owner_id)
    except Exception:
        db.rollback()
        raise


def delete_history(db: Session, session_id: str, expected_revision: int | None = None, owner_id: str | None = None) -> None:
    try:
        session = _get_session(db, session_id, owner_id)
        if session.status != SessionStatus.CONFIRMED:
            raise HTTPException(404, "未找到已确认训练")
        if expected_revision is None:
            expected_revision = session.revision
        _claim_revision(db, session, expected_revision, owner_id, "历史记录版本已变化，请刷新后重试")
        for end in list(session.ends):
            for arrow in list(end.arrows):
                db.delete(arrow)
            db.delete(end)
        db.delete(session)
        db.commit()
    except Exception:
        db.rollback()
        raise


def export_history(db: Session, owner_id: str | None = None) -> list[dict]:
    return [history_detail(db, item["id"], owner_id) for item in list_history(db, owner_id=owner_id)]

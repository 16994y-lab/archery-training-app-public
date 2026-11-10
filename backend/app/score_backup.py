"""Explicit score-only backup, with owner isolation and revision-safe writes.

This router is intentionally separate from the full mobile-document archive.
Importing it never opens registration, sends an SMS, or creates a database table.
"""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import current_user_id
from app.db import SessionLocal
from app.mobile_documents import _date, _integer, _keys, _list, _number, _obj, _require, _safe_tree, _target, _time
from app.score_backup_models import ScoreBackup
from app.scoring import score_from_target_coordinate


router = APIRouter(tags=["score-backup"])
MAX_BYTES = 2 * 1024 * 1024
TARGET_REQUIRED = (
    "id", "name", "target_type", "scoring_mode", "face_count", "sizeRatio",
    "rules_version", "allowed_score_codes", "coordinate_space", "boundary_policy",
    "ring_rules", "layout", "plot",
)
TARGET_OPTIONAL = ("scoring_profile", "nominal_face_diameter_cm", "scoring_diameter_cm", "custom")


def score_backup_get_db():
    with SessionLocal() as db:
        yield db


def _validate_target(value):
    _keys(_obj(value, "靶型快照"), TARGET_REQUIRED, TARGET_OPTIONAL)
    _target(value)  # Reuse the shipped mobile target and scoring contract.
    if "custom" in value:
        _require(type(value["custom"]) is bool, "自定义靶型标记无效")
    for key in ("nominal_face_diameter_cm", "scoring_diameter_cm"):
        if key in value:
            _require(value[key] is None or _number(value[key], 0, 1000), "靶面直径无效")
    if "scoring_profile" in value:
        _require(isinstance(value["scoring_profile"], str), "计分规则名称无效")
    for ring in value["ring_rules"]:
        _keys(ring, ("score_code", "label", "color", "outer_radius_norm"))
    layout = value["layout"]
    _keys(layout, ("kind", "face_count", "faces"))
    for face in layout["faces"]:
        _keys(face, ("index", "anchor_x", "anchor_y"))
    plot = _obj(value["plot"], "靶面画布")
    _keys(plot, ("coordinate_space", "center_x", "center_y", "outer_scoring_radius_norm", "calibration_boundary_score_code", "control_order"))
    _require(_number(plot["center_x"], 0, 1) and _number(plot["center_y"], 0, 1), "靶面中心无效")
    _require(isinstance(plot["control_order"], list) and plot["control_order"] == ["TOP", "RIGHT", "BOTTOM", "LEFT"], "画布控制点无效")


def validate_score_backup(document):
    _keys(_obj(document, "成绩备份"), ("schema", "sessions"))
    _require(document["schema"] == "score-backup/v1", "成绩备份版本无效")
    _safe_tree(document)
    encoded = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    _require(len(encoded) <= MAX_BYTES, "成绩备份超过 2 MiB；未保存")
    sessions = _list(document["sessions"], "场次", 5000)
    _require(bool(sessions), "请选择至少一场已完成训练；不会清空云备份")
    arrow_ids = set()
    for item in sessions:
        _keys(item, ("id", "date", "started", "ended", "status", "revision", "target", "size", "distance", "ends"))
        _require(item["status"] == "completed", "仅备份已完成场次")
        _require(_integer(item["revision"], 1, 2**53 - 1), "场次版本无效")
        _date(item["date"])
        _time(item["started"])
        _time(item["ended"])
        _validate_target(item["target"])
        _require(_number(item["distance"], 1e-8, 1000), "距离无效")
        _require(item["size"] is None or _number(item["size"], 1e-8, 1000), "靶面尺寸无效")
        ends = _list(item["ends"], "分组", 500)
        _require(bool(ends), "已完成场次须有实际成绩")
        count = 0
        for end in ends:
            _keys(end, ("id", "half", "capacity", "arrows"))
            _require(end["half"] in ("", "上半场", "下半场") and _integer(end["capacity"], 1, 300), "分组配置无效")
            arrows = _list(end["arrows"], "单箭", end["capacity"])
            _require(bool(arrows), "成绩备份不收空组")
            for arrow in arrows:
                _keys(arrow, ("id", "code", "x", "y", "face", "source", "enteredAt"), ("coordinateEvidence",))
                _require(arrow["id"] not in arrow_ids, "单箭标识跨场次重复")
                arrow_ids.add(arrow["id"])
                count += 1
                _require(arrow["code"] in item["target"]["allowed_score_codes"] and _integer(arrow["face"], 1, item["target"]["face_count"]), "单箭分值或靶位无效")
                _require(arrow["source"] in ("number", "target", "photo"), "录入来源无效")
                x, y = arrow["x"], arrow["y"]
                _require((x is None and y is None) or (_number(x, -1.200000001, 1.200000001) and _number(y, -1.200000001, 1.200000001)), "落点坐标无效")
                _require(arrow["source"] != "number" or x is None, "数字录入不能猜测坐标")
                if "coordinateEvidence" in arrow:
                    _require(arrow["coordinateEvidence"] == "manual-target-confirmed" and arrow["source"] == "photo" and x is not None, "照片落点人工确认证据无效")
                if x is not None:
                    actual = score_from_target_coordinate(item["target"], .5 + x / 2, .5 - y / 2)
                    _require(arrow["code"] == actual, "落点与分值不一致")
                _time(arrow["enteredAt"])
        _require(count <= 30000, "单场箭数超过容量")
    return document


def _result(row):
    return {"revision": row.revision if row else 0, "document": row.document if row else None, "updatedAt": row.updated_at.isoformat() if row else None}


@router.get("/api/score-backup")
def get_score_backup(response: Response, owner: str = Depends(current_user_id), db: Session = Depends(score_backup_get_db)):
    row = db.get(ScoreBackup, owner)
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{row.revision if row else 0}"'
    return _result(row)


@router.put("/api/score-backup")
async def put_score_backup(request: Request, response: Response, if_match: str | None = Header(default=None), owner: str = Depends(current_user_id), db: Session = Depends(score_backup_get_db)):
    if if_match is None:
        raise HTTPException(428, "须提供 If-Match，防止覆盖其他设备的更新")
    raw_revision = if_match.strip().strip('"')
    if not re.fullmatch(r"0|[1-9][0-9]{0,14}", raw_revision):
        raise HTTPException(400, "If-Match 版本无效")
    expected = int(raw_revision)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BYTES + 1024:
            raise HTTPException(413, "成绩备份超过 2 MiB；未保存")
    try:
        content = json.loads(body)
        _keys(_obj(content, "请求"), ("document",))
        document = validate_score_backup(content["document"])
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
        raise HTTPException(422, str(error)[:300]) from error

    current = db.get(ScoreBackup, owner)
    if (current.revision if current else 0) != expected:
        raise HTTPException(409, "云版本已变化，请重新读取；本机成绩保持不变")
    if current:
        previous_ids = {item["id"] for item in current.document["sessions"]}
        next_ids = {item["id"] for item in document["sessions"]}
        if not previous_ids <= next_ids:
            raise HTTPException(422, "本接口不删除已备份场次；请先保留云端既有成绩")

    stamp = datetime.now(timezone.utc)
    if expected == 0:
        db.add(ScoreBackup(owner_id=owner, revision=1, document=document, updated_at=stamp))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "其他设备已建立云备份，请重新读取")
    else:
        changed = db.execute(update(ScoreBackup).where(ScoreBackup.owner_id == owner, ScoreBackup.revision == expected).values(document=document, revision=expected + 1, updated_at=stamp))
        if changed.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "云版本已变化，请重新读取；本机成绩保持不变")
        db.commit()
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{expected + 1}"'
    return {"revision": expected + 1, "document": document, "updatedAt": stamp.isoformat()}

"""Full mobile document transport with owner isolation and optimistic concurrency.

The server stores rules/equipment snapshots without projecting them into the older
12-arrow schema. Media and credentials have no place in this contract. Deployment
must run the additive migration separately; importing this router creates no table.
"""
import json
import math
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.manual_backup_gate import manual_backup_actor
from app.mobile_document_models import MobileDocument
from app.mobile_document_privacy import document_transaction
from app.manual_backup_transport import TRANSPORT_JSON_MAX_BYTES, CAPACITY_MESSAGE, bounded_backup_response
from app.target_contracts import resolve_target_contract

router = APIRouter(tags=["mobile-document"])
MAX_BYTES = 24 * 1024 * 1024
COLLECTIONS = ("sessions", "plans", "targets", "equipment", "schedules", "programs", "goals", "accessories")
FORBIDDEN = {"password", "passwd", "secret", "accesstoken", "refreshtoken", "authorization", "apikey", "publickey", "servicerole", "privatekey", "connection", "email", "phone", "phonenumber", "photo", "photos", "image", "images", "video", "videos", "base64", "blob", "dataurl", "mediabytes", "__proto__", "constructor", "prototype"}


def mobile_get_db():
    with SessionLocal() as db:
        yield db


def _require(ok, message):
    if not ok:
        raise ValueError(message)


def _obj(value, label):
    _require(isinstance(value, dict), f"{label}须为对象")
    return value


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def _text(value, label, required=False):
    _require(isinstance(value, str) and len(value) <= 10000 and (not required or bool(value.strip())), f"{label}文本无效")


def _date(value):
    _require(isinstance(value, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)), "日期格式无效")
    datetime.strptime(value, "%Y-%m-%d")


def _time(value):
    _require(isinstance(value, str), "时间格式无效")
    datetime.fromisoformat(value.replace("Z", "+00:00"))


def _list(value, label, limit=5000):
    _require(isinstance(value, list) and len(value) <= limit, f"{label}超过容量或格式无效；未保存")
    ids = set()
    for item in value:
        _obj(item, label)
        identity = item.get("id")
        _require(isinstance(identity, str) and 0 < len(identity) <= 160 and identity not in ids, f"{label}标识缺失或重复")
        ids.add(identity)
    return value


def _safe_tree(value, depth=0):
    _require(depth <= 24, "资料层级过深")
    if isinstance(value, dict):
        _require(len(value) <= 100, "字段过多")
        for key, child in value.items():
            normalized = re.sub(r"[-_]", "", key.lower())
            _require(key not in FORBIDDEN and normalized not in FORBIDDEN, "同步资料不能包含媒体或账号凭据")
            _safe_tree(child, depth + 1)
    elif isinstance(value, list):
        _require(len(value) <= 30000, "列表超过容量")
        for child in value:
            _safe_tree(child, depth + 1)
    elif isinstance(value, str):
        _require(len(value) <= 10000 and not value.lower().startswith(("data:", "file:", "content:")), "不接受媒体内容或过长文本")
    else:
        _require(value is None or type(value) is bool or _number(value, -1e15, 1e15), "资料包含非法值")


def _equipment(value):
    _obj(value, "器材")
    for key in ("id", "name", "bow", "riser", "limbs", "arrows", "sight", "stabilizer", "string", "tab", "other"):
        _text(value.get(key), "器材", key == "id")
    _require(type(value.get("favorite")) is bool, "常用器材标记无效")


def _keys(value, required, optional=()):
    _require(set(required) <= set(value) and set(value) <= set(required) | set(optional), "资料含缺失或尚不支持的字段；未保存")


def _target(target):
    _obj(target, "靶型")
    resolve_target_contract(target)
    _text(target.get("id"), "靶型标识", True)
    _text(target.get("name"), "靶型名称", True)
    _require(_integer(target.get("face_count"), 1, 3), "靶位数无效")
    _require(_number(target.get("sizeRatio"), 1e-8, 1), "靶面比例无效")
    _require(target.get("scoring_mode") == "RING_GEOMETRY", "当前手机版仅同步同心圆靶型")
    _require(target.get("coordinate_space") == "selected-face-scoring-square/v1" and target.get("boundary_policy") == "HIGHER_SCORE_INCLUSIVE", "靶型坐标规则无效")
    rings = target.get("ring_rules")
    _require(isinstance(rings, list) and 1 <= len(rings) <= 11, "环带无效")
    previous, codes = 0, []
    for ring in rings:
        _obj(ring, "环带")
        radius, code = ring.get("outer_radius_norm"), ring.get("score_code")
        _require(_number(radius, 1e-9, .5) and radius > previous, "环带半径无效")
        _require(code in ["X"] + [str(n) for n in range(1, 11)] and code not in codes, "环带分值无效")
        _require(isinstance(ring.get("color"), str) and bool(re.fullmatch(r"#[0-9a-fA-F]{6}", ring["color"])), "环带颜色无效")
        previous = radius
        codes.append(code)
    _require(abs(previous - .5) < 1e-12 and target.get("allowed_score_codes") == codes + ["M"], "环带与可用成绩不一致")
    layout = _obj(target.get("layout"), "布局")
    faces = layout.get("faces")
    _require(isinstance(faces, list) and len(faces) == target["face_count"] and layout.get("face_count") == len(faces), "靶位布局无效")
    for index, face in enumerate(faces, 1):
        _require(isinstance(face, dict) and face.get("index") == index and _number(face.get("anchor_x"), 0, 1) and _number(face.get("anchor_y"), 0, 1), "靶位编号或坐标无效")


def _conditions(value):
    _obj(value, "场次条件")
    _target(value.get("target"))
    _require(_number(value.get("distance"), 1e-8, 1000), "距离无效")
    _require(value.get("size") is None or _number(value["size"], 1e-8, 1000), "靶面尺寸无效")
    _text(value.get("bow"), "弓种")
    if value.get("equipment") is not None:
        _equipment(value["equipment"])


def _plan(value):
    _obj(value, "计划")
    _text(value.get("name"), "计划名称", True)
    _text(value.get("note"), "计划备注")
    _conditions(value.get("conditions"))
    _require(type(value.get("archived")) is bool, "计划归档标记无效")
    _time(value.get("updated"))
    blocks = _list(value.get("blocks"), "计划编排", 200)
    ends = arrows = 0
    for block in blocks:
        _require(block.get("kind") in ("score", "rest") and block.get("half") in ("", "上半场", "下半场"), "计划区块或半场无效")
        _text(block.get("label"), "区块名称")
        if block["kind"] == "score":
            _require(_integer(block.get("ends"), 1, 500) and _integer(block.get("arrows"), 1, 300), "组数或箭数无效")
            ends += block["ends"]
            arrows += block["ends"] * block["arrows"]
        else:
            _require(_number(block.get("minutes"), 0, 1440), "休息时长无效")
    _require(1 <= ends <= 500 and arrows <= 30000, "计划容量无效")


def _session(value, arrow_ids):
    _keys(value, ("id", "name", "date", "started", "ended", "status", "conditions", "plan", "scheduleId", "scheduleSnapshot", "ends", "currentEnd", "blockIndex", "blockEnd", "rest", "skippedRests", "note", "energy", "fatigue", "videoNotes", "revision"), ("halfBoundary",))
    _text(value.get("name"), "场次名称")
    _text(value.get("note"), "练后心得")
    _date(value.get("date"))
    _time(value.get("started"))
    _require(value.get("status") in ("draft", "completed", "discarded"), "云端场次须为草稿、完成或放弃状态")
    _require(_integer(value.get("revision"), 1, 2**53 - 1), "场次版本无效")
    _require(value.get("halfBoundary") is None or _integer(value["halfBoundary"], 1, 500), "显式半场边界无效")
    _conditions(value.get("conditions"))
    if value.get("plan") is not None:
        _plan(value["plan"])
    ends = _list(value.get("ends"), "分组", 500)
    _require(_integer(value.get("currentEnd"), 0, max(0, len(ends) - 1)), "当前组引用无效")
    _require(_integer(value.get("blockIndex"), 0, 200) and _integer(value.get("blockEnd"), 0, 500), "执行位置无效")
    for key in ("energy", "fatigue"):
        _require(value.get(key) is None or _number(value[key], 0, 10), "体能或疲劳范围无效")
    count = 0
    target = value["conditions"]["target"]
    for end in ends:
        _keys(end, ("id", "blockId", "half", "capacity", "arrows", "confirmed"), ("note",))
        if "note" in end:
            _text(end["note"], "本组备注")
        _require(_integer(end.get("capacity"), 1, 300) and type(end.get("confirmed")) is bool and end.get("half") in ("", "上半场", "下半场"), "本组容量或标记无效")
        for arrow in _list(end.get("arrows"), "单箭", end["capacity"]):
            _keys(arrow, ("id", "code", "x", "y", "face", "source", "enteredAt"), ("note", "coordinateEvidence"))
            if "note" in arrow:
                _text(arrow["note"], "单箭备注")
            _require(arrow["id"] not in arrow_ids, "单箭标识跨组或场次重复")
            arrow_ids.add(arrow["id"])
            count += 1
            _require(arrow.get("code") in target["allowed_score_codes"] and _integer(arrow.get("face"), 1, target["face_count"]), "单箭分值或靶位无效")
            _require(arrow.get("source") in ("number", "target", "photo"), "录入来源无效")
            x, y = arrow.get("x"), arrow.get("y")
            _require((x is None and y is None) or (_number(x, -1.200000001, 1.200000001) and _number(y, -1.200000001, 1.200000001)), "落点坐标无效")
            _require(arrow["source"] != "number" or (x is None and y is None), "数字录入不能猜测坐标")
            if "coordinateEvidence" in arrow:
                _require(arrow["coordinateEvidence"] == "manual-target-confirmed" and arrow["source"] == "photo" and x is not None, "照片落点人工确认证据无效")
            if x is not None:
                radius = math.hypot(x, y) / 2
                score = next((ring["score_code"] for ring in target["ring_rules"] if radius <= ring["outer_radius_norm"] + 1e-12), "M")
                _require(arrow["code"] == score, "落点与分值不一致")
            _time(arrow.get("enteredAt"))
    _require(count <= 30000, "单场箭数超过容量")
    if value.get("ended") is not None:
        _time(value["ended"])
    _require(value["status"] != "completed" or (value.get("ended") is not None and count > 0), "已完成场次须有实际成绩和结束时间")
    for rest in _list(value.get("rest"), "休息", 5000):
        _time(rest.get("started"))
        if rest.get("ended") is not None:
            _time(rest["ended"])
        _require(type(rest.get("timer")) is bool and (rest.get("minutes") is None or _number(rest["minutes"], 0, 1440)), "休息记录无效")
    for note in _list(value.get("videoNotes"), "人工视频备注", 5000):
        _text(note.get("note"), "视频备注")
        _require(_number(note.get("time"), 0, 1e12), "视频时间点无效")
    _require(isinstance(value.get("skippedRests"), list) and all(isinstance(x, str) for x in value["skippedRests"]), "休息跳过记录无效")


def validate_document(document):
    _obj(document, "资料")
    _require(set(document) == {"schema", "profile", *COLLECTIONS} and document.get("schema") == 1, "云资料版本或顶层字段无效")
    _safe_tree(document)
    encoded = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    _require(len(encoded) <= MAX_BYTES, "资料超过 24 MiB，未保存；请先导出整理")
    for name in COLLECTIONS:
        _list(document[name], name)
    profile = _obj(document["profile"], "个人资料")
    required_profile = {"name", "bow", "hand", "experience", "competition"}
    _require(required_profile <= set(profile) <= required_profile | {"avatar"}, "个人资料字段无效")
    for key in required_profile:
        _text(profile[key], "个人资料")
    if "avatar" in profile:
        _require(profile["avatar"] in ("initial", "bow", "target", "star"), "头像样式无效")
    for item in document["targets"]:
        _target(item)
    for item in document["equipment"]:
        _equipment(item)
    for item in document["accessories"]:
        _keys(item, ("id", "category", "name", "note", "favorite"))
        for key in ("category", "name", "note"):
            _text(item[key], "配件资料")
        _require(type(item["favorite"]) is bool, "配件常用标记无效")
    for item in document["plans"]:
        _plan(item)
    arrow_ids = set()
    for item in document["sessions"]:
        _session(item, arrow_ids)
    for item in document["goals"]:
        _text(item.get("name"), "目标名称")
        _require(item.get("type") in ("arrows", "sessions", "average") and _number(item.get("value"), 1e-8, 1e12), "目标无效")
        _require(item["type"] != "average" or item["value"] <= 10, "平均环目标不能超过 10")
        distance = item.get("distance")
        _require("distance" in item and (distance is None or (_number(distance, 0, 1e15) and distance > 0)), "目标距离须为正数或未知")
        _date(item.get("start")); _date(item.get("end"))
        _require(item["end"] >= item["start"], "目标日期范围无效")
    for item in document["programs"]:
        _text(item.get("name"), "长期计划")
        _text(item.get("note"), "长期计划备注")
        _date(item.get("start")); _date(item.get("end"))
        weekdays = item.get("weekdays")
        _require(item["end"] >= item["start"] and _integer(item.get("perWeek"), 1, 7) and _integer(item.get("arrowsPerWeek"), 1, 210000), "长期计划安排无效")
        _require(isinstance(weekdays, list) and len(weekdays) == item["perWeek"] and all(_integer(n, 0, 6) for n in weekdays) and len(set(weekdays)) == len(weekdays), "训练星期无效")
    for item in document["schedules"]:
        _date(item.get("date")); _text(item.get("name"), "日历名称")
        _require(_integer(item.get("arrows"), 1, 30000), "日历箭数无效")
    return document


def _result(row):
    return {"revision": row.revision if row else 0, "document": row.document if row else None, "updatedAt": row.updated_at.isoformat() if row else None}


@router.get("/api/mobile-document")
def get_document(response: Response, owner: str = Depends(manual_backup_actor), db: Session = Depends(mobile_get_db)):
    with document_transaction(db, owner):
        row = db.get(MobileDocument, str(owner))
        result = bounded_backup_response(_result(row))
    return result


@router.put("/api/mobile-document")
async def put_document(request: Request, response: Response, if_match: str | None = Header(default=None), owner: str = Depends(manual_backup_actor), db: Session = Depends(mobile_get_db)):
    if if_match is None:
        raise HTTPException(428, "须提供 If-Match，防止覆盖其他设备的更新")
    raw_revision = if_match.strip().strip('"')
    if not re.fullmatch(r"0|[1-9][0-9]{0,14}", raw_revision):
        raise HTTPException(400, "If-Match 版本无效")
    expected = int(raw_revision)
    if expected >= 2**31 - 1:
        raise HTTPException(409, "云记录版本超过当前容量；请保留本机资料并导出备份")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > TRANSPORT_JSON_MAX_BYTES:
            raise HTTPException(413, CAPACITY_MESSAGE, headers={"Cache-Control": "no-store"})
    try:
        content = json.loads(body)
        _require(isinstance(content, dict) and set(content) == {"document"}, "请求须只包含 document")
        document = validate_document(content["document"])
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        # Parser/date/driver messages can embed submitted text. Never return them.
        raise HTTPException(422, "云记录格式或内容不兼容；本机与云端原资料保持") from None
    stamp = datetime.now(timezone.utc)
    # Construct exactly the bytes returned by ASGI before INSERT/UPDATE/commit.
    result = bounded_backup_response({"revision": expected + 1, "document": document, "updatedAt": stamp.isoformat(timespec="microseconds")})
    with document_transaction(db, owner):
        if expected == 0:
            # A concurrent first save is a normal conflict, not a PostgreSQL
            # unique-violation whose DETAIL could contain the account key.
            insert = postgres_insert if db.get_bind().dialect.name == 'postgresql' else sqlite_insert
            statement = insert(MobileDocument).values(owner_id=str(owner), revision=1,
                document=document, updated_at=stamp).on_conflict_do_nothing(index_elements=['owner_id'])
        else:
            statement = update(MobileDocument).where(MobileDocument.owner_id == str(owner),
                MobileDocument.revision == expected).values(document=document, revision=expected + 1, updated_at=stamp)
        # psycopg/SQLAlchemy INSERT rowcount can be -1 before a RETURNING row is
        # consumed. The returned revision proves exactly which CAS row changed.
        changed = db.execute(statement.returning(MobileDocument.revision)).scalar_one_or_none()
        if changed != expected + 1:
            raise HTTPException(409, "云版本已变化，请读取并三方合并；本机资料保持不变")
    return result

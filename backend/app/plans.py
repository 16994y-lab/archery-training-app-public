"""Training-plan application services and the built-in starter templates."""

from datetime import datetime, timezone

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import PlanBlock, PlanStatus, SessionStatus, TargetDefinition, TrainingPlan, TrainingSession
from app.target_contracts import snapshot_for_target, target_definition_rows

WA_10_RING_ID = "builtin-wa-10-ring"
THREE_SPOT_ID = "builtin-wa-vertical-3-spot"
SCORE_ONLY_ID = "builtin-custom-score-only"

BUILT_IN_TARGETS = target_definition_rows()

TEMPLATES = (
    {"key": "basic-form", "name": "基础动作", "description": "以稳定姿势和放箭节奏为重点的基础训练。", "bow_type": "RECURVE", "distance_m": 18, "target_definition_id": WA_10_RING_ID, "default_end_count": 6, "default_arrows_per_end": 6, "blocks": [{"block_type": "WARMUP", "title": "热身", "duration_minutes": 10, "is_scored": False}, {"block_type": "TECHNIQUE", "title": "基础动作练习", "instructions": "专注站姿、拉弓与锚点。", "end_count": 3, "arrows_per_end": 6, "is_scored": False}, {"block_type": "COOLDOWN_REVIEW", "title": "收操与复盘", "duration_minutes": 5, "is_scored": False}]},
    {"key": "group-stability", "name": "分组稳定性", "description": "用固定分组观察每组表现是否稳定。", "bow_type": "RECURVE", "distance_m": 18, "target_definition_id": WA_10_RING_ID, "default_end_count": 8, "default_arrows_per_end": 6, "blocks": [{"block_type": "WARMUP", "title": "热身", "duration_minutes": 10, "is_scored": False}, {"block_type": "SCORING", "title": "稳定性分组", "instructions": "每组之间保持相同准备流程。", "end_count": 8, "arrows_per_end": 6, "is_scored": True}, {"block_type": "COOLDOWN_REVIEW", "title": "记录感受", "duration_minutes": 5, "is_scored": False}]},
    {"key": "scoring-simulation", "name": "计分模拟", "description": "按比赛节奏进行完整的计分练习。", "bow_type": "RECURVE", "distance_m": 18, "target_definition_id": WA_10_RING_ID, "default_end_count": 10, "default_arrows_per_end": 3, "blocks": [{"block_type": "WARMUP", "title": "热身", "duration_minutes": 10, "is_scored": False}, {"block_type": "SCORING", "title": "计分轮", "instructions": "按正式计分节奏完成，不补射。", "end_count": 10, "arrows_per_end": 3, "is_scored": True}, {"block_type": "COOLDOWN_REVIEW", "title": "复盘", "duration_minutes": 10, "is_scored": False}]},
)


def ensure_built_in_targets(db: Session) -> list[TargetDefinition]:
    for target in BUILT_IN_TARGETS:
        if db.get(TargetDefinition, target["id"]) is None:
            db.add(TargetDefinition(**target, is_built_in=True))
    db.commit()
    return list(db.scalars(select(TargetDefinition).order_by(TargetDefinition.name)))


def _clean(value: str | None, limit: int, label: str, required: bool = False) -> str | None:
    result = value.strip() if value else None
    if required and not result:
        raise HTTPException(422, f"{label}不能为空")
    if result and len(result) > limit:
        raise HTTPException(422, f"{label}最多 {limit} 个字符")
    return result


def validate_plan_payload(payload: dict, db: Session) -> dict:
    data = dict(payload)
    data["name"] = _clean(data.get("name"), 80, "计划名称", True)
    data["description"] = _clean(data.get("description"), 500, "计划说明")
    data["equipment_note"] = _clean(data.get("equipment_note"), 500, "器材备注")
    if data.get("bow_type") not in {"RECURVE", "COMPOUND", "BAREBOW", "TRADITIONAL", "CUSTOM"}:
        raise HTTPException(422, "请选择有效的弓种")
    if not 0 < data.get("distance_m", 0):
        raise HTTPException(422, "距离必须大于 0")
    if not 1 <= data.get("default_end_count", 0) <= 200 or not 1 <= data.get("default_arrows_per_end", 0) <= 12:
        raise HTTPException(422, "组数应为 1–200，每组箭数应为 1–12")
    if db.get(TargetDefinition, data.get("target_definition_id")) is None:
        raise HTTPException(422, "请选择可用靶面")
    blocks = data.get("blocks") or []
    if not 1 <= len(blocks) <= 20:
        raise HTTPException(422, "训练区块数量应为 1–20")
    validated = []
    for index, block in enumerate(blocks, 1):
        item = dict(block)
        item.pop("id", None)
        item.pop("position", None)
        if item.get("block_type") not in {"WARMUP", "TECHNIQUE", "SCORING", "COOLDOWN_REVIEW"}:
            raise HTTPException(422, f"第 {index} 个区块类型无效")
        item["title"] = _clean(item.get("title"), 80, f"第 {index} 个区块标题", True)
        item["instructions"] = _clean(item.get("instructions"), 1000, f"第 {index} 个区块说明")
        ends, arrows, duration = item.get("end_count"), item.get("arrows_per_end"), item.get("duration_minutes")
        if (ends is None) != (arrows is None) or (ends is None and duration is None):
            raise HTTPException(422, f"第 {index} 个区块需要完整的箭量或时长")
        if ends is not None and not (1 <= ends <= 200 and 1 <= arrows <= 12):
            raise HTTPException(422, f"第 {index} 个区块箭量无效")
        if duration is not None and not 1 <= duration <= 300:
            raise HTTPException(422, f"第 {index} 个区块时长应为 1–300 分钟")
        if item["block_type"] == "SCORING" and (not item.get("is_scored") or ends is None):
            raise HTTPException(422, "计分区块必须设置完整箭量并启用计分")
        validated.append(item)
    data["blocks"] = validated
    return data


def plan_to_dict(plan: TrainingPlan) -> dict:
    return {"id": plan.id, "revision": plan.revision, "name": plan.name, "description": plan.description, "bow_type": plan.bow_type, "distance_m": plan.distance_m, "target_definition_id": plan.target_definition_id, "default_end_count": plan.default_end_count, "default_arrows_per_end": plan.default_arrows_per_end, "equipment_note": plan.equipment_note, "status": plan.status, "source_plan_id": plan.source_plan_id, "blocks": [{"id": block.id, "position": block.position, "block_type": block.block_type, "title": block.title, "instructions": block.instructions, "end_count": block.end_count, "arrows_per_end": block.arrows_per_end, "duration_minutes": block.duration_minutes, "is_scored": block.is_scored} for block in sorted(plan.blocks, key=lambda item: item.position)]}


def get_plan(db: Session, plan_id: str, owner_id: str | None = None) -> TrainingPlan:
    query = select(TrainingPlan).options(selectinload(TrainingPlan.blocks)).where(TrainingPlan.id == plan_id)
    if owner_id is not None:
        query = query.where(TrainingPlan.owner_id == owner_id)
    plan = db.scalar(query)
    if plan is None:
        raise HTTPException(404, "未找到训练计划")
    return plan


def save_plan(db: Session, payload: dict, plan: TrainingPlan | None = None, source_plan_id: str | None = None, owner_id: str = "local-dev") -> TrainingPlan:
    data = validate_plan_payload(payload, db)
    fields = ("name", "description", "bow_type", "distance_m", "target_definition_id", "default_end_count", "default_arrows_per_end", "equipment_note")
    if plan is None:
        plan = TrainingPlan(id=str(uuid4()), owner_id=owner_id, source_plan_id=source_plan_id, status=PlanStatus.ACTIVE, **{key: data[key] for key in fields})
        db.add(plan)
    else:
        for key in fields:
            setattr(plan, key, data[key])
        plan.revision += 1
        for block in list(plan.blocks):
            db.delete(block)
        db.flush()
    for position, block in enumerate(data["blocks"], 1):
        plan.blocks.append(PlanBlock(id=str(uuid4()), position=position, **block))
    db.commit()
    return get_plan(db, plan.id)


def start_session(db: Session, plan: TrainingPlan) -> TrainingSession:
    if plan.status == PlanStatus.ARCHIVED:
        raise HTTPException(409, "已归档计划不能直接开始训练，请先复制它")
    target = db.get(TargetDefinition, plan.target_definition_id)
    # The column predates this contract and is timezone-naive. New values are
    # nevertheless always stored as UTC; serializers add the explicit ``Z``.
    started_at_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    session = TrainingSession(id=str(uuid4()), owner_id=plan.owner_id, training_plan_id=plan.id, plan_snapshot=plan_to_dict(plan), target_definition_id=target.id, target_snapshot=snapshot_for_target(target), bow_type=plan.bow_type, distance_m=plan.distance_m, planned_end_count=plan.default_end_count, arrows_per_end=plan.default_arrows_per_end, status=SessionStatus.DRAFT, started_at=started_at_utc)
    db.add(session)
    db.commit()
    return session

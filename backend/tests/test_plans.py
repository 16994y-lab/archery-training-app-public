import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.plans import TEMPLATES, ensure_built_in_targets, get_plan, plan_to_dict, save_plan, start_session


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    ensure_built_in_targets(session)
    yield session
    session.close()


def test_template_plan_can_be_saved_copied_archived_and_started_with_snapshot(db: Session) -> None:
    payload = dict(TEMPLATES[0])
    payload.pop("key")
    plan = save_plan(db, payload)
    assert plan.status == "ACTIVE"
    assert [block.position for block in plan.blocks] == [1, 2, 3]

    copied_payload = plan_to_dict(plan)
    copied_payload["name"] = "基础动作（副本）"
    copied = save_plan(db, copied_payload, source_plan_id=plan.id)
    assert copied.source_plan_id == plan.id
    assert copied.id != plan.id

    session = start_session(db, plan)
    original_name = session.plan_snapshot["name"]
    changed = plan_to_dict(plan)
    changed["name"] = "已修改的计划"
    save_plan(db, changed, plan)
    assert session.plan_snapshot["name"] == original_name

    plan.status = "ARCHIVED"
    db.commit()
    with pytest.raises(HTTPException, match="已归档"):
        start_session(db, get_plan(db, plan.id))


@pytest.mark.parametrize("mutate", [
    lambda payload: payload.update(name="   "),
    lambda payload: payload.update(default_arrows_per_end=13),
    lambda payload: payload.update(blocks=[{"block_type": "SCORING", "title": "计分", "duration_minutes": 10, "is_scored": True}]),
    lambda payload: payload.update(blocks=[{"block_type": "TECHNIQUE", "title": "坏箭量", "end_count": 3, "is_scored": False}]),
])
def test_invalid_plan_payload_is_rejected(db: Session, mutate) -> None:
    payload = dict(TEMPLATES[0])
    payload.pop("key")
    mutate(payload)
    with pytest.raises(HTTPException):
        save_plan(db, payload)

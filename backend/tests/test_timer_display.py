import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.timer_display import (CLOSED_TTL_MS, FRAME_TTL_MS, MAX_LIFETIME_MS, MIN_FRAME_INTERVAL_MS,
                           ROOM_TTL_MS, ROOMS, TOKEN, create_timer_display_router)


PREFIX = "/api/timer-display"
BASE_FRAME = {
    "stage": "shoot", "label": "A 方发射",
    "clocks": [
        {"name": "A 方", "time": "00:19", "active": True},
        {"name": "B 方", "time": "00:20", "active": False},
    ],
    "signal": {"id": "1", "kind": "shoot"},
}


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def harness(tmp_path):
    database = os.environ.get("GONGXINGJI_TIMER_TEST_POSTGRES")
    if database:
        from alembic.migration import MigrationContext
        from alembic.operations import Operations

        target = make_url(database)
        assert target.host == "127.0.0.1" and target.database == "timer_display_test"
        engine = create_engine(database, hide_parameters=True)
        migration_file = Path(__file__).resolve().parents[1].joinpath("alembic", "versions", "20261111_0015_timer_display.py")
        spec = importlib.util.spec_from_file_location("timer_display_migration", migration_file)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            migration.upgrade()
    else:
        engine = create_engine(
            "sqlite:///" + (tmp_path / "timer.sqlite").as_posix(),
            execution_options={"schema_translate_map": {"public": None}},
            hide_parameters=True,
        )
        ROOMS.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    clock = [1_000_000]

    def make_client(**options):
        app = FastAPI()
        app.include_router(create_timer_display_router(factory, clock=lambda: clock[0], **options))
        return TestClient(app)

    yield make_client, factory, clock, engine
    if database:
        with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()
    engine.dispose()


def create(client):
    response = client.post(PREFIX + "/rooms", json={})
    assert response.status_code == 201
    assert response.headers["Cache-Control"] == "no-store"
    values = response.json()
    assert set(values) == {"displayKey", "pairCode"}
    assert all(TOKEN.fullmatch(value) for value in values.values())
    assert len(set(values.values())) == 2
    return values


def test_status_probes_schema_without_allocating_room(harness):
    make_client, factory, _, _ = harness
    response = make_client().get(PREFIX + "/status")
    assert response.status_code == 200 and response.json() == {"ready": True}
    assert response.headers["Cache-Control"] == "no-store"
    with factory() as db:
        assert db.execute(select(ROOMS.c.display_hash)).first() is None


def claim(client, pair_code):
    response = client.post(PREFIX + "/claim", json={"pairCode": pair_code})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    key = response.json()["controlKey"]
    assert TOKEN.fullmatch(key)
    return key


def state(client, display_key):
    response = client.get(PREFIX + "/state", headers=auth(display_key))
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    return response.json()


def publish(client, key, seq, frame=BASE_FRAME):
    return client.put(PREFIX + "/frame", json={"seq": seq, "frame": frame}, headers=auth(key))


def test_distinct_capabilities_and_single_use_claim_across_app_instances(harness):
    make_client, factory, _, _ = harness
    display, control = make_client(), make_client()
    room = create(display)
    key, code = room["displayKey"], room["pairCode"]
    assert state(display, key) == {"connected": False, "frame": None, "seq": 0}
    controller = claim(control, code)
    assert len({key, code, controller}) == 3
    assert state(display, key) == {"connected": True, "frame": None, "seq": 0}
    assert control.post(PREFIX + "/claim", json={"pairCode": code}).status_code == 404
    assert control.get(PREFIX + "/state", headers=auth(controller)).status_code == 404
    assert publish(control, key, 1).status_code == 404
    with factory() as database:
        saved = database.execute(select(ROOMS)).one()
        assert saved.pair_hash is None
        assert all(len(value) == 64 for value in (saved.display_hash, saved.control_hash))
        assert all(secret not in str(saved) for secret in (key, code, controller))
    assert publish(control, controller, 1).status_code == 200
    assert state(display, key) == {"connected": True, "frame": BASE_FRAME, "seq": 1}


def test_atomic_claim_and_admission(harness):
    make_client, _, _, _ = harness
    code = create(make_client())["pairCode"]
    pair = Barrier(2)

    def simultaneous_claim():
        client = make_client()
        pair.wait()
        return client.post(PREFIX + "/claim", json={"pairCode": code}).status_code

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = [workers.submit(simultaneous_claim) for _ in range(2)]
        assert sorted(item.result() for item in results) == [200, 404]

    admission = Barrier(2)

    def simultaneous_create():
        client = make_client(max_rooms=2)
        admission.wait()
        return client.post(PREFIX + "/rooms", json={}).status_code

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = [workers.submit(simultaneous_create) for _ in range(2)]
        assert sorted(item.result() for item in results) == [201, 503]


def test_sequencing_rate_and_heartbeat(harness):
    make_client, _, clock, _ = harness
    client = make_client()
    room = create(client)
    key = room["displayKey"]
    controller = claim(client, room["pairCode"])
    assert publish(client, controller, 1).status_code == 200
    assert publish(client, controller, 2).status_code == 429
    assert publish(client, controller, 1).status_code == 200
    assert publish(client, controller, 1, {**BASE_FRAME, "signal": None}).status_code == 409
    clock[0] += FRAME_TTL_MS - 1
    assert state(client, key)["frame"] == BASE_FRAME
    assert publish(client, controller, 1).status_code == 200
    clock[0] += 1
    assert state(client, key) == {"connected": True, "frame": None, "seq": 1}
    no_signal = {**BASE_FRAME, "signal": None}
    assert publish(client, controller, 3, no_signal).status_code == 200
    clock[0] += MIN_FRAME_INTERVAL_MS
    assert publish(client, controller, 2).status_code == 409
    assert state(client, key) == {"connected": True, "frame": no_signal, "seq": 3}


def test_bounded_expiry_and_display_or_control_disconnect(harness):
    make_client, factory, clock, _ = harness
    client = make_client(max_rooms=2, max_waiting=1)
    room = create(client)
    assert client.post(PREFIX + "/rooms", json={}).status_code == 503
    clock[0] += ROOM_TTL_MS
    assert client.post(PREFIX + "/claim", json={"pairCode": room["pairCode"]}).status_code == 404
    newer = create(client)
    assert client.get(PREFIX + "/state", headers=auth(room["displayKey"])).status_code == 404
    control = claim(client, newer["pairCode"])
    assert publish(client, control, 1).status_code == 200
    assert client.delete(PREFIX + "/connection", headers=auth(newer["displayKey"])).status_code == 204
    assert state(client, newer["displayKey"]) == {"connected": False, "frame": None, "seq": 1}
    assert client.delete(PREFIX + "/connection", headers=auth(control)).status_code == 204
    assert publish(client, control, 2).status_code == 404
    clock[0] += CLOSED_TTL_MS
    assert client.get(PREFIX + "/state", headers=auth(newer["displayKey"])).status_code == 404

    age_zero = clock[0]
    last = create(client)
    controller = claim(client, last["pairCode"])
    for seq in range(1, 14):
        clock[0] = age_zero + seq * (ROOM_TTL_MS - 10)
        if clock[0] >= age_zero + MAX_LIFETIME_MS:
            assert publish(client, controller, seq).status_code == 404
            break
        assert publish(client, controller, seq).status_code == 200
    with factory() as database:
        rows = database.execute(select(ROOMS)).all()
        assert len(rows) == 1
        assert rows[0].expires_at == age_zero + MAX_LIFETIME_MS


def test_bounded_json_and_validation_do_not_echo_input(harness):
    make_client, _, _, _ = harness
    client = make_client()
    room = create(client)
    key = claim(client, room["pairCode"])
    protected = room["pairCode"] + "私有昵称"
    invalid = publish(client, key, 1, {**BASE_FRAME, "label": protected})
    assert invalid.status_code == 422 and protected not in invalid.text
    assert invalid.headers["Cache-Control"] == "no-store"
    assert publish(client, key, True).status_code == 422
    assert publish(client, key, 1, {**BASE_FRAME, "userId": protected}).status_code == 422
    assert publish(client, key, 1, {**BASE_FRAME, "clocks": []}).status_code == 422
    invalid_clock = {**BASE_FRAME, "clocks": [{"name": "A 方", "time": "00:99", "active": True}]}
    assert publish(client, key, 1, invalid_clock).status_code == 422
    large = client.post(PREFIX + "/claim", content=b"x" * 4096)
    assert large.status_code == 413 and large.headers["Cache-Control"] == "no-store"
    streamed = client.post(PREFIX + "/claim", content=(b"x" * 900 for _ in range(3)),
                           headers={"Content-Type": "application/json"})
    assert streamed.status_code == 413 and streamed.headers["Cache-Control"] == "no-store"
    missing = client.get(PREFIX + "/state")
    assert missing.status_code == 401 and missing.headers["Cache-Control"] == "no-store"


def test_database_errors_fail_closed_without_detail(harness):
    make_client, _, _, engine = harness
    client = make_client()
    original = ROOMS.name
    try:
        ROOMS.name = "timer_display_missing"
        response = client.post(PREFIX + "/rooms")
        assert response.status_code == 503
        assert response.json() == {"detail": "在线大屏暂不可用"}
        assert response.headers["Cache-Control"] == "no-store"
    finally:
        ROOMS.name = original


def test_postgres_migration_private_to_direct_database_owner(harness):
    _, _, _, engine = harness
    if engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL migration")
    with engine.connect() as connection:
        assert connection.scalar(text(
            "SELECT relrowsecurity FROM pg_class WHERE oid='public.timer_display_rooms'::regclass"
        ))
        for role in ("anon", "authenticated", "service_role"):
            assert connection.scalar(text(
                "SELECT has_table_privilege(:role, 'public.timer_display_rooms', 'SELECT')"
            ), {"role": role}) is False


def test_display_heartbeat_and_concurrent_end(harness):
    make_client, factory, clock, _ = harness
    client = make_client()
    room = create(client)
    display = room["displayKey"]
    controller = claim(client, room["pairCode"])
    assert publish(client, controller, 1).json() == {"displayOnline": False}
    first_view = clock[0]
    assert state(client, display)["frame"] == BASE_FRAME
    clock[0] += 999
    assert state(client, display)["connected"] is True
    with factory() as database:
        assert database.scalar(select(ROOMS.c.last_view_at)) == first_view
    clock[0] += 1
    assert state(client, display)["connected"] is True
    with factory() as database:
        assert database.scalar(select(ROOMS.c.last_view_at)) == clock[0]
    assert publish(client, controller, 2).json() == {"displayOnline": True}
    clock[0] += FRAME_TTL_MS
    assert publish(client, controller, 3).json() == {"displayOnline": False}
    assert state(client, display)["connected"] is True
    assert publish(client, controller, 3).json() == {"displayOnline": True}
    clock[0] += MIN_FRAME_INTERVAL_MS

    transition = Barrier(3)

    def end_from(key):
        worker = make_client()
        transition.wait()
        return worker.delete(PREFIX + "/connection", headers=auth(key)).status_code

    def publish_while_closing():
        worker = make_client()
        transition.wait()
        return publish(worker, controller, 4).status_code

    with ThreadPoolExecutor(max_workers=3) as workers:
        end_control = workers.submit(end_from, controller)
        end_display = workers.submit(end_from, display)
        update_state = workers.submit(publish_while_closing)
        assert end_control.result() == end_display.result() == 204
        assert update_state.result() in (200, 404)

    assert state(client, display)["connected"] is False
    assert state(client, display)["frame"] is None
    assert publish(client, controller, 5).status_code == 404
    with factory() as database:
        assert database.scalar(select(ROOMS.c.last_view_at)) is None

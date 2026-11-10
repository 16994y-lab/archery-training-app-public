"""Strict score projection. Never accepts a full personal training document."""
from copy import deepcopy
from datetime import date
import hashlib
import json
import math
import re

from fastapi import HTTPException
from app.score_backup import _validate_target
from app.scoring import ScoreCode, score_from_target_coordinate, summarize_scores
from app.target_contracts import ALL_SCORE_CODES, TARGET_CONTRACTS

BOWS = ("反曲弓", "复合弓", "传统弓", "裸弓", "光弓", "美猎弓", "长弓", "其他")
KNOWN_BOWS = BOWS[:-1]


def invalid():
    raise HTTPException(422, "请求格式或共享范围无效")


def exact(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        invalid()


def integer(value, low=0, high=2**53-1):
    return type(value) is int and low <= value <= high


def number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value) is not None


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        invalid()
    try:
        if date.fromisoformat(value).isoformat() != value:
            invalid()
    except ValueError:
        invalid()
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _mobile_target(id_, name, minimum, layout, include_x, compound=False):
    # Exact mobile/domain.ts makeTarget contract; geometry validation/scoring remains shared.
    count = 11 - minimum
    rings = [{"score_code": str(10-i), "label": str(10-i),
              "color": "#f5cf36" if 10-i >= 9 else "#e34747" if 10-i >= 7 else "#299ed2" if 10-i >= 5 else "#202329" if 10-i >= 3 else "#ffffff",
              "outer_radius_norm": (i+1)/count*.5} for i in range(count)]
    if compound:
        rings[0]["outer_radius_norm"] *= .5
    if include_x:
        rings.insert(0, {**rings[0], "score_code": "X", "label": "X", "outer_radius_norm": rings[0]["outer_radius_norm"]/2})
    anchors = [(0.5, 0.5)] if layout == "SINGLE" else [(0.5, .17), (.5, .5), (.5, .83)] if layout == "VERTICAL" else [(.25, .73), (.5, .24), (.75, .73)]
    return {"id": id_, "name": name, "target_type": "WA_CONCENTRIC", "scoring_mode": "RING_GEOMETRY",
            "face_count": len(anchors), "sizeRatio": count/10, "rules_version": "target-contract/v1",
            "allowed_score_codes": [r["score_code"] for r in rings] + ["M"],
            "coordinate_space": "selected-face-scoring-square/v1", "boundary_policy": "HIGHER_SCORE_INCLUSIVE",
            "ring_rules": rings, "layout": {"kind": layout, "face_count": len(anchors), "faces": [{"index": i, "anchor_x": x, "anchor_y": y} for i, (x, y) in enumerate(anchors, 1)]},
            "plot": {"coordinate_space": "face-with-white-buffer/v1", "center_x": .5, "center_y": .5,
                     "outer_scoring_radius_norm": 5/12, "calibration_boundary_score_code": str(minimum), "control_order": ["TOP", "RIGHT", "BOTTOM", "LEFT"]}}


MOBILE_TARGETS = {t["id"]: t for t in [
    _mobile_target("mobile-full", "十环靶 · X / 10–1", 1, "SINGLE", True),
    _mobile_target("mobile-six", "6–10 环单靶 · 反曲", 6, "SINGLE", False),
    _mobile_target("mobile-five", "5–10 环单靶 · X", 5, "SINGLE", True),
    _mobile_target("mobile-vertical-r", "竖向三联 · 反曲 6–10", 6, "VERTICAL", False),
    _mobile_target("mobile-triangle-r", "三角三联 · 反曲 6–10", 6, "TRIANGLE", False),
    _mobile_target("mobile-vertical-c", "竖向三联 · 复合内十环", 6, "VERTICAL", False, True),
    _mobile_target("mobile-triangle-c", "三角三联 · 复合内十环", 6, "TRIANGLE", False, True),
    _mobile_target("mobile-six-x", "6–10 环训练靶 · X", 6, "SINGLE", True),
]}
STANDARD_TARGETS = {**{k: {**deepcopy(v), "sizeRatio": v["scoring_diameter_cm"]/v["nominal_face_diameter_cm"]} for k, v in TARGET_CONTRACTS.items()}, **MOBILE_TARGETS}


def _rule(target):
    return {key: value for key, value in target.items() if key not in ("name", "custom")} | {
        "ring_rules": [{k: v for k, v in r.items() if k != "label"} for r in target["ring_rules"]]}


def _same(left, right):
    if type(left) is dict and type(right) is dict:
        return left.keys() == right.keys() and all(_same(left[k], right[k]) for k in left)
    if type(left) is list and type(right) is list:
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    if type(left) in (float, int) and type(right) in (float, int):
        return abs(left-right) < 1e-12
    return type(left) is type(right) and left == right


def project_source(member_id, source, updated_at):
    """Return only approved fields and an opaque input hash; no raw source is stored."""
    exact(source, ("id", "date", "revision", "status", "conditions", "ends"))
    if not identifier(member_id) or not identifier(source["id"]) or not integer(source["revision"], 1) or source["status"] != "completed":
        invalid()
    day(source["date"])
    c = source["conditions"]
    exact(c, ("bow", "distance", "size", "target"))
    if not isinstance(c["bow"], str) or len(c["bow"]) > 100 or not number(c["distance"], 1e-8, 1000) or not (c["size"] is None or number(c["size"], 1e-8, 1000)):
        invalid()
    target = c["target"]
    try:
        # Structurally valid unknown versions retain scores without spatial claims.
        checked = deepcopy(target)
        checked["rules_version"] = "target-contract/v1"
        _validate_target(checked)
        if not identifier(target["id"]) or not isinstance(target["name"], str) or len(target["name"]) > 100 or not isinstance(target["rules_version"], str) or len(target["rules_version"]) > 80:
            invalid()
    except (HTTPException, KeyError, TypeError, ValueError, AttributeError):
        invalid()
    canonical = STANDARD_TARGETS.get(target["id"])
    known = canonical is not None and _same(_rule(target), _rule(canonical))
    if type(source["ends"]) is not list or not 1 <= len(source["ends"]) <= 500:
        invalid()
    points, ends, codes, seen = [], [], [], set()
    numeric, reference = 0, 0
    for end in source["ends"]:
        exact(end, ("index", "capacity", "half", "arrows"))
        if not integer(end["index"], 1, 500) or end["index"] in seen or end["half"] not in ("", "上半场", "下半场") or not integer(end["capacity"], 1, 300) or type(end["arrows"]) is not list or not 1 <= len(end["arrows"]) <= end["capacity"]:
            invalid()
        seen.add(end["index"])
        for ai, arrow in enumerate(end["arrows"], 1):
            exact(arrow, ("code", "x", "y", "face", "source"), ("coordinateEvidence",))
            if arrow["code"] not in ALL_SCORE_CODES or arrow["source"] not in ("number", "target", "photo") or not integer(arrow["face"], 1, target["face_count"]):
                invalid()
            x, y = arrow["x"], arrow["y"]
            if not ((x is None and y is None) or (number(x, -1.2, 1.2) and number(y, -1.2, 1.2))) or (arrow["source"] == "number" and x is not None):
                invalid()
            if "coordinateEvidence" in arrow and (arrow["coordinateEvidence"] != "manual-target-confirmed" or arrow["source"] != "photo" or x is None):
                invalid()
            if known and arrow["code"] not in canonical["allowed_score_codes"]:
                invalid()
            codes.append(ScoreCode(arrow["code"]))
            numeric += arrow["source"] == "number"
            valid_point = known and x is not None and score_from_target_coordinate(canonical, .5+x/2, .5-y/2).value == arrow["code"]
            if known and x is not None and not valid_point:
                invalid()
            if valid_point and (arrow["source"] == "target" or arrow.get("coordinateEvidence") == "manual-target-confirmed"):
                points.append({k: arrow[k] for k in ("x", "y", "code", "face", "source")} | {"endIndex": end["index"], "arrowIndex": ai})
            elif valid_point and arrow["source"] == "photo":
                reference += 1
        ends.append({k: end[k] for k in ("index", "capacity", "half")} | {"codes": [a["code"] for a in end["arrows"]]})
    if len(codes) > 30000 or [e["index"] for e in ends] != sorted(seen):
        invalid()
    stats = summarize_scores(codes)
    conditions = {"bow": c["bow"] if c["bow"] in KNOWN_BOWS else "未知弓种", "distance": c["distance"], "size": c["size"],
                  "targetId": canonical["id"] if known else "custom", "targetName": canonical["name"] if known else "自定义靶", "rulesVersion": canonical["rules_version"] if known else "未知规则"}
    group_key = json.dumps([conditions["bow"], c["distance"], c["size"], _rule(canonical)], ensure_ascii=False, sort_keys=True, separators=(",", ":")) if known and c["bow"] in KNOWN_BOWS and c["size"] is not None else None
    value = {"id": source["id"], "memberId": member_id, "revision": source["revision"], "date": source["date"], "updatedAt": updated_at,
             "conditions": conditions, "ends": ends, "summary": {"arrows": stats.arrow_count, "total": stats.total_score, "average": stats.average_score,
             "distribution": {code: codes.count(ScoreCode(code)) for code in ALL_SCORE_CODES}, "trustedPoints": len(points), "numericCount": numeric, "referenceCount": reference},
             "points": points, "targetFace": {"name": canonical["name"], "faceCount": canonical["face_count"], "layout": deepcopy(canonical["layout"]),
             "rings": [{"code": r["score_code"], "color": r["color"], "radius": r["outer_radius_norm"]*2} for r in canonical["ring_rules"]]} if known else None,
             "groupKey": group_key, "strictComparable": False, "comparisonReason": "器材条件未知，仅显示相同筛选条件下的描述统计"}
    return value, digest(source)

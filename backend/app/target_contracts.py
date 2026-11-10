"""Versioned target contracts shared by scoring, API responses, and snapshots.

Database target rows are catalogue pointers. A training session always owns a
complete immutable snapshot, so later catalogue additions cannot reinterpret
historical arrows.
"""

from copy import deepcopy
from math import isfinite


RULES_VERSION = "target-contract/v1"
LEGACY_RULES_VERSION = "legacy-v1"
COORDINATE_SPACE = "selected-face-scoring-square/v1"
PLOT_COORDINATE_SPACE = "face-with-white-buffer/v1"
PLOT_OUTER_SCORING_RADIUS = 5 / 12

ALL_SCORE_CODES = ["X", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "M"]

SCORE_COLORS = {
    "X": "#F4D03F", "10": "#F4D03F", "9": "#F4D03F",
    "8": "#D64545", "7": "#D64545", "6": "#2F7DBB", "5": "#2F7DBB",
    "4": "#222222", "3": "#222222", "2": "#F7F7F7", "1": "#F7F7F7",
}


class TargetContractError(ValueError):
    pass


def _rings(items: list[tuple[str, float]]) -> list[dict]:
    return [
        {"score_code": code, "label": code, "color": SCORE_COLORS[code], "outer_radius_norm": radius}
        for code, radius in items
    ]


def _layout(kind: str, anchors: list[tuple[float, float]]) -> dict:
    return {
        "kind": kind,
        "face_count": len(anchors),
        "faces": [
            {"index": index, "anchor_x": x, "anchor_y": y}
            for index, (x, y) in enumerate(anchors, 1)
        ],
    }


def _geometry_contract(
    *, target_id: str, name: str, target_type: str, diameter_cm: float,
    scoring_diameter_cm: float, allowed: list[str], rings: list[tuple[str, float]],
    layout: dict, profile: str = "LEGACY_X_AND_TEN",
) -> dict:
    return {
        "id": target_id,
        "name": name,
        "target_type": target_type,
        "scoring_mode": "RING_GEOMETRY",
        "face_count": layout["face_count"],
        "rules_version": RULES_VERSION,
        "scoring_profile": profile,
        "nominal_face_diameter_cm": diameter_cm,
        "scoring_diameter_cm": scoring_diameter_cm,
        "allowed_score_codes": allowed,
        "coordinate_space": COORDINATE_SPACE,
        "boundary_policy": "HIGHER_SCORE_INCLUSIVE",
        "ring_rules": _rings(rings),
        "layout": layout,
        "plot": {
            "coordinate_space": PLOT_COORDINATE_SPACE,
            "center_x": 0.5,
            "center_y": 0.5,
            "outer_scoring_radius_norm": PLOT_OUTER_SCORING_RADIUS,
            "calibration_boundary_score_code": rings[-1][0],
            "control_order": ["TOP", "RIGHT", "BOTTOM", "LEFT"],
        },
    }


FULL_TEN_RINGS = [
    ("X", .025), ("10", .05), ("9", .10), ("8", .15), ("7", .20),
    ("6", .25), ("5", .30), ("4", .35), ("3", .40), ("2", .45), ("1", .50),
]
FIVE_TO_TEN_RINGS = [
    ("X", 1 / 24), ("10", 1 / 12), ("9", 1 / 6), ("8", 1 / 4),
    ("7", 1 / 3), ("6", 5 / 12), ("5", .50),
]
SIX_TO_TEN_RINGS = [
    ("X", .05), ("10", .10), ("9", .20), ("8", .30), ("7", .40), ("6", .50),
]

SINGLE = _layout("SINGLE", [(.5, .5)])
VERTICAL_THREE = _layout("VERTICAL_THREE", [(.5, .18), (.5, .5), (.5, .82)])
TRIANGULAR_THREE = _layout("TRIANGULAR_THREE", [(.5, .20), (.28, .70), (.72, .70)])


TARGET_CONTRACTS = {
    "builtin-wa-10-ring": _geometry_contract(
        target_id="builtin-wa-10-ring", name="WA 十环靶", target_type="WA_10_RING",
        diameter_cm=122, scoring_diameter_cm=122, allowed=ALL_SCORE_CODES, rings=FULL_TEN_RINGS, layout=SINGLE,
    ),
    "builtin-wa-vertical-3-spot": _geometry_contract(
        target_id="builtin-wa-vertical-3-spot", name="室内三联靶", target_type="WA_VERTICAL_3_SPOT",
        diameter_cm=40, scoring_diameter_cm=20,
        allowed=["X", "10", "9", "8", "7", "6", "M"], rings=SIX_TO_TEN_RINGS, layout=VERTICAL_THREE,
    ),
    "builtin-wa-80-5-to-10-v1": _geometry_contract(
        target_id="builtin-wa-80-5-to-10-v1", name="WA 80 cm 5–10 环靶", target_type="WA_CONCENTRIC",
        diameter_cm=80, scoring_diameter_cm=48,
        allowed=["X", "10", "9", "8", "7", "6", "5", "M"], rings=FIVE_TO_TEN_RINGS, layout=SINGLE,
    ),
    "builtin-training-40-6-to-10-single-v1": _geometry_contract(
        target_id="builtin-training-40-6-to-10-single-v1", name="40 cm 6–10 训练单靶", target_type="WA_CONCENTRIC",
        diameter_cm=40, scoring_diameter_cm=20,
        allowed=["X", "10", "9", "8", "7", "6", "M"], rings=SIX_TO_TEN_RINGS, layout=SINGLE,
    ),
    "builtin-wa-40-6-to-10-triangle-v1": _geometry_contract(
        target_id="builtin-wa-40-6-to-10-triangle-v1", name="WA 40 cm 6–10 三角三联", target_type="WA_CONCENTRIC",
        diameter_cm=40, scoring_diameter_cm=20,
        allowed=["X", "10", "9", "8", "7", "6", "M"], rings=SIX_TO_TEN_RINGS, layout=TRIANGULAR_THREE,
    ),
}

SCORE_ONLY_CONTRACT = {
    "id": "builtin-custom-score-only", "name": "自定义数字靶面",
    "target_type": "CUSTOM_SCORE_ONLY", "scoring_mode": "SCORE_ONLY", "face_count": 1,
    "rules_version": RULES_VERSION, "scoring_profile": "SCORE_ONLY",
    "nominal_face_diameter_cm": None, "scoring_diameter_cm": None,
    "allowed_score_codes": ALL_SCORE_CODES, "coordinate_space": None,
    "boundary_policy": None, "ring_rules": None, "layout": SINGLE, "plot": None,
}


def _validate_contract(contract: dict) -> dict:
    allowed = contract.get("allowed_score_codes")
    if not isinstance(allowed, list) or not allowed or len(set(allowed)) != len(allowed):
        raise TargetContractError("靶面允许成绩配置无效")
    if any(code not in ALL_SCORE_CODES for code in allowed):
        raise TargetContractError("靶面包含未知成绩代码")
    layout = contract.get("layout")
    face_count = contract.get("face_count")
    if not isinstance(face_count, int) or not isinstance(layout, dict) or layout.get("face_count") != face_count or not 1 <= face_count <= 3:
        raise TargetContractError("靶面布局配置无效")
    faces = layout.get("faces")
    if not isinstance(faces, list) or not all(isinstance(face, dict) for face in faces) or [face.get("index") for face in faces] != list(range(1, face_count + 1)):
        raise TargetContractError("靶面序号配置无效")
    if contract.get("rules_version") not in (RULES_VERSION, LEGACY_RULES_VERSION):
        raise TargetContractError("未知靶面规则版本")
    if contract.get("scoring_mode") not in ("RING_GEOMETRY", "SCORE_ONLY"):
        raise TargetContractError("未知靶面计分模式")
    if contract.get("scoring_mode") == "SCORE_ONLY":
        if contract.get("ring_rules") is not None or contract.get("plot") is not None or contract.get("coordinate_space") is not None:
            raise TargetContractError("数字靶面不能配置环线")
        return contract
    if contract.get("coordinate_space") != COORDINATE_SPACE or contract.get("boundary_policy") != "HIGHER_SCORE_INCLUSIVE":
        raise TargetContractError("靶面坐标或压线规则无效")
    rings = contract.get("ring_rules")
    if not isinstance(rings, list) or not rings:
        raise TargetContractError("靶面环线配置缺失")
    previous = 0.0
    codes = []
    for ring in rings:
        radius = ring.get("outer_radius_norm") if isinstance(ring, dict) else None
        code = ring.get("score_code") if isinstance(ring, dict) else None
        if code not in ALL_SCORE_CODES or code == "M" or not isinstance(radius, (int, float)) or not isfinite(radius) or not previous < radius <= .5:
            raise TargetContractError("靶面环线配置无效")
        previous = float(radius)
        codes.append(code)
    if abs(previous - .5) > 1e-12 or allowed != [*codes, "M"]:
        raise TargetContractError("靶面环线与允许成绩不一致")
    plot = contract.get("plot")
    if not isinstance(plot, dict) or plot.get("coordinate_space") != PLOT_COORDINATE_SPACE or plot.get("outer_scoring_radius_norm") != PLOT_OUTER_SCORING_RADIUS:
        raise TargetContractError("靶面画布契约无效")
    return contract


def resolve_target_contract(snapshot: dict) -> dict:
    """Resolve current snapshots and only the two exact historical geometries."""
    if not isinstance(snapshot, dict):
        raise TargetContractError("靶面快照无效")
    version = snapshot.get("rules_version")
    if version == RULES_VERSION:
        return _validate_contract(deepcopy(snapshot))
    if version not in (None, LEGACY_RULES_VERSION):
        raise TargetContractError("未知靶面规则版本")
    target_id = snapshot.get("id")
    target_type = snapshot.get("target_type")
    if target_id == SCORE_ONLY_CONTRACT["id"] or target_type == "CUSTOM_SCORE_ONLY":
        contract = deepcopy(SCORE_ONLY_CONTRACT)
    elif target_id in TARGET_CONTRACTS:
        contract = deepcopy(TARGET_CONTRACTS[target_id])
    elif target_type == "WA_10_RING":
        contract = deepcopy(TARGET_CONTRACTS["builtin-wa-10-ring"])
    elif target_type == "WA_VERTICAL_3_SPOT":
        contract = deepcopy(TARGET_CONTRACTS["builtin-wa-vertical-3-spot"])
    else:
        raise TargetContractError("未知靶面快照，不能自动按十环或脱靶解释")
    contract["id"] = snapshot.get("id", contract["id"])
    contract["name"] = snapshot.get("name", contract["name"])
    contract["rules_version"] = LEGACY_RULES_VERSION
    return _validate_contract(contract)


def snapshot_for_target(target) -> dict:
    stored = {
        "id": target.id, "name": target.name, "target_type": target.target_type,
        "scoring_mode": target.scoring_mode, "face_count": target.face_count,
        "allowed_score_codes": deepcopy(target.allowed_score_codes), "ring_rules": deepcopy(target.ring_rules),
    }
    if target.id == SCORE_ONLY_CONTRACT["id"]:
        return deepcopy(SCORE_ONLY_CONTRACT)
    if target.id in TARGET_CONTRACTS:
        return deepcopy(TARGET_CONTRACTS[target.id])
    return resolve_target_contract(stored)


def target_definition_rows() -> tuple[dict, ...]:
    rows = []
    for contract in [*TARGET_CONTRACTS.values(), SCORE_ONLY_CONTRACT]:
        rows.append({
            "id": contract["id"], "name": contract["name"], "target_type": contract["target_type"],
            "scoring_mode": contract["scoring_mode"], "face_count": contract["face_count"],
            "allowed_score_codes": deepcopy(contract["allowed_score_codes"]),
            "ring_rules": deepcopy(contract["ring_rules"]),
            "diameter_cm": contract["nominal_face_diameter_cm"],
        })
    return tuple(rows)

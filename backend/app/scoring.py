from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from math import hypot

from app.target_contracts import PLOT_OUTER_SCORING_RADIUS, resolve_target_contract


class ScoreCode(StrEnum):
    X = "X"
    TEN = "10"
    NINE = "9"
    EIGHT = "8"
    SEVEN = "7"
    SIX = "6"
    FIVE = "5"
    FOUR = "4"
    THREE = "3"
    TWO = "2"
    ONE = "1"
    M = "M"


def score_value(score_code: ScoreCode) -> int:
    if score_code in (ScoreCode.X, ScoreCode.TEN):
        return 10
    if score_code is ScoreCode.M:
        return 0
    return int(score_code)


@dataclass(frozen=True)
class ScoreSummary:
    arrow_count: int
    hit_count: int
    total_score: int
    average_score: float | None
    hit_rate: float | None
    x_count: int
    ten_count: int


def summarize_scores(score_codes: Iterable[ScoreCode]) -> ScoreSummary:
    scores = tuple(score_codes)
    arrow_count = len(scores)
    total_score = sum(score_value(code) for code in scores)
    hit_count = sum(code is not ScoreCode.M for code in scores)
    return ScoreSummary(
        arrow_count=arrow_count,
        hit_count=hit_count,
        total_score=total_score,
        average_score=total_score / arrow_count if arrow_count else None,
        hit_rate=hit_count / arrow_count if arrow_count else None,
        x_count=scores.count(ScoreCode.X),
        ten_count=scores.count(ScoreCode.TEN),
    )


def _contract(target: dict | str) -> dict:
    if isinstance(target, dict):
        return resolve_target_contract(target)
    return resolve_target_contract({"target_type": target})


def score_from_target_coordinate(target: dict | str, x_norm: float, y_norm: float) -> ScoreCode:
    """Return the score for a normalized point; every ring boundary scores higher."""
    radius = hypot(x_norm - 0.5, y_norm - 0.5)
    contract = _contract(target)
    if contract["scoring_mode"] != "RING_GEOMETRY":
        raise ValueError("该靶面不支持点击录入")
    for ring in contract["ring_rules"]:
        limit, score_code = ring["outer_radius_norm"], ScoreCode(ring["score_code"])
        if radius <= limit + 1e-12:
            return score_code
    return ScoreCode.M


# 白色缓冲区占画布的比例：靶面半径占画布宽度的 5/12，白边占 1/12。
BUFFER_RATIO = 1 / 12
TARGET_RADIUS_RATIO = PLOT_OUTER_SCORING_RADIUS


def plot_to_target(plot_x: float, plot_y: float, target: dict | str | None = None) -> tuple[float, float] | None:
    """将含白边画布坐标(0..1)转换为靶面坐标(0..1)。

    如果点落在白区（靶面外），返回 None。
    """
    dx = plot_x - 0.5
    dy = plot_y - 0.5
    dist = hypot(dx, dy)
    radius = _contract(target)["plot"]["outer_scoring_radius_norm"] if target is not None else TARGET_RADIUS_RATIO
    if dist > radius + 1e-12:
        return None
    # 映射到靶面 0..1 坐标
    target_x = 0.5 + dx / radius * 0.5
    target_y = 0.5 + dy / radius * 0.5
    return target_x, target_y


def score_from_plot_coordinate(target: dict | str, plot_x: float, plot_y: float) -> tuple[ScoreCode, tuple[float, float] | None]:
    """从含白边画布坐标计分。

    返回 (score_code, target_xy_or_none)：
    - 点在靶内：返回 (对应环数, 靶面坐标)
    - 点在白区：返回 (M, None)
    """
    contract = _contract(target)
    if contract["scoring_mode"] != "RING_GEOMETRY":
        raise ValueError("该靶面不支持点击录入")
    target_coords = plot_to_target(plot_x, plot_y, contract)
    if target_coords is None:
        return ScoreCode.M, None
    tx, ty = target_coords
    return score_from_target_coordinate(contract, tx, ty), (tx, ty)

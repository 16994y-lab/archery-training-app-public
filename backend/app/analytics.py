"""Pure, evidence-bounded review analytics.

The functions in this module only describe confirmed arrow facts supplied by a
caller.  They do not read a database, infer shot order, or diagnose fatigue,
technique, equipment, or health.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite, sqrt
from typing import Iterable, Literal

from app.scoring import ScoreCode, score_value


ARROW_SEQUENCE_SEMANTICS = "RECORD_ENTRY_ORDER"
"""Manual arrow sequence is entry/display order, not the order arrows were shot."""

SHOT_SEQUENCE_AVAILABLE = False


@dataclass(frozen=True)
class RatioV1:
    numerator: int
    denominator: int
    value: float | None

    def __post_init__(self) -> None:
        if self.numerator < 0 or self.denominator < 0 or self.numerator > self.denominator:
            raise ValueError("比例分子分母无效")
        expected = self.numerator / self.denominator if self.denominator else None
        if self.value != expected:
            raise ValueError("比例值与分子分母不一致")


def _ratio(numerator: int, denominator: int) -> RatioV1:
    return RatioV1(
        numerator=numerator,
        denominator=denominator,
        value=numerator / denominator if denominator else None,
    )


@dataclass(frozen=True)
class ScoreFactsV1:
    arrow_count: int
    hit_count: int
    total_score: int
    average_score: float | None
    counts: dict[str, int]
    rates: dict[str, RatioV1]


@dataclass(frozen=True)
class ArrowFactV1:
    score_code: ScoreCode | str
    record_sequence: int | None = None
    x_norm: float | None = None
    y_norm: float | None = None
    plot_x_norm: float | None = None
    plot_y_norm: float | None = None
    target_face_index: int | None = None


@dataclass(frozen=True)
class EndFactV1:
    sequence: int
    arrows: tuple[ArrowFactV1, ...]


@dataclass(frozen=True)
class CoordinateGroupV1:
    target_face_index: int | None
    point_count: int
    center_x_norm: float | None
    center_y_norm: float | None
    offset_right_norm: float | None
    offset_up_norm: float | None
    radial_offset_norm: float | None
    radial_rms_norm: float | None


@dataclass(frozen=True)
class CoordinateFactsV1:
    total_arrow_count: int
    target_coordinate_count: int
    target_coordinate_coverage: RatioV1
    directional_coordinate_count: int
    directional_coordinate_coverage: RatioV1
    white_m_direction_count: int
    overall: CoordinateGroupV1
    by_target_face: tuple[CoordinateGroupV1, ...]


@dataclass(frozen=True)
class PhaseDefinitionV1:
    key: str
    end_sequences: tuple[int, ...]


@dataclass(frozen=True)
class PhaseFactsV1:
    key: str
    end_sequences: tuple[int, ...]
    score: ScoreFactsV1
    coordinates: CoordinateFactsV1


@dataclass(frozen=True)
class HalfDeltaV1:
    average_score: float | None
    x_rate_points: float | None
    ten_only_rate_points: float | None
    x_or_ten_rate_points: float | None
    nine_or_better_rate_points: float | None
    miss_rate_points: float | None
    hit_rate_points: float | None
    center_right_norm: float | None
    center_up_norm: float | None
    radial_rms_norm: float | None


@dataclass(frozen=True)
class HalfComparisonV1:
    basis: Literal["EXPLICIT_PHASES", "LEGACY_END_SPLIT"]
    first: PhaseFactsV1
    second: PhaseFactsV1
    delta_second_minus_first: HalfDeltaV1


@dataclass(frozen=True)
class ReviewFactsV1:
    arrow_sequence_semantics: Literal["RECORD_ENTRY_ORDER"]
    shot_sequence_available: Literal[False]
    score: ScoreFactsV1
    coordinates: CoordinateFactsV1
    half_comparison: HalfComparisonV1


def _score_codes(arrows: Iterable[ArrowFactV1]) -> tuple[ScoreCode, ...]:
    try:
        return tuple(ScoreCode(arrow.score_code) for arrow in arrows)
    except (TypeError, ValueError) as error:
        raise ValueError("存在无效成绩代码") from error


def analyze_scores(arrows: Iterable[ArrowFactV1]) -> ScoreFactsV1:
    """Calculate score facts with every rate denominator including misses."""

    items = tuple(arrows)
    codes = _score_codes(items)
    counts = {code.value: codes.count(code) for code in ScoreCode}
    arrow_count = len(codes)
    hit_count = arrow_count - counts[ScoreCode.M.value]
    total_score = sum(score_value(code) for code in codes)
    x_count = counts[ScoreCode.X.value]
    ten_count = counts[ScoreCode.TEN.value]
    nine_count = counts[ScoreCode.NINE.value]
    miss_count = counts[ScoreCode.M.value]
    return ScoreFactsV1(
        arrow_count=arrow_count,
        hit_count=hit_count,
        total_score=total_score,
        average_score=total_score / arrow_count if arrow_count else None,
        counts=counts,
        rates={
            "x": _ratio(x_count, arrow_count),
            "ten_only": _ratio(ten_count, arrow_count),
            "x_or_ten": _ratio(x_count + ten_count, arrow_count),
            "nine_or_better": _ratio(x_count + ten_count + nine_count, arrow_count),
            "miss": _ratio(miss_count, arrow_count),
            "hit": _ratio(hit_count, arrow_count),
        },
    )


def _coordinate(value: float | None, label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{label} 必须是 0–1 内的有限数值")
    return float(value)


def _coordinate_pairs(arrow: ArrowFactV1) -> tuple[tuple[float, float] | None, tuple[float, float] | None]:
    x = _coordinate(arrow.x_norm, "x_norm")
    y = _coordinate(arrow.y_norm, "y_norm")
    plot_x = _coordinate(arrow.plot_x_norm, "plot_x_norm")
    plot_y = _coordinate(arrow.plot_y_norm, "plot_y_norm")
    if (x is None) != (y is None):
        raise ValueError("靶内坐标必须成对存在")
    if (plot_x is None) != (plot_y is None):
        raise ValueError("方向坐标必须成对存在")
    code = ScoreCode(arrow.score_code)
    if code is ScoreCode.M and x is not None:
        raise ValueError("M 不能作为靶内坐标参与箭群分析")
    return ((x, y) if x is not None else None, (plot_x, plot_y) if plot_x is not None else None)


def _coordinate_group(points: tuple[tuple[float, float], ...], face: int | None) -> CoordinateGroupV1:
    if not points:
        return CoordinateGroupV1(face, 0, None, None, None, None, None, None)
    center_x = sum(point[0] for point in points) / len(points)
    center_y = sum(point[1] for point in points) / len(points)
    offset_right = center_x - 0.5
    offset_up = 0.5 - center_y
    radial_rms = None
    if len(points) >= 2:
        radial_rms = sqrt(
            sum((x - center_x) ** 2 + (y - center_y) ** 2 for x, y in points) / len(points)
        )
    return CoordinateGroupV1(
        target_face_index=face,
        point_count=len(points),
        center_x_norm=center_x,
        center_y_norm=center_y,
        offset_right_norm=offset_right,
        offset_up_norm=offset_up,
        radial_offset_norm=hypot(offset_right, offset_up),
        radial_rms_norm=radial_rms,
    )


def analyze_coordinates(arrows: Iterable[ArrowFactV1]) -> CoordinateFactsV1:
    """Describe recorded positions without inventing coordinates for number entry."""

    items = tuple(arrows)
    target_points: list[tuple[float, float, int | None]] = []
    directional_count = 0
    white_m_direction_count = 0
    for arrow in items:
        try:
            target_pair, plot_pair = _coordinate_pairs(arrow)
        except (TypeError, ValueError) as error:
            if isinstance(error, ValueError) and str(error).startswith(("x_norm", "y_norm", "plot_x_norm", "plot_y_norm", "靶内坐标", "方向坐标", "M ")):
                raise
            raise ValueError("存在无效成绩代码") from error
        if target_pair is not None:
            face = arrow.target_face_index
            if face is not None and (isinstance(face, bool) or not isinstance(face, int) or face < 1):
                raise ValueError("靶面序号必须是正整数")
            target_points.append((target_pair[0], target_pair[1], face))
        if plot_pair is not None:
            directional_count += 1
            if ScoreCode(arrow.score_code) is ScoreCode.M and target_pair is None:
                white_m_direction_count += 1

    grouped: dict[int | None, list[tuple[float, float]]] = {}
    for x, y, face in target_points:
        grouped.setdefault(face, []).append((x, y))
    face_order = sorted(grouped, key=lambda face: (face is None, face if face is not None else 0))
    total = len(items)
    target_count = len(target_points)
    return CoordinateFactsV1(
        total_arrow_count=total,
        target_coordinate_count=target_count,
        target_coordinate_coverage=_ratio(target_count, total),
        directional_coordinate_count=directional_count,
        directional_coordinate_coverage=_ratio(directional_count, total),
        white_m_direction_count=white_m_direction_count,
        overall=_coordinate_group(tuple((x, y) for x, y, _face in target_points), None),
        by_target_face=tuple(_coordinate_group(tuple(grouped[face]), face) for face in face_order),
    )


def _phase(key: str, sequences: tuple[int, ...], by_sequence: dict[int, EndFactV1]) -> PhaseFactsV1:
    arrows = tuple(arrow for sequence in sequences for arrow in by_sequence[sequence].arrows)
    return PhaseFactsV1(
        key=key,
        end_sequences=sequences,
        score=analyze_scores(arrows),
        coordinates=analyze_coordinates(arrows),
    )


def _difference(second: float | None, first: float | None, scale: float = 1.0) -> float | None:
    if first is None or second is None:
        return None
    result = (second - first) * scale
    if not isfinite(result):
        raise ValueError("分析差值必须是有限数值")
    return result


def _delta(first: PhaseFactsV1, second: PhaseFactsV1) -> HalfDeltaV1:
    first_rates, second_rates = first.score.rates, second.score.rates
    return HalfDeltaV1(
        average_score=_difference(second.score.average_score, first.score.average_score),
        x_rate_points=_difference(second_rates["x"].value, first_rates["x"].value, 100),
        ten_only_rate_points=_difference(second_rates["ten_only"].value, first_rates["ten_only"].value, 100),
        x_or_ten_rate_points=_difference(second_rates["x_or_ten"].value, first_rates["x_or_ten"].value, 100),
        nine_or_better_rate_points=_difference(second_rates["nine_or_better"].value, first_rates["nine_or_better"].value, 100),
        miss_rate_points=_difference(second_rates["miss"].value, first_rates["miss"].value, 100),
        hit_rate_points=_difference(second_rates["hit"].value, first_rates["hit"].value, 100),
        center_right_norm=_difference(
            second.coordinates.overall.offset_right_norm,
            first.coordinates.overall.offset_right_norm,
        ),
        center_up_norm=_difference(
            second.coordinates.overall.offset_up_norm,
            first.coordinates.overall.offset_up_norm,
        ),
        radial_rms_norm=_difference(
            second.coordinates.overall.radial_rms_norm,
            first.coordinates.overall.radial_rms_norm,
        ),
    )


def analyze_halves(
    ends: Iterable[EndFactV1],
    explicit_phases: tuple[PhaseDefinitionV1, PhaseDefinitionV1] | None = None,
) -> HalfComparisonV1:
    """Compare two explicit phases, or apply the documented legacy end split."""

    items = tuple(sorted(ends, key=lambda end: end.sequence))
    sequences = tuple(end.sequence for end in items)
    if any(isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1 for sequence in sequences):
        raise ValueError("组序号必须是正整数")
    if len(set(sequences)) != len(sequences):
        raise ValueError("组序号不能重复")
    by_sequence = {end.sequence: end for end in items}

    if explicit_phases is not None:
        first_definition, second_definition = explicit_phases
        first_sequences = first_definition.end_sequences
        second_sequences = second_definition.end_sequences
        if not first_sequences or not second_sequences:
            raise ValueError("显式上下半场均必须包含至少一组")
        if len(set(first_sequences)) != len(first_sequences) or len(set(second_sequences)) != len(second_sequences):
            raise ValueError("显式阶段内组序号不能重复")
        if set(first_sequences) & set(second_sequences):
            raise ValueError("显式上下半场不能重叠")
        if set(first_sequences) | set(second_sequences) != set(sequences):
            raise ValueError("显式上下半场必须完整覆盖现有组")
        first = _phase(first_definition.key, first_sequences, by_sequence)
        second = _phase(second_definition.key, second_sequences, by_sequence)
        basis: Literal["EXPLICIT_PHASES", "LEGACY_END_SPLIT"] = "EXPLICIT_PHASES"
    else:
        split = (len(sequences) + 1) // 2
        first = _phase("FIRST", sequences[:split], by_sequence)
        second = _phase("SECOND", sequences[split:], by_sequence)
        basis = "LEGACY_END_SPLIT"

    return HalfComparisonV1(
        basis=basis,
        first=first,
        second=second,
        delta_second_minus_first=_delta(first, second),
    )


def analyze_review(
    ends: Iterable[EndFactV1],
    explicit_phases: tuple[PhaseDefinitionV1, PhaseDefinitionV1] | None = None,
) -> ReviewFactsV1:
    """Return score, coordinate, and half-comparison facts only."""

    items = tuple(ends)
    arrows = tuple(arrow for end in items for arrow in end.arrows)
    return ReviewFactsV1(
        arrow_sequence_semantics=ARROW_SEQUENCE_SEMANTICS,
        shot_sequence_available=SHOT_SEQUENCE_AVAILABLE,
        score=analyze_scores(arrows),
        coordinates=analyze_coordinates(arrows),
        half_comparison=analyze_halves(items, explicit_phases),
    )

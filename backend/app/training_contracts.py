"""Pure contracts for training structure, equipment snapshots, and timing.

This module deliberately has no database or HTTP dependencies.  It can be
developed and verified while the persistence and UI integration work remains
isolated in other tasks.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
import hashlib
import json
import math
import re
from typing import TypeAlias


SESSION_STRUCTURE_VERSION = "session-structure/v1"
EQUIPMENT_SNAPSHOT_VERSION = "equipment-snapshot/v1"


class ContractError(ValueError):
    """Raised when a value cannot safely enter a public training contract."""


class PhaseKind(StrEnum):
    SCORING = "SCORING"
    BREAK = "BREAK"


class StructureDerivation(StrEnum):
    EXPLICIT = "EXPLICIT"
    LEGACY_SINGLE_PHASE = "LEGACY_SINGLE_PHASE"


_PHASE_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _clean_text(value: object, *, label: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{label}必须是字符串")
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ContractError(f"{label}不能为空")
    if len(cleaned) > limit:
        raise ContractError(f"{label}最多 {limit} 个字符")
    return cleaned


def _positive_int(value: object, *, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ContractError(f"{label}必须为 1–{maximum} 的整数")
    return value


@dataclass(frozen=True, slots=True)
class SessionPhaseV1:
    key: str
    order: int
    kind: PhaseKind
    title: str
    first_end_sequence: int | None = None
    end_count: int | None = None
    arrows_per_end: int | None = None
    planned_duration_minutes: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.key, str) or not _PHASE_KEY.fullmatch(self.key):
            raise ContractError("phase key 只能使用小写字母、数字、下划线或连字符")
        _positive_int(self.order, label="phase order", maximum=100)
        _clean_text(self.title, label="phase title", limit=80)
        if not isinstance(self.kind, PhaseKind):
            raise ContractError("phase kind 必须是 SCORING 或 BREAK")

        scoring_values = (self.first_end_sequence, self.end_count, self.arrows_per_end)
        if self.kind is PhaseKind.SCORING:
            if any(value is None for value in scoring_values):
                raise ContractError("计分阶段必须完整指定起始组、组数和每组箭数")
            _positive_int(self.first_end_sequence, label="起始组", maximum=200)
            _positive_int(self.end_count, label="组数", maximum=200)
            _positive_int(self.arrows_per_end, label="每组箭数", maximum=12)
            if self.planned_duration_minutes is not None:
                raise ContractError("计分阶段不能混入休息时长")
            return

        if any(value is not None for value in scoring_values):
            raise ContractError("休息阶段不能占用计分组或箭数")
        _positive_int(self.planned_duration_minutes, label="休息时长", maximum=300)

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> SessionPhaseV1:
        try:
            kind = PhaseKind(value.get("kind"))
        except (TypeError, ValueError) as error:
            raise ContractError("phase kind 必须是 SCORING 或 BREAK") from error
        return cls(
            key=value.get("key"),  # type: ignore[arg-type]
            order=value.get("order"),  # type: ignore[arg-type]
            kind=kind,
            title=value.get("title"),  # type: ignore[arg-type]
            first_end_sequence=value.get("first_end_sequence"),  # type: ignore[arg-type]
            end_count=value.get("end_count"),  # type: ignore[arg-type]
            arrows_per_end=value.get("arrows_per_end"),  # type: ignore[arg-type]
            planned_duration_minutes=value.get("planned_duration_minutes"),  # type: ignore[arg-type]
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "order": self.order,
            "kind": self.kind.value,
            "title": self.title,
            "first_end_sequence": self.first_end_sequence,
            "end_count": self.end_count,
            "arrows_per_end": self.arrows_per_end,
            "planned_duration_minutes": self.planned_duration_minutes,
        }


@dataclass(frozen=True, slots=True)
class SessionStructureV1:
    phases: tuple[SessionPhaseV1, ...]
    derivation: StructureDerivation = StructureDerivation.EXPLICIT
    version: str = SESSION_STRUCTURE_VERSION

    def __post_init__(self) -> None:
        if self.version != SESSION_STRUCTURE_VERSION:
            raise ContractError(f"未知训练结构版本：{self.version}")
        if not isinstance(self.derivation, StructureDerivation):
            raise ContractError("训练结构必须明确标记来源")
        if not self.phases:
            raise ContractError("训练结构至少需要一个阶段")
        if [phase.order for phase in self.phases] != list(range(1, len(self.phases) + 1)):
            raise ContractError("训练阶段 order 必须从 1 开始连续排列")
        if len({phase.key for phase in self.phases}) != len(self.phases):
            raise ContractError("训练阶段 key 不能重复")

        next_end_sequence = 1
        scoring_count = 0
        for phase in self.phases:
            if phase.kind is not PhaseKind.SCORING:
                continue
            if phase.first_end_sequence != next_end_sequence:
                raise ContractError("计分阶段的组序号必须从 1 开始连续且不得重叠")
            next_end_sequence += phase.end_count or 0
            scoring_count += 1
        if scoring_count == 0:
            raise ContractError("训练结构至少需要一个计分阶段")
        if self.derivation is StructureDerivation.LEGACY_SINGLE_PHASE:
            if len(self.phases) != 1 or self.phases[0].kind is not PhaseKind.SCORING:
                raise ContractError("旧数据兼容结构必须显式为单一计分阶段")

    @property
    def planned_end_count(self) -> int:
        return sum(phase.end_count or 0 for phase in self.phases if phase.kind is PhaseKind.SCORING)

    @property
    def planned_arrow_count(self) -> int:
        return sum(
            (phase.end_count or 0) * (phase.arrows_per_end or 0)
            for phase in self.phases
            if phase.kind is PhaseKind.SCORING
        )

    @property
    def is_legacy_derived(self) -> bool:
        return self.derivation is StructureDerivation.LEGACY_SINGLE_PHASE

    def phase_for_end(self, end_sequence: int) -> SessionPhaseV1:
        _positive_int(end_sequence, label="组序号", maximum=200)
        for phase in self.phases:
            if phase.kind is not PhaseKind.SCORING:
                continue
            start = phase.first_end_sequence or 0
            if start <= end_sequence < start + (phase.end_count or 0):
                return phase
        raise ContractError("组序号超出训练结构范围")

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> SessionStructureV1:
        raw_phases = value.get("phases")
        if not isinstance(raw_phases, Sequence) or isinstance(raw_phases, (str, bytes)):
            raise ContractError("训练结构 phases 必须是数组")
        if any(not isinstance(item, Mapping) for item in raw_phases):
            raise ContractError("训练结构的每个 phase 都必须是对象")
        try:
            derivation = StructureDerivation(value.get("derivation"))
        except (TypeError, ValueError) as error:
            raise ContractError("训练结构必须明确标记来源") from error
        return cls(
            phases=tuple(SessionPhaseV1.from_mapping(item) for item in raw_phases),  # type: ignore[arg-type]
            derivation=derivation,
            version=value.get("version"),  # type: ignore[arg-type]
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "derivation": self.derivation.value,
            "phases": [phase.as_dict() for phase in self.phases],
        }


def competition_12x6_structure(*, break_minutes: int = 10) -> SessionStructureV1:
    """Return the confirmed 72-arrow, two-half competition training structure."""

    return SessionStructureV1(
        phases=(
            SessionPhaseV1("first-half", 1, PhaseKind.SCORING, "上半场", 1, 6, 6),
            SessionPhaseV1(
                "mid-break",
                2,
                PhaseKind.BREAK,
                "中场休息",
                planned_duration_minutes=break_minutes,
            ),
            SessionPhaseV1("second-half", 3, PhaseKind.SCORING, "下半场", 7, 6, 6),
        )
    )


def legacy_single_phase_structure(end_count: int, arrows_per_end: int) -> SessionStructureV1:
    """Make legacy fallback visible; it must never masquerade as an explicit plan."""

    return SessionStructureV1(
        phases=(
            SessionPhaseV1(
                "legacy-all",
                1,
                PhaseKind.SCORING,
                "旧记录：全场",
                1,
                end_count,
                arrows_per_end,
            ),
        ),
        derivation=StructureDerivation.LEGACY_SINGLE_PHASE,
    )


_BOW_TYPES = {"RECURVE", "COMPOUND", "BAREBOW", "TRADITIONAL", "CUSTOM"}
_TEXT_EQUIPMENT_FIELDS = {
    "riser",
    "limbs",
    "string",
    "sight",
    "stabilizer",
    "plunger",
    "arrow_rest",
    "arrow_shaft",
    "arrow_spine",
    "fletching",
    "nock",
    "release_aid",
}
_NUMBER_EQUIPMENT_FIELDS = {
    "draw_weight_lbs",
    "bow_length_inches",
    "arrow_length_inches",
    "point_weight_grains",
    "brace_height_mm",
    "tiller_top_mm",
    "tiller_bottom_mm",
}
_ALLOWED_EQUIPMENT_FIELDS = _TEXT_EQUIPMENT_FIELDS | _NUMBER_EQUIPMENT_FIELDS
EquipmentValue: TypeAlias = str | float


def normalize_equipment_components(components: Mapping[str, object]) -> tuple[tuple[str, EquipmentValue], ...]:
    if not isinstance(components, Mapping):
        raise ContractError("器材 components 必须是对象")
    unknown = sorted(set(components) - _ALLOWED_EQUIPMENT_FIELDS)
    if unknown:
        raise ContractError(f"器材字段不在非敏感白名单中：{', '.join(unknown)}")

    normalized: dict[str, EquipmentValue] = {}
    for key, value in components.items():
        if value is None or value == "":
            continue
        if key in _TEXT_EQUIPMENT_FIELDS:
            normalized[key] = _clean_text(value, label=key, limit=120)
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ContractError(f"{key} 必须是有限数字")
        numeric = float(value)
        if not 0 < numeric <= 5000:
            raise ContractError(f"{key} 必须大于 0 且不超过 5000")
        normalized[key] = numeric
    return tuple(sorted(normalized.items()))


@dataclass(frozen=True, slots=True)
class EquipmentSnapshotV1:
    profile_id: str | None
    profile_revision: int | None
    name: str
    bow_type: str
    components: tuple[tuple[str, EquipmentValue], ...]
    version: str = EQUIPMENT_SNAPSHOT_VERSION

    def __post_init__(self) -> None:
        if self.version != EQUIPMENT_SNAPSHOT_VERSION:
            raise ContractError(f"未知器材快照版本：{self.version}")
        _clean_text(self.name, label="器材配置名称", limit=80)
        if self.bow_type not in _BOW_TYPES:
            raise ContractError("请选择有效的弓种")
        if (self.profile_id is None) != (self.profile_revision is None):
            raise ContractError("器材 profile_id 与 profile_revision 必须同时存在或同时为空")
        if self.profile_id is not None:
            _clean_text(self.profile_id, label="器材配置标识", limit=64)
            _positive_int(self.profile_revision, label="器材配置修订号", maximum=2_147_483_647)
        if len(dict(self.components)) != len(self.components):
            raise ContractError("器材 components 不能包含重复字段")
        normalized = normalize_equipment_components(dict(self.components))
        if normalized != self.components:
            raise ContractError("器材 components 必须经过稳定规范化")

    @classmethod
    def create(
        cls,
        *,
        name: str,
        bow_type: str,
        components: Mapping[str, object],
        profile_id: str | None = None,
        profile_revision: int | None = None,
    ) -> EquipmentSnapshotV1:
        return cls(
            profile_id=profile_id,
            profile_revision=profile_revision,
            name=_clean_text(name, label="器材配置名称", limit=80),
            bow_type=bow_type,
            components=normalize_equipment_components(components),
        )

    @property
    def fingerprint(self) -> str:
        comparable = {
            "version": self.version,
            "bow_type": self.bow_type,
            "components": dict(self.components),
        }
        canonical = json.dumps(comparable, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
        return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"

    def as_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "profile_id": self.profile_id,
            "profile_revision": self.profile_revision,
            "name": self.name,
            "bow_type": self.bow_type,
            "components": dict(self.components),
            "fingerprint": self.fingerprint,
        }


MANUAL_RECORDED_SOURCES = frozenset({"MANUAL_NUMBER", "MANUAL_TARGET", "VISION_CONFIRMED"})
SHOT_SEQUENCE_SOURCES = frozenset({"VIDEO_CONFIRMED", "DEVICE_CONFIRMED"})


@dataclass(frozen=True, slots=True)
class ArrowSequenceV1:
    entry_sequence: int
    source: str
    shot_sequence: int | None = None
    shot_sequence_source: str | None = None

    def __post_init__(self) -> None:
        _positive_int(self.entry_sequence, label="录入序号", maximum=12)
        if self.source in MANUAL_RECORDED_SOURCES:
            if self.shot_sequence is not None or self.shot_sequence_source is not None:
                raise ContractError("手动或照片人工确认录入不能声称真实出箭顺序")
            return
        if (self.shot_sequence is None) != (self.shot_sequence_source is None):
            raise ContractError("真实出箭序号与来源必须同时存在或同时为空")
        if self.shot_sequence is not None:
            _positive_int(self.shot_sequence, label="真实出箭序号", maximum=12)
            if self.shot_sequence_source not in SHOT_SEQUENCE_SOURCES:
                raise ContractError("真实出箭顺序必须来自已确认的视频或设备记录")


def validate_group_sequences(arrows: Sequence[ArrowSequenceV1]) -> tuple[ArrowSequenceV1, ...]:
    ordered = tuple(sorted(arrows, key=lambda arrow: arrow.entry_sequence))
    if [arrow.entry_sequence for arrow in ordered] != list(range(1, len(ordered) + 1)):
        raise ContractError("录入序号必须从 1 开始连续且不能重复")
    shot_sequences = [arrow.shot_sequence for arrow in ordered if arrow.shot_sequence is not None]
    if len(set(shot_sequences)) != len(shot_sequences):
        raise ContractError("同一组内真实出箭序号不能重复")
    return ordered


_UTC_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")


def parse_entered_at_utc(value: object) -> datetime:
    """Parse a client entry instant; offsets and timezone-less values are rejected."""

    if not isinstance(value, str) or not _UTC_INSTANT.fullmatch(value):
        raise ContractError("entered_at_utc 必须是以 Z 结尾的 ISO 8601 UTC 时间")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ContractError("entered_at_utc 不是有效时间") from error
    if parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ContractError("entered_at_utc 必须使用 UTC")
    return parsed


class EntryTimingQuality(StrEnum):
    COMPLETE = "APPROXIMATE_CLIENT_ENTRY"
    PARTIAL = "PARTIAL_CLIENT_ENTRY"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class EntryTimingEvidenceV1:
    quality: EntryTimingQuality
    record_count: int
    timestamped_count: int
    first_entered_at_utc: str | None
    last_entered_at_utc: str | None
    basis: str | None
    approximate: bool
    represents_shot_time: bool = False

    def __post_init__(self) -> None:
        if isinstance(self.record_count, bool) or not isinstance(self.record_count, int) or self.record_count < 0:
            raise ContractError("record_count 必须是非负整数")
        if isinstance(self.timestamped_count, bool) or not isinstance(self.timestamped_count, int) or not 0 <= self.timestamped_count <= self.record_count:
            raise ContractError("timestamped_count 超出记录数量")
        has_complete_range = self.first_entered_at_utc is not None and self.last_entered_at_utc is not None
        has_any_range = self.first_entered_at_utc is not None or self.last_entered_at_utc is not None
        if self.timestamped_count == 0:
            if self.quality is not EntryTimingQuality.UNAVAILABLE or has_any_range or self.basis is not None or self.approximate:
                raise ContractError("无时间证据时必须明确标为 UNAVAILABLE")
        else:
            if not has_complete_range or self.basis != "ENTRY_ACTIVITY" or not self.approximate:
                raise ContractError("录入时间只能作为 ENTRY_ACTIVITY 的近似证据")
            first = parse_entered_at_utc(self.first_entered_at_utc)
            last = parse_entered_at_utc(self.last_entered_at_utc)
            if first > last:
                raise ContractError("首个录入时间不能晚于最后录入时间")
            expected = EntryTimingQuality.COMPLETE if self.timestamped_count == self.record_count else EntryTimingQuality.PARTIAL
            if self.quality is not expected:
                raise ContractError("录入时间质量与覆盖数量不一致")
        if self.represents_shot_time:
            raise ContractError("录入活动时间不能标记为真实射箭时间")

    def as_dict(self) -> dict[str, object]:
        return {
            "quality": self.quality.value,
            "record_count": self.record_count,
            "timestamped_count": self.timestamped_count,
            "first_entered_at_utc": self.first_entered_at_utc,
            "last_entered_at_utc": self.last_entered_at_utc,
            "basis": self.basis,
            "approximate": self.approximate,
            "represents_shot_time": self.represents_shot_time,
        }


def entry_timing_evidence(values: Iterable[str | None]) -> EntryTimingEvidenceV1:
    recorded = tuple(values)
    parsed = [(parse_entered_at_utc(value), value) for value in recorded if value is not None]
    if not parsed:
        return EntryTimingEvidenceV1(
            quality=EntryTimingQuality.UNAVAILABLE,
            record_count=len(recorded),
            timestamped_count=0,
            first_entered_at_utc=None,
            last_entered_at_utc=None,
            basis=None,
            approximate=False,
        )
    parsed.sort(key=lambda item: item[0])
    timestamped_count = len(parsed)
    return EntryTimingEvidenceV1(
        quality=EntryTimingQuality.COMPLETE if timestamped_count == len(recorded) else EntryTimingQuality.PARTIAL,
        record_count=len(recorded),
        timestamped_count=timestamped_count,
        first_entered_at_utc=parsed[0][1],
        last_entered_at_utc=parsed[-1][1],
        basis="ENTRY_ACTIVITY",
        approximate=True,
    )

import pytest

from app.training_contracts import (
    ArrowSequenceV1,
    ContractError,
    EntryTimingQuality,
    EquipmentSnapshotV1,
    PhaseKind,
    SessionPhaseV1,
    SessionStructureV1,
    StructureDerivation,
    competition_12x6_structure,
    entry_timing_evidence,
    legacy_single_phase_structure,
    parse_entered_at_utc,
    validate_group_sequences,
)


def test_formal_12x6_has_two_halves_one_break_and_72_arrows() -> None:
    structure = competition_12x6_structure()

    assert structure.version == "session-structure/v1"
    assert structure.derivation is StructureDerivation.EXPLICIT
    assert structure.planned_end_count == 12
    assert structure.planned_arrow_count == 72
    assert [(phase.kind, phase.title) for phase in structure.phases] == [
        (PhaseKind.SCORING, "上半场"),
        (PhaseKind.BREAK, "中场休息"),
        (PhaseKind.SCORING, "下半场"),
    ]
    assert structure.phases[1].planned_duration_minutes == 10
    assert [structure.phase_for_end(end).key for end in range(1, 7)] == ["first-half"] * 6
    assert [structure.phase_for_end(end).key for end in range(7, 13)] == ["second-half"] * 6
    with pytest.raises(ContractError, match="超出"):
        structure.phase_for_end(13)


def test_structure_rejects_gaps_and_breaks_that_claim_scoring_ends() -> None:
    with pytest.raises(ContractError, match="连续"):
        SessionStructureV1(
            phases=(
                SessionPhaseV1("first", 1, PhaseKind.SCORING, "第一段", 1, 6, 6),
                SessionPhaseV1("second", 2, PhaseKind.SCORING, "第二段", 8, 6, 6),
            )
        )
    with pytest.raises(ContractError, match="不能占用"):
        SessionPhaseV1("bad-break", 1, PhaseKind.BREAK, "休息", 1, planned_duration_minutes=10)


def test_legacy_fallback_is_an_explicitly_marked_single_phase() -> None:
    structure = legacy_single_phase_structure(11, 6)

    assert structure.is_legacy_derived is True
    assert structure.derivation is StructureDerivation.LEGACY_SINGLE_PHASE
    assert len(structure.phases) == 1
    assert structure.as_dict()["derivation"] == "LEGACY_SINGLE_PHASE"
    assert structure.planned_arrow_count == 66


def test_equipment_normalization_and_fingerprint_are_stable() -> None:
    first = EquipmentSnapshotV1.create(
        profile_id="equipment-1",
        profile_revision=3,
        name="  比赛   反曲弓  ",
        bow_type="RECURVE",
        components={"sight": " Shibuya   RC III ", "draw_weight_lbs": 38, "arrow_spine": "500"},
    )
    renamed = EquipmentSnapshotV1.create(
        profile_id="equipment-2",
        profile_revision=9,
        name="另一个显示名",
        bow_type="RECURVE",
        components={"arrow_spine": "500", "draw_weight_lbs": 38.0, "sight": "Shibuya RC III"},
    )

    assert first.name == "比赛 反曲弓"
    assert first.fingerprint == renamed.fingerprint
    assert first.as_dict()["components"] == {
        "arrow_spine": "500",
        "draw_weight_lbs": 38.0,
        "sight": "Shibuya RC III",
    }


def test_equipment_snapshot_rejects_unknown_or_sensitive_fields() -> None:
    with pytest.raises(ContractError, match="白名单"):
        EquipmentSnapshotV1.create(name="弓", bow_type="RECURVE", components={"athlete_name": "某人"})
    with pytest.raises(ContractError, match="白名单"):
        EquipmentSnapshotV1.create(name="弓", bow_type="RECURVE", components={"health_note": "肩痛"})
    with pytest.raises(ContractError, match="有限数字"):
        EquipmentSnapshotV1.create(name="弓", bow_type="RECURVE", components={"draw_weight_lbs": float("nan")})
    with pytest.raises(ContractError, match="稳定规范化"):
        EquipmentSnapshotV1(None, None, "弓", "RECURVE", (("sight", "  未规范  "),))


@pytest.mark.parametrize("source", ["MANUAL_NUMBER", "MANUAL_TARGET", "VISION_CONFIRMED"])
def test_human_recorded_sources_cannot_claim_true_shot_sequence(source: str) -> None:
    ArrowSequenceV1(entry_sequence=1, source=source)
    with pytest.raises(ContractError, match="不能声称真实出箭顺序"):
        ArrowSequenceV1(
            entry_sequence=1,
            source=source,
            shot_sequence=1,
            shot_sequence_source="VIDEO_CONFIRMED",
        )


def test_entry_and_shot_sequences_have_independent_group_rules() -> None:
    arrows = validate_group_sequences(
        [
            ArrowSequenceV1(2, "VIDEO_RESULT", 1, "VIDEO_CONFIRMED"),
            ArrowSequenceV1(1, "VIDEO_RESULT", 2, "VIDEO_CONFIRMED"),
        ]
    )
    assert [arrow.entry_sequence for arrow in arrows] == [1, 2]
    assert [arrow.shot_sequence for arrow in arrows] == [2, 1]

    with pytest.raises(ContractError, match="录入序号必须"):
        validate_group_sequences([ArrowSequenceV1(2, "MANUAL_NUMBER")])
    with pytest.raises(ContractError, match="不能重复"):
        validate_group_sequences(
            [
                ArrowSequenceV1(1, "VIDEO_RESULT", 1, "VIDEO_CONFIRMED"),
                ArrowSequenceV1(2, "VIDEO_RESULT", 1, "VIDEO_CONFIRMED"),
            ]
        )


def test_entered_at_requires_explicit_utc_z_format() -> None:
    parsed = parse_entered_at_utc("2026-09-06T02:03:04.123456Z")
    assert parsed.utcoffset().total_seconds() == 0
    for invalid in ("2026-09-06T02:03:04", "2026-09-06T10:03:04+08:00", "not-a-date"):
        with pytest.raises(ContractError, match="UTC"):
            parse_entered_at_utc(invalid)


def test_entry_timing_reports_complete_partial_and_unavailable_evidence() -> None:
    complete = entry_timing_evidence(["2026-09-06T02:05:00Z", "2026-09-06T02:03:00Z"])
    assert complete.quality is EntryTimingQuality.COMPLETE
    assert complete.first_entered_at_utc == "2026-09-06T02:03:00Z"
    assert complete.last_entered_at_utc == "2026-09-06T02:05:00Z"
    assert complete.approximate is True
    assert complete.represents_shot_time is False

    partial = entry_timing_evidence(["2026-09-06T02:03:00Z", None])
    assert partial.quality is EntryTimingQuality.PARTIAL
    assert partial.timestamped_count == 1

    unavailable = entry_timing_evidence([None, None])
    assert unavailable.quality is EntryTimingQuality.UNAVAILABLE
    assert unavailable.basis is None
    assert unavailable.approximate is False

from app.scoring import ScoreCode, score_value, summarize_scores


def test_x_and_ten_score_equally_but_are_counted_separately() -> None:
    result = summarize_scores([ScoreCode.X, ScoreCode.TEN, ScoreCode.NINE, ScoreCode.M])
    assert score_value(ScoreCode.X) == score_value(ScoreCode.TEN) == 10
    assert result.total_score == 29
    assert result.arrow_count == 4
    assert result.x_count == 1
    assert result.ten_count == 1


def test_miss_is_zero_and_remains_in_all_denominators() -> None:
    result = summarize_scores([ScoreCode.X, ScoreCode.M])
    assert result.total_score == 10
    assert result.average_score == 5
    assert result.hit_count == 1
    assert result.hit_rate == 0.5


def test_empty_scores_have_no_average_or_hit_rate() -> None:
    result = summarize_scores([])
    assert result.arrow_count == 0
    assert result.average_score is None
    assert result.hit_rate is None

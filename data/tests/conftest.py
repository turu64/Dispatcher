from pathlib import Path

import pytest

FIXTURE_RAW = Path(__file__).resolve().parent / "fixtures" / "raw"


@pytest.fixture
def fixture_raw() -> Path:
    """手作りの小さな元データ(data/tests/fixtures/raw/。data/raw/ と同じ並び)。"""
    return FIXTURE_RAW

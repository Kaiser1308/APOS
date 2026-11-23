import pytest

from parking.lot import new_lot, reserve


def test_a_reserved_slot_cannot_be_reserved_again():
    lot = new_lot(["A1", "A2"])
    reserve(lot, "A1")
    assert lot == {"A1": "reserved", "A2": "free"}
    with pytest.raises(ValueError):
        reserve(lot, "A1")

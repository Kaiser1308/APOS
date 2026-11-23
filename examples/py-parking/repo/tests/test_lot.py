import pytest

from parking.lot import new_lot, reserve


def test_a_new_lot_has_only_free_slots():
    assert new_lot(["A1", "A2"]) == {"A1": "free", "A2": "free"}


def test_reserve_holds_a_free_slot():
    lot = new_lot(["A1"])
    reserve(lot, "A1")
    assert lot["A1"] == "reserved"


def test_reserve_refuses_a_slot_that_is_not_free():
    lot = {"A1": "occupied"}
    with pytest.raises(ValueError):
        reserve(lot, "A1")

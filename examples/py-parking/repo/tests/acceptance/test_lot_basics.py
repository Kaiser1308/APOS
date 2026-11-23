from parking.lot import new_lot, reserve


def test_a_lot_starts_free_and_a_slot_can_be_reserved():
    lot = new_lot(["A1"])
    assert lot["A1"] == "free"
    reserve(lot, "A1")
    assert lot["A1"] == "reserved"

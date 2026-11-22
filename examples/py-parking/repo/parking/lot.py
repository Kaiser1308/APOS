"""A lot is a dict from slot id to the slot's state: "free", "reserved" or "occupied"."""


def new_lot(slot_ids):
    return {slot_id: "free" for slot_id in slot_ids}


def reserve(lot, slot_id):
    """Holds a free slot for a booking."""
    if lot[slot_id] != "free":
        raise ValueError(f"slot {slot_id} is {lot[slot_id]}: it cannot be reserved")
    lot[slot_id] = "reserved"

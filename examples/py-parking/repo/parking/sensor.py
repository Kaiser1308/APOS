def on_sensor(lot, slot_id, detected):
    """One reading of the sensor above a slot. Today only "no car" is handled: an occupied slot is freed.
    A slot held for a booking stays reserved when the sensor sees nothing."""
    if not detected and lot[slot_id] == "occupied":
        lot[slot_id] = "free"

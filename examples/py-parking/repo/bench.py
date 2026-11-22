"""Benchmark for the close stage: how long, at the 95th percentile, 1000 sensor readings take.
Usage: python bench.py <report.json>"""

import json
import sys
import time

from parking.sensor import on_sensor

slot_ids = [f"S-{i}" for i in range(1000)]
samples = []
for _ in range(50):
    lot = {slot_id: "reserved" if i % 3 == 0 else "free" for i, slot_id in enumerate(slot_ids)}
    started = time.perf_counter()
    for i, slot_id in enumerate(slot_ids):
        on_sensor(lot, slot_id, i % 2 == 0)
    samples.append((time.perf_counter() - started) * 1000)
samples.sort()
p95 = samples[int(len(samples) * 0.95) - 1]
with open(sys.argv[1], "w") as report:
    json.dump({"p95_ms": round(p95, 3)}, report)

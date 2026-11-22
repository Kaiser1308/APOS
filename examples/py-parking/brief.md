# Sensor says there is a car

Every slot has a sensor that reports, once a second, whether a car is on the slot. Today the
lot only reacts when the sensor stops seeing a car: the slot goes back to free. It never
learns that a car arrived, so the dashboard shows an occupied slot as free until someone
fixes it by hand.

When the sensor reports a car, the slot becomes occupied. This holds for a free slot, and for
a slot that was reserved for a booking: the booking has arrived and the reservation is used.

A slot that is reserved and whose sensor sees nothing must stay reserved. That is how it works
today and it must keep working: the guest has not arrived yet.

Readings arrive in bursts from the whole lot; handling them must stay fast.

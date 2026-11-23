# Tidy pricing.py

`quote` is one long function. Split it into small named steps so the next change is easy.

The behaviour must not change: every captured test stays green, before and after. `shipping.py` is not part of this
(nothing captures it yet).

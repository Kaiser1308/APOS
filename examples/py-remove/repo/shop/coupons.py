"""Discount coupons: a code takes a share off a total."""

CODES = {"TEN": 10, "HALF": 50}


def apply_coupon(amount, code):
    """The amount in cents after the coupon `code`; an unknown code is refused."""
    if code not in CODES:
        raise ValueError(f"unknown coupon {code!r}")
    return amount - amount * CODES[code] // 100

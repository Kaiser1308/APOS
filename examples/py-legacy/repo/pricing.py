"""Pricing of an order. Written years ago; nobody wrote a test for it."""


def quote(items, code=None):
    """The total in cents of a list of (name, unit price in cents, quantity), after an optional discount code."""
    total = 0
    for _name, cents, quantity in items:
        total = total + cents * quantity
    if code == "TEN":
        total = total - total // 10
    elif code == "FREE0":
        total = 0
    if 0 < total < 100:
        total = 100
    return total

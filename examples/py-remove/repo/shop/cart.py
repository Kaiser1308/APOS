from shop.coupons import apply_coupon


def total(items, coupon=None):
    """The total in cents of (name, unit price in cents, quantity) lines, less an optional coupon."""
    amount = sum(cents * quantity for _name, cents, quantity in items)
    if coupon is not None:
        amount = apply_coupon(amount, coupon)
    return amount

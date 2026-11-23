"""What shipping costs. Nothing here is covered by a test either."""


def shipping(total_cents):
    """Free from 50.00 up, 4.99 below."""
    return 0 if total_cents >= 5000 else 499

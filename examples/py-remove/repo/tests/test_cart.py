from shop.cart import total


def test_total_sums_the_lines():
    assert total([("pen", 150, 2), ("ink", 400, 1)]) == 700


def test_an_empty_cart_totals_zero():
    assert total([]) == 0

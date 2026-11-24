from shop.cart import total


def test_a_cart_totals_its_lines():
    assert total([("pen", 100, 3)]) == 300

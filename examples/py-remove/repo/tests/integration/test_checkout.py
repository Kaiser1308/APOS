from shop.cart import total


def test_two_orders_total_to_the_sum_of_their_carts():
    first = [("pen", 150, 2)]
    second = [("ink", 400, 1)]
    assert total(first + second) == total(first) + total(second)

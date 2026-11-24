import pytest

from shop.cart import total


def test_ten_percent_coupon_takes_off_a_tenth():
    assert total([("pen", 1000, 1)], coupon="TEN") == 900


def test_an_unknown_coupon_is_refused():
    with pytest.raises(ValueError):
        total([("pen", 1000, 1)], coupon="NOPE")

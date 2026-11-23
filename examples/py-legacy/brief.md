# Pricing today

`pricing.py` computes the total of every order and has no test. Before anyone cleans it up, we write down what it does
today, odd corners included.

1. The total is the sum of unit price times quantity over the items of the order.
2. An order that comes to less than 1.00 (but not 0) is charged 1.00: a minimum charge.
3. The code `TEN` takes a tenth off the total, and the tenth is rounded down, so the customer pays the rounding.
4. The code `FREE0` makes the order free. Its name suggests "0% off", so this looks like a defect. It is what the shop
   does today: capture it, and note it; a bug is opened later with `apos bug`, not fixed here.

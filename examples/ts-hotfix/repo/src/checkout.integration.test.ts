import { expect, it } from 'vitest';
import { orderTotal } from './orders.ts';

it('a cart of several items is added up before the code is applied', () => {
  const cart = [
    { sku: 'A', price: 20, qty: 2 },
    { sku: 'B', price: 10, qty: 1 },
  ];
  expect(orderTotal(cart, 'SAVE10')).toBe(45);
});

import { expect, it } from 'vitest';
import { orderTotal } from './orders.ts';

const cart = [
  { sku: 'A', price: 10, qty: 3 },
  { sku: 'B', price: 5, qty: 2 },
];

it('adds up the items of a cart with no code', () => {
  expect(orderTotal(cart)).toBe(40);
});

it('takes the percent of a known code off', () => {
  expect(orderTotal(cart, 'SAVE10')).toBe(36);
  expect(orderTotal(cart, 'HALF')).toBe(20);
});

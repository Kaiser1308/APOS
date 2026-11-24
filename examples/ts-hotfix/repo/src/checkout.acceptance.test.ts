import { expect, it } from 'vitest';
import { orderTotal } from './orders.ts';

it('a known code takes its percent off the total', () => {
  expect(orderTotal([{ sku: 'A', price: 100, qty: 1 }], 'HALF')).toBe(50);
});

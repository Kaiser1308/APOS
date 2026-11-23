import { expect, it } from 'vitest';
import { placeOrder, shipOrder } from './orders.ts';

it('an order is placed open and shipped once', () => {
  const placed = placeOrder('O-1', new Date('2026-03-01T10:00:00Z'));
  expect(placed.status).toBe('open');
  expect(shipOrder(placed).status).toBe('shipped');
});

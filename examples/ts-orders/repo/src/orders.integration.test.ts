import { expect, it } from 'vitest';
import { placeOrder, shipOrder } from './orders.ts';

it('an order goes from placed to shipped, and only once', () => {
  const placed = placeOrder('O-1', new Date('2026-03-01T10:00:00Z'));
  const shipped = shipOrder(placed);
  expect(shipped).toEqual({ ...placed, status: 'shipped' });
  expect(() => shipOrder(shipped)).toThrow('cannot be shipped');
});

import { describe, expect, it } from 'vitest';
import { placeOrder, shipOrder } from './orders.ts';

describe('orders', () => {
  it('places an open order stamped with the time', () => {
    const order = placeOrder('O-1', new Date('2026-03-01T10:00:00Z'));
    expect(order).toEqual({ id: 'O-1', placedAt: '2026-03-01T10:00:00.000Z', status: 'open' });
  });

  it('ships an open order', () => {
    const order = shipOrder(placeOrder('O-2', new Date('2026-03-01T10:00:00Z')));
    expect(order.status).toBe('shipped');
  });

  it('does not ship an order twice', () => {
    const shipped = shipOrder(placeOrder('O-3', new Date('2026-03-01T10:00:00Z')));
    expect(() => shipOrder(shipped)).toThrow('cannot be shipped');
  });
});

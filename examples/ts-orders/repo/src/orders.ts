export type OrderStatus = 'open' | 'shipped' | 'cancelled';

export type Order = {
  id: string;
  /** ISO timestamp of the moment the customer placed the order. */
  placedAt: string;
  status: OrderStatus;
};

export function placeOrder(id: string, now: Date): Order {
  return { id, placedAt: now.toISOString(), status: 'open' };
}

export function shipOrder(order: Order): Order {
  if (order.status !== 'open') throw new Error(`order ${order.id} is ${order.status}: it cannot be shipped`);
  return { ...order, status: 'shipped' };
}

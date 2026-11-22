import type { Order } from './orders.ts';

/** Cancels an order the customer asked to cancel. A shipped order is on its way and cannot be cancelled. */
export function cancelOrder(order: Order): Order {
  if (order.status === 'shipped') throw new Error(`order ${order.id} is shipped: it cannot be cancelled`);
  return { ...order, status: 'cancelled' };
}

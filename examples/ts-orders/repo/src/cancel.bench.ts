import { bench } from 'vitest';
import { cancelOrder } from './cancel.ts';

const day = 24 * 60 * 60 * 1000;
const now = new Date('2026-04-01T00:00:00Z');
const orders = Array.from({ length: 1000 }, (_, i) => ({
  id: `O-${i}`,
  placedAt: new Date(now.getTime() - (i % 25) * day).toISOString(),
  status: 'open' as const,
}));

// Close stage: how long 1000 cancellations take (the nightly clean-up cancels thousands at once).
bench(
  'cancel 1000 orders',
  () => {
    for (const order of orders) cancelOrder(order, now);
  },
  { time: 200 },
);

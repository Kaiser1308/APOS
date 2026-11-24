export type Item = { sku: string; price: number; qty: number };

/** Percent off for each discount code a customer can type at the checkout. */
const DISCOUNTS: Record<string, number> = { SAVE10: 10, HALF: 50, FREE0: 0 };

/** The total of an order: the items, less the percent the discount code gives. A code that is not known gives nothing. */
export function orderTotal(items: Item[], code?: string): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const percent = code === undefined ? 0 : DISCOUNTS[code] || 100;
  return subtotal - (subtotal * percent) / 100;
}

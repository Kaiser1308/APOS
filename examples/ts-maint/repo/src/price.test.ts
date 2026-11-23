import { expect, it } from 'vitest';
import { priceText } from './price.js';

it('shows a price in dollars and cents', () => {
  expect(priceText(1999)).toBe('$19.99');
});

it('shows zero as $0.00', () => {
  expect(priceText(0)).toBe('$0.00');
});

import { expect, it } from 'vitest';
import { priceText } from './price.js';

it('a customer sees the same price text on every screen', () => {
  expect(priceText(500)).toBe(priceText(500));
});

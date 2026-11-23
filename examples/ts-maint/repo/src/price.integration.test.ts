import { expect, it } from 'vitest';
import { priceText } from './price.js';

it('prices of a basket are all in the same format', () => {
  for (const cents of [100, 250, 4000]) expect(priceText(cents)).toMatch(/^\$\d+\.\d\d$/);
});

import { fmt } from './fmt.js';

/** The text of a price in cents: what the customer sees. */
export const priceText = (cents: number): string => fmt.format(cents);

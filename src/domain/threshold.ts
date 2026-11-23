import { z } from 'zod';

export const THRESHOLD_OPS = ['<', '<=', '>', '>='] as const;
export const thresholdSchema = z.object({ op: z.enum(THRESHOLD_OPS), value: z.number().finite() });
export type Threshold = z.infer<typeof thresholdSchema>;

export function holds(actual: number, threshold: Threshold): boolean {
  switch (threshold.op) {
    case '<':
      return actual < threshold.value;
    case '<=':
      return actual <= threshold.value;
    case '>':
      return actual > threshold.value;
    case '>=':
      return actual >= threshold.value;
  }
}
export const describeThreshold = (name: string, threshold: Threshold): string =>
  `${name} ${threshold.op} ${threshold.value}`;

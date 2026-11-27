import { z } from 'zod';

const eventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  at: z.string(),
  data: z.unknown().optional(),
  goalId: z.string().optional(),
});
const entrySchema = z.object({ seq: z.number().int().positive(), id: z.string().min(1), event: eventSchema });
const headerSchema = z.object({ generation: z.string().min(1) });

export type StreamEvent = z.infer<typeof eventSchema>;
export type StreamEntry = z.infer<typeof entrySchema>;
export type StreamHeader = z.infer<typeof headerSchema>;
export type StreamOptions = { initialize?: boolean; generation?: string; anchor?: string };
export const parseStreamEvent = (value: unknown): StreamEvent => eventSchema.parse(value);
export const parseStreamEntry = (value: unknown): StreamEntry => entrySchema.parse(value);
export const parseStreamHeader = (value: unknown): StreamHeader => headerSchema.parse(value);

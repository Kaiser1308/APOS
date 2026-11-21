import { z } from 'zod';

const runShow = z.object({
  run: z.object({
    id: z.string().min(1),
    coordinator_handle: z.string().min(1).nullable(),
    consumer_generation: z.number().int(),
  }),
});

/** `orchestration run-show --id <run> --full`: the Run's coordinator terminal (null when none is bound) and its consumer generation. */
export function parseRunShow(value: unknown): { runId: string; coordinator: string | null; generation: number } {
  const { run } = runShow.parse(value);
  return { runId: run.id, coordinator: run.coordinator_handle, generation: run.consumer_generation };
}

/**
 * The terminal Orca has as the Run's coordinator. Only that terminal may start workers in the Run or read its mail
 * (`worker-start --run` and `check --run` are fenced otherwise, Orca 1.4.265), and `run-use` is the only way to take a
 * Run over, which unbinds every other Run of the caller. So APOS never calls it: it reads who holds the Run instead.
 */
export function runCoordinator(execute: (args: string[]) => Record<string, unknown>, runId: string): string | null {
  return parseRunShow(execute(['orchestration', 'run-show', '--id', runId])).coordinator;
}

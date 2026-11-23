/**
 * How setup and catalog files turn into plain objects and back. The domain never names a file format: the
 * CLI injects one codec. `extension` is what catalog files in `catalog/` end with.
 */
export interface SetupCodec {
  readonly extension: string;
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

/** `.apos/project.yaml` in the managed repo. A constant, so the format can change without touching callers. */
export const SETUP_FILE = '.apos/project.yaml';

/**
 * JSON in files, with one allowance: the flat `key: value` text `apos init` wrote before setup v2
 * (`schemaVersion: 1`), so an existing repo still reads as "no setup".
 */
export const jsonCodec: SetupCodec = {
  extension: '.json',
  parse(text) {
    const trimmed = text.replace(/^﻿/, '').trim();
    if (!trimmed) return null;
    const legacy = /^schemaVersion:\s*(\d+)$/.exec(trimmed);
    if (legacy) return { schemaVersion: Number(legacy[1]) };
    return JSON.parse(trimmed);
  },
  stringify: value => `${JSON.stringify(value, null, 2)}\n`,
};

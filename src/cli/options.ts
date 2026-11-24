import type { GateOptions } from '../app/gate-service.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { SetupCodec } from '../domain/setup-codec.js';
import type { ConfirmIo } from './human-confirm.js';

export type CliOptions = {
  inspector?: CommitInspector;
  gate?: GateOptions;
  home?: string;
  /** How setup and catalog files are read and written; YAML by default. */
  codec?: SetupCodec;
  /** Where Human confirmations are asked; the real terminal by default. */
  io?: ConfirmIo;
  /** The time a hotfix deadline is read at; `APOS_NOW` or the real clock by default. */
  now?: () => string;
  write?: (line: string) => void;
  /** Diagnostics (warnings) that must not pollute stdout; defaults to stderr. */
  writeError?: (line: string) => void;
};

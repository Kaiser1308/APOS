import type { GateOptions } from '../app/gate-service.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { ConfirmIo } from './human-confirm.js';

export type CliOptions = {
  inspector?: CommitInspector;
  gate?: GateOptions;
  home?: string;
  /** Where Human confirmations are asked; the real terminal by default. */
  io?: ConfirmIo;
  write?: (line: string) => void;
  /** Diagnostics (warnings) that must not pollute stdout; defaults to stderr. */
  writeError?: (line: string) => void;
};

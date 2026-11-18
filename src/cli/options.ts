import type { GateOptions } from '../app/gate-service.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import type { TelemetryProbe } from '../ports/telemetry.js';

export type CliOptions = {
  runtime?: RuntimeAdapter & Partial<PackageRuntime>;
  inspector?: CommitInspector;
  gate?: GateOptions;
  telemetry?: TelemetryProbe;
  home?: string;
  write?: (line: string) => void;
  /** Diagnostics (warnings) that must not pollute stdout; defaults to stderr. */
  writeError?: (line: string) => void;
};

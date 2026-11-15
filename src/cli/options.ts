import type { GateOptions } from '../app/gate.js';
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
};

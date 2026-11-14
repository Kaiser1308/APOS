export type Usage = {
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  sessions: number;
};
export interface TelemetryProbe {
  usage(input: { worktreePath: string; since: string; until: string }): Usage | undefined;
}

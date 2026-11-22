import { z } from 'zod';
import { unreadable, parseJson, type Finding, type ParsedReport } from './types.js';

const level = z.enum(['error', 'warning', 'note', 'none']);
const result = z.object({
  ruleId: z.string().optional(),
  ruleIndex: z.number().int().optional(),
  rule: z.object({ id: z.string().optional() }).optional(),
  level: level.optional(),
  locations: z
    .array(
      z.object({
        physicalLocation: z
          .object({
            artifactLocation: z.object({ uri: z.string().optional() }).optional(),
            region: z.object({ startLine: z.number().int().optional() }).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
const sarif = z.object({
  runs: z
    .array(
      z.object({
        tool: z
          .object({ driver: z.object({ rules: z.array(z.object({ id: z.string() })).optional() }).optional() })
          .optional(),
        results: z.array(result).optional(),
      }),
    )
    .min(1),
});

/** SARIF 2.1.0. A run with no `results` array is treated as unreadable, not as "no findings". */
export function readSarif(content: string): ParsedReport {
  const json = parseJson(content);
  if (json === undefined) return unreadable('SARIF report is not valid JSON');
  const parsed = sarif.safeParse(json);
  if (!parsed.success) return unreadable('SARIF report has no runs');
  const findings: Finding[] = [];
  for (const run of parsed.data.runs) {
    if (!run.results) return unreadable('SARIF run has no results array');
    const rules = run.tool?.driver?.rules ?? [];
    for (const item of run.results) {
      const physical = item.locations?.[0]?.physicalLocation;
      const file = physical?.artifactLocation?.uri;
      const line = physical?.region?.startLine;
      findings.push({
        ruleId:
          item.ruleId ??
          item.rule?.id ??
          (item.ruleIndex === undefined ? undefined : rules[item.ruleIndex]?.id) ??
          'unknown',
        // SARIF's default level is "warning"; "none" carries no severity, so it is the lowest we have.
        level: item.level === undefined ? 'warning' : item.level === 'none' ? 'note' : item.level,
        ...(file === undefined ? {} : { file }),
        ...(line === undefined ? {} : { line }),
      });
    }
  }
  return { kind: 'findings', findings };
}

import { z } from 'zod';
import { unreadable, parseJson, type ParsedReport } from './types.js';

const test = z.object({
  id: z.string().min(1),
  status: z.enum(['pass', 'fail', 'error', 'skip']),
  message: z.string().optional(),
  file: z.string().optional(),
});
const finding = z.object({
  ruleId: z.string().min(1),
  level: z.enum(['error', 'warning', 'note']),
  file: z.string().optional(),
  line: z.number().int().optional(),
});
const report = z.union([z.object({ tests: z.array(test) }), z.object({ findings: z.array(finding) })]);

/** `{"tests":[{id,status,message?}]}` or `{"findings":[{ruleId,level,file?,line?}]}`. Anything else is unreadable. */
export function readAposJson(content: string): ParsedReport {
  const json = parseJson(content);
  if (json === undefined) return unreadable('apos-json report is not valid JSON');
  const parsed = report.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return unreadable(
      `apos-json report does not match {"tests":[...]} or {"findings":[...]}${issue?.path.length ? ` (at ${issue.path.join('.')})` : ''}`,
    );
  }
  return 'tests' in parsed.data
    ? { kind: 'tests', tests: parsed.data.tests }
    : { kind: 'findings', findings: parsed.data.findings };
}

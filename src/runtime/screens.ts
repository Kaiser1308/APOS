/**
 * What an agent's terminal shows, per agent. Pure functions over the visible tail that `orca terminal read`
 * returns, each written from real captures in `fixtures/screens/<agent>/` (see the READMEs there).
 */
export type AgentId = 'codex' | 'claude' | 'antigravity';
export type ScreenRules = {
  /** The agent is visibly doing something: never nudged, never reported. */
  working(lines: string[]): boolean;
  /** A brief sits in the input box, not submitted. */
  unsentBrief(lines: string[]): boolean;
  /** The agent's own "out of quota" line, trimmed, when it is on screen. */
  quota(lines: string[]): string | undefined;
};

const lastLine = (lines: string[]) => [...lines].reverse().find(line => line.trim()) ?? '';

const codex: ScreenRules = {
  working: lines => lines.some(line => /esc to interrupt|^\s*[•◦]\s*Working\b/.test(line)),
  unsentBrief(lines) {
    if (codex.working(lines)) return false;
    const prompt = lines
      .map((line, index) => ({ line, index }))
      .filter(item => /^\s*›/.test(item.line))
      .at(-1);
    if (!prompt) return false;
    const composer = lines.slice(prompt.index, prompt.index + 4).join(' ');
    return composer.includes('[Pasted Content') || prompt.line.replace(/^\s*›\s*/, '').length > 120;
  },
  // Message text is real (Codex rollout error.message); its `■` placement on screen is unverified. Only an unindented
  // line with nothing after it but the prompt and its status lines counts: text the agent printed or an old notice does not.
  quota(lines) {
    const index = lines
      .map((line, at) => ({ line, at }))
      .filter(item => /^■? ?You[’']ve hit your usage limit\b/.test(item.line))
      .at(-1)?.at;
    if (index === undefined || lines.slice(index + 1).some(line => line.trim() && !/^\s*›|^\s{2,}\S/.test(line)))
      return undefined;
    return lines[index].replace(/^■? ?/, '').trim();
  },
};

/** Orca opens Claude as a structured chat: the tail is a transcript and Orca delivers the brief itself. */
const claude: ScreenRules = {
  working: lines => /^\[assistant\] \[tool [^\]]+\]/.test(lastLine(lines)),
  unsentBrief: () => false,
  // Only the transcript's last line: an old notice the session has moved past, or a quoted one, does not count.
  quota(lines) {
    const last = lastLine(lines);
    return /^(\[assistant\] )?[⎿●•■]? ?You[’']ve hit your (weekly|5-hour|usage|session) limit\b/.test(last)
      ? last.replace(/^(\[assistant\] )?[⎿●•■]? ?/, '').trim()
      : undefined;
  },
};

/** Antigravity CLI: a `>` input box between two rules, `esc to cancel` and a spinner while it works. */
const antigravity: ScreenRules = {
  working: lines => lines.some(line => /\besc to cancel\b|^\s*[⣾⣽⣻⢿⡿⣟⣯⣷]/.test(line)),
  unsentBrief(lines) {
    if (antigravity.working(lines)) return false;
    const rules = lines.map((line, index) => ({ line, index })).filter(item => /^─{10,}/.test(item.line));
    if (rules.length < 2) return false;
    const box = lines.slice(rules.at(-2)!.index + 1, rules.at(-1)!.index);
    if (!/^>/.test(box[0] ?? '')) return false;
    return box.join(' ').replace(/^>\s*/, '').trim().length > 120;
  },
  // No real quota sample yet: unverified, so nothing is claimed and owner-idle covers it.
  quota: () => undefined,
};

export const SCREENS: Record<AgentId, ScreenRules> = { codex, claude, antigravity };

/** The rule sets for `agent`; an unknown or missing agent tries every one. */
export function rulesFor(agent: string | undefined): ScreenRules[] {
  return agent && agent in SCREENS ? [SCREENS[agent as AgentId]] : Object.values(SCREENS);
}

export function unsentBrief(agent: string | undefined, lines: string[]): boolean {
  const rules = rulesFor(agent);
  return !rules.some(item => item.working(lines)) && rules.some(item => item.unsentBrief(lines));
}

export function quotaMessage(agent: string | undefined, lines: string[]): string | undefined {
  const rules = rulesFor(agent);
  if (rules.some(item => item.working(lines))) return undefined;
  for (const item of rules) {
    const found = item.quota(lines);
    if (found) return found;
  }
  return undefined;
}

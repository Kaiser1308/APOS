import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertGitRoot } from '../store/project-history.js';

/** The skill/controller contract this build implements; every APOS skill declares it in frontmatter. */
export const APOS_CONTRACT = 3;
const ROLES = ['pm', 'lead', 'worker', 'reviewer'] as const;

/** The stable copy of the skills, bundled with this repo (`skills/apos-core`, `skills/apos-<role>`). */
export const BUNDLED_SKILLS = fileURLToPath(new URL('../../skills', import.meta.url));

/**
 * Skills come from `--skills <dir>`, else `APOS_SKILLS`, else the stable copy bundled here. The copy
 * under development lives in Custom-Skills: try it with `--skills`, and bring it over with
 * `npm run skills:promote -- <dir>` once it is ready. A skill written for another contract version is
 * refused, so code and skills cannot drift apart silently.
 */
export function resolveSkills(skillsRoot: string = process.env.APOS_SKILLS || BUNDLED_SKILLS): {
  core: string;
  roles: Record<(typeof ROLES)[number], string>;
} {
  const read = (name: string) => {
    const path = join(skillsRoot, name, 'SKILL.md');
    if (!existsSync(path)) throw new Error(`APOS skill missing: ${path}`);
    const text = readFileSync(path, 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const version = /^apos-contract:\s*(\d+)\s*$/m.exec(front)?.[1];
    if (Number(version) !== APOS_CONTRACT)
      throw new Error(`${path} declares apos-contract ${version ?? 'none'}; this APOS build needs ${APOS_CONTRACT}`);
    return path;
  };
  return {
    core: read('apos-core'),
    roles: Object.fromEntries(ROLES.map(role => [role, read(`apos-${role}`)])) as Record<
      (typeof ROLES)[number],
      string
    >,
  };
}

export async function initProject(repoPath: string, skillsRoot?: string): Promise<void> {
  const repo = assertGitRoot(repoPath);
  const skills = resolveSkills(skillsRoot);
  const dir = join(repo, '.apos');
  mkdirSync(join(dir, 'goals'), { recursive: true });
  const config = join(dir, 'project.yaml');
  if (!existsSync(config)) writeFileSync(config, 'schemaVersion: 2\nparts: {}\n', 'utf8');
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'state.sqlite*\n', 'utf8');
  const files = [config, ignore];
  // Claude Code reads .claude/skills; Codex and Antigravity read the workspace .agents/skills. A copy already there is the user's.
  for (const root of ['.claude', '.agents'])
    for (const role of ROLES) {
      const source = skills.roles[role];
      const targetDir = join(repo, root, 'skills', `apos-${role}`);
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, 'SKILL.md');
      if (!existsSync(target)) {
        copyFileSync(source, target);
        files.push(target);
      }
    }
  // Briefs pin these committed copies by sha256; APOS owns them, so they track the packaged version.
  const managed: [string, string][] = [[skills.core, join(dir, 'skills', '_core', 'execute.md')]];
  for (const role of ROLES) managed.push([skills.roles[role], join(dir, 'skills', `${role}.md`)]);
  for (const [source, target] of managed) {
    const content = readFileSync(source, 'utf8');
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content, 'utf8');
      files.push(target);
    }
  }
  const paths = files.map(path => relative(repo, path));
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...paths], { encoding: 'utf8' });
  if (status.trim()) {
    execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'add', '--', ...paths]);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=APOS',
      '-c',
      'user.email=apos@local.invalid',
      'commit',
      '--only',
      '-m',
      'apos: initialize managed project',
      '--',
      ...paths,
    ]);
  }
}

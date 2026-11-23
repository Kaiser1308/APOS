import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertGoalExclusionComplete, parseGoalSpec } from '../domain/contracts.js';
import { sourceDigest } from '../domain/gate.js';
import { controllerHome } from '../store/event-log.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from '../app/events.js';
import { confirmHuman, terminalIo, type HumanConfirmation } from './human-confirm.js';
import type { CliOptions } from './options.js';

export type CliContext = {
  program: Command;
  options: CliOptions;
  write(line: string): void;
  writeError(line: string): void;
  repo(): string;
  home(): string;
  withJournal<T>(fn: (journal: ProjectJournal) => T): T;
  withJournalAsync<T>(fn: (journal: ProjectJournal) => Promise<T>): Promise<T>;
  /**
   * Gates A, B, D, appetite changes and manual confirmations belong to the Human: they need the subject typed back in
   * an interactive terminal, or `--on-behalf "<why>"`. Nothing is written to the log before this passes.
   */
  assertHuman(command: string, subject: string, onBehalf?: string): Promise<HumanConfirmation>;
  goalWithSource(file: string, sourcePath: string, origin: string): ReturnType<typeof goalWithSource>;
  readJsonFile(file: string): unknown;
};

/** PowerShell's `Set-Content -Encoding utf8` writes a BOM, which JSON.parse rejects. */
function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** Reads the Goal JSON and the verbatim source; fills `source` when absent, otherwise checks it matches. */
function goalWithSource(file: string, sourcePath: string, origin: string) {
  const raw = readJsonFile(file) as Record<string, unknown>;
  const text = readFileSync(sourcePath, 'utf8');
  const digest = sourceDigest(text);
  const given = raw.source as { sha256?: string } | undefined;
  if (given?.sha256 && given.sha256 !== digest)
    throw new Error(
      `Goal source sha256 does not match --source file: expected ${digest} (APOS hashes the text with CRLF line endings turned into LF, so a hash of the raw file on Windows differs); or omit "source" from goal.json and APOS fills it in.`,
    );
  const spec = parseGoalSpec({
    ...raw,
    source: given ?? { path: sourcePath, sha256: digest, capturedAt: new Date().toISOString(), origin },
  });
  assertGoalExclusionComplete(spec);
  return { spec, text };
}

export function createContext(program: Command, options: CliOptions): CliContext {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const repo = () => resolve(program.opts<{ repo: string }>().repo);
  const openJournal = () => {
    const path = repo();
    if (!existsSync(join(path, '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    return ProjectJournal.open(path, options.home, newEvent);
  };
  const withJournal = <T>(fn: (journal: ProjectJournal) => T): T => {
    const { journal, close } = openJournal();
    try {
      return fn(journal);
    } finally {
      close();
    }
  };
  const withJournalAsync = async <T>(fn: (journal: ProjectJournal) => Promise<T>): Promise<T> => {
    const { journal, close } = openJournal();
    try {
      return await fn(journal);
    } finally {
      close();
    }
  };
  const io = options.io ?? terminalIo();
  const assertHuman = (command: string, subject: string, onBehalf?: string) =>
    confirmHuman({ command, subject, onBehalf, io });
  const home = () => options.home ?? controllerHome(repo());
  return {
    program,
    options,
    write,
    writeError,
    repo,
    home,
    withJournal,
    withJournalAsync,
    assertHuman,
    goalWithSource,
    readJsonFile,
  };
}

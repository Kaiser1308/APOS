import { Command } from 'commander';
import { registerBug } from './cli/commands/bug.js';
import { registerChecks } from './cli/commands/checks.js';
import { registerGoal } from './cli/commands/goal.js';
import { registerIntegration } from './cli/commands/integration.js';
import { registerMaintenance } from './cli/commands/maintenance.js';
import { registerLead } from './cli/commands/lead.js';
import { registerOutcome } from './cli/commands/outcome.js';
import { registerPackage } from './cli/commands/package.js';
import { registerReview } from './cli/commands/review.js';
import { registerTests } from './cli/commands/tests.js';
import { registerSetup } from './cli/commands/setup.js';
import { registerSetupFlow } from './cli/commands/setup-flow.js';
import { createContext } from './cli/context.js';
import type { CliOptions } from './cli/options.js';

export type { CliOptions };

/** The whole command tree, registered but not run: `runCli` parses with it, and tests read it. */
export function buildProgram(options: CliOptions = {}): Command {
  const program = new Command();
  program
    .name('apos')
    .description('Assurance layer for AI-built software: fixed checks on exact commits')
    .version('0.1.0')
    .option('--repo <path>', 'managed Git project', process.cwd());
  const ctx = createContext(program, options);
  registerSetup(ctx);
  registerSetupFlow(ctx);
  registerGoal(ctx);
  registerBug(ctx);
  registerMaintenance(ctx);
  registerLead(ctx);
  registerTests(ctx);
  registerPackage(ctx);
  registerIntegration(ctx);
  registerChecks(ctx);
  registerReview(ctx);
  registerOutcome(ctx);
  return program;
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  await buildProgram(options).parseAsync(argv, { from: 'user' });
}

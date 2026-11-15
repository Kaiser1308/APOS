import { Command } from 'commander';
import { registerChecks } from './cli/commands/checks.js';
import { registerController } from './cli/commands/controller.js';
import { registerGoal } from './cli/commands/goal.js';
import { registerIntegration } from './cli/commands/integration.js';
import { registerLead } from './cli/commands/lead.js';
import { registerOutcome } from './cli/commands/outcome.js';
import { registerPackage } from './cli/commands/package.js';
import { registerSetup } from './cli/commands/setup.js';
import { createContext } from './cli/context.js';
import type { CliOptions } from './cli/options.js';

export type { CliOptions };

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const program = new Command();
  program
    .name('apos')
    .description('Local AI Project Orchestration System')
    .version('0.1.0')
    .option('--repo <path>', 'managed Git project', process.cwd());
  const ctx = createContext(program, options);
  registerSetup(ctx);
  registerGoal(ctx);
  registerLead(ctx);
  registerPackage(ctx);
  registerIntegration(ctx);
  registerController(ctx);
  registerChecks(ctx);
  registerOutcome(ctx);
  await program.parseAsync(argv, { from: 'user' });
}

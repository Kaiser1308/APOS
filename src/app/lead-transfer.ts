import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { multiWallTimeExpired } from './multi-budget.js';
import { worktreePath } from '../runtime/orca/parse.js';
import { newEvent } from './events.js';
import { HandoffService, causedByFailure } from './handoff.js';
import { transferNotice, wakeBot } from './bot-lead.js';
import { transferable } from '../domain/lead-transfer.js';
import { UserError } from '../domain/errors.js';
import type { GoalEventType, GoalState } from '../domain/transitions.js';
import type { RuntimeProfiles } from '../domain/runtime-refs.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { BotIdentity, PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';

/**
 * Moves a Goal's Lead role between an APOS-dispatched Lead and an Orca bot, both Human decisions. To a bot: intent
 * first, the Lead dispatch is stopped and confirmed stopped (else refused), then `lead-transferred` records the bot,
 * who moved it and when. Back: `lead-returned`, then the ordinary handoff starts a fresh APOS Lead on the worktree.
 */
export class LeadTransferService {
  constructor(
    private readonly store: GoalRepository,
    private readonly runtime: RuntimeAdapter & Partial<PackageRuntime>,
    private readonly profiles: () => RuntimeProfiles,
  ) {}

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append(newEvent(goalId, type, data));
  }

  async toBot(
    goalId: string,
    nameOrId: string,
    by: string,
    repoPath: string,
  ): Promise<{ bot: BotIdentity; from: string; warning?: string }> {
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal does not exist: ${goalId}`);
    const pending = state.handoffIntent;
    if (pending && pending.target.kind !== 'bot')
      throw new UserError(`A handoff of ${goalId} is pending; finish it with \`apos handoff ${goalId}\` first`);
    if (state.leadBot)
      throw new UserError(
        `The Lead of ${goalId} is already bot ${state.leadBot.name}; run \`apos handoff ${goalId} --to-apos\` first`,
      );
    if (!this.runtime.findBot || !this.runtime.wakeBot)
      throw new UserError('Configured runtime cannot reach Orca bots');
    let key: string;
    let from: string;
    let bot: BotIdentity;
    if (pending?.target.kind === 'bot') {
      // A transfer whose CLI died after its intent: finish it for the bot it named.
      ({ key, from } = pending);
      bot = { id: pending.target.botId, name: pending.target.botName };
      const wanted = nameOrId.trim().toLowerCase();
      if (wanted !== bot.id.toLowerCase() && wanted !== bot.name.toLowerCase())
        throw new UserError(
          `The transfer of ${goalId}'s Lead to bot ${bot.name} (${bot.id}) is pending; finish it with --to-bot ${bot.id}, or drop it with \`apos execution abandon-intent ${goalId} --key ${key} --reason ...\``,
        );
    } else {
      this.assertTransferable(state);
      const found = this.runtime.findBot(nameOrId);
      if (!found) throw new UserError(`No Orca bot ${nameOrId} on this computer (see \`orca bot list\`)`);
      if (found.paused) throw new UserError(`Bot ${found.name} is paused in Orca`);
      bot = found;
      key = randomUUID();
      from = state.lead!.current;
      this.record(goalId, 'handoff-intended', {
        key,
        target: { kind: 'bot', botId: bot.id, botName: bot.name },
        from,
        runId: state.lead!.ref.runId,
      });
    }
    if (!(await this.stopped(state, from, repoPath))) {
      this.record(goalId, 'intent-abandoned', { key, reason: 'Orca could not confirm the Lead stopped' });
      throw new Error(
        `Could not confirm the Lead stopped; check Orca (orca orchestration worker-show --dispatch ${from}) before retrying`,
      );
    }
    this.record(goalId, 'lead-transferred', { key, from, by, bot: { id: bot.id, name: bot.name } });
    const now = this.store.getGoal(goalId)!;
    try {
      await wakeBot(this.store, this.runtime, goalId, repoPath, [transferNotice(now)!]);
      return { bot, from };
    } catch (error) {
      // The transfer stands; the controller sends the notice again on its next tick.
      return { bot, from, warning: `could not mail bot ${bot.name} yet (${errorText(error)}); the controller retries` };
    }
  }

  async back(goalId: string, by: string, repoPath: string): Promise<{ dispatchId?: string; note: string }> {
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal does not exist: ${goalId}`);
    const bot = state.leadBot;
    if (!bot) throw new UserError(`No bot holds the Lead of ${goalId}`);
    // Everything the handoff that follows would refuse is refused first: the bot is never told to stop while no APOS
    // Lead can take over.
    const busy = [state.dispatchIntent, state.resumeIntent, state.leadIntent, state.reviewIntent, state.handoffIntent];
    if (busy.some(Boolean))
      throw new UserError(
        `A dispatch of ${goalId} is pending; wait until the controller settles it, then return the Lead`,
      );
    const soloRunning =
      state.proposal?.mode.startsWith('solo') && ['executing', 'blocked', 'verified'].includes(state.status);
    if (!soloRunning) {
      if (!state.lead) throw new UserError(`${goalId} has no Lead worktree for a fresh APOS Lead`);
      if (!['selected', 'planned', 'ready', 'executing', 'blocked'].includes(state.status))
        throw new UserError(`${goalId} is ${state.status}: there is no running Lead role to return`);
      if (state.status === 'blocked' && !causedByFailure(state.blocker?.note))
        throw new UserError(
          `${goalId} is blocked for another reason (${state.blocker?.note ?? 'unknown'}); resolve it before returning the Lead`,
        );
      if (multiWallTimeExpired(this.store, goalId))
        throw new UserError('Multi-WP wall time exhausted; Human decision required before a fresh APOS Lead');
      const tree = worktreePath(state.lead.ref.worktreeId);
      if (state.proposal?.mode === 'multi-wp' && (!tree || !existsSync(tree)))
        throw new UserError(
          `The Lead worktree of ${goalId} is unavailable (${tree ?? 'unknown'}); a fresh Lead needs it`,
        );
    }
    this.record(goalId, 'lead-returned', { by, botId: bot.id });
    await this.runtime
      .tellBot?.(
        { id: bot.id, name: bot.name },
        `APOS ${goalId}: Lead role ended`,
        `${by} gave the Lead role of ${goalId} back to an APOS-dispatched Lead. Stop acting on ${goalId}; APOS no longer accepts your Lead commands for it.`,
      )
      .catch(() => undefined);
    if (soloRunning)
      // A running Solo plan has its controller-dispatched owner; there is no Lead dispatch to restart.
      return { note: `the Solo owner keeps delivering ${goalId}; the Human decides what the Lead would have` };
    const started = await new HandoffService(this.store, this.runtime, this.profiles).handoff(
      goalId,
      { kind: 'lead' },
      repoPath,
    );
    return { dispatchId: started.dispatchId, note: `a fresh APOS Lead took over ${goalId}` };
  }

  private assertTransferable(state: GoalState): void {
    const goalId = state.spec.id;
    if (!state.lead)
      throw new UserError(`No APOS-dispatched Lead for ${goalId}: run \`apos lead start ${goalId}\` first`);
    const busy = state.resumeIntent
      ? 'resume'
      : state.leadIntent
        ? 'Lead dispatch'
        : state.reviewIntent
          ? 'reviewer start'
          : state.dispatchIntent
            ? 'dispatch'
            : undefined;
    if (busy) throw new UserError(`A ${busy} of ${goalId} is pending; wait until the controller settles it`);
    if (!transferable(state))
      throw new UserError(
        state.proposal?.mode.startsWith('solo') && state.status !== 'ready'
          ? `${goalId} is a Solo plan being delivered by its Lead, which is writing the code; a bot Lead never codes, so it cannot take over now`
          : `${goalId} is ${state.status}: only a planning Lead or the Lead of a running Multi-WP Goal can move to a bot`,
      );
  }

  /** True when the Lead's latest dispatch has settled or Orca confirms it stopped it. */
  private async stopped(state: GoalState, from: string, repoPath: string): Promise<boolean> {
    const observation = await this.runtime
      .inspect({ runId: state.lead?.ref.runId ?? '', taskId: '', dispatchId: from, owner: 'lead', repoPath })
      .catch(() => undefined);
    if (observation?.outcome) return true;
    return (this.runtime.stopWorker ? await this.runtime.stopWorker(from) : 'unknown') === 'stopped';
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

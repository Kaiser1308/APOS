import { describe, expect, it } from 'vitest';
import { parseSetupObject, type ProjectSetup } from './project-setup.js';
import {
  DEFAULT_FLOOR,
  layerChoiceProblems,
  planLayers,
  skippedLayers,
  type LayerRun,
  type Stage,
} from './layer-plan.js';

const junit = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  command: `run-${id} {report}`,
  format: 'junit',
  ...extra,
});
const setupOf = (extra: Record<string, unknown> = {}): ProjectSetup => {
  const parsed = parseSetupObject({
    schemaVersion: 2,
    parts: {
      api: {
        root: 'api',
        layers: {
          L0: [{ id: 'lint', command: 'lint', format: 'exit' }],
          L1: [junit('unit')],
          L2: [junit('acc')],
          L3: [junit('integ')],
          L5: [
            { id: 'scan', command: 'scan {report}', format: 'sarif' },
            { id: 'mut', command: 'mut', format: 'metric', metric: 'score', when: 'flag:mutation' },
          ],
        },
      },
      web: { root: 'web', layers: { L1: [junit('webunit')], L2: [junit('webacc')] } },
    },
    system: { L3: [junit('sysint')], L4: [junit('e2e')] },
    ...extra,
  });
  if (parsed.version !== 2) throw new Error('fixture');
  return parsed.setup;
};
const plan = (
  stage: Stage,
  over: Partial<Parameters<typeof planLayers>[0]> = {},
  setup: ProjectSetup = setupOf(),
): LayerRun[] =>
  planLayers({ setup, stage, changed: ['api/x.py', 'web/y.ts'], goalFlags: [], reductions: [], ...over });
const names = (runs: LayerRun[]) => runs.map(run => `${run.part}.${run.layer}.${run.tool.id}${run.reduced ? '!' : ''}`);

describe('planLayers: the floor', () => {
  it('has the defaults of spec 6.2', () => {
    expect(DEFAULT_FLOOR).toEqual({
      submit: ['L0', 'L1', 'L2'],
      integrate: ['L1', 'L2', 'L3'],
      close: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
    });
  });
  it('submit: only the parts with a changed file, no system', () => {
    expect(names(plan('submit', { changed: ['api/x.py'] }))).toEqual(['api.L0.lint', 'api.L1.unit', 'api.L2.acc']);
  });
  it('submit: a part root of "." owns every file', () => {
    const setup = parseSetupObject({
      schemaVersion: 2,
      parts: { all: { root: '.', layers: { L1: [junit('u')] } } },
    });
    if (setup.version !== 2) throw new Error('fixture');
    expect(names(plan('submit', { changed: ['anything/at/all.txt'] }, setup.setup))).toEqual(['all.L1.u']);
  });
  it('integrate: every part, then system, in layer order; the scan of L5 is not in this floor', () => {
    expect(names(plan('integrate'))).toEqual([
      'api.L1.unit',
      'web.L1.webunit',
      'api.L2.acc',
      'web.L2.webacc',
      'api.L3.integ',
      'system.L3.sysint',
    ]);
  });
  it('close: everything the floor names; a tool behind a flag waits for the flag', () => {
    const closing = names(plan('close'));
    expect(closing).toContain('system.L4.e2e');
    expect(closing).toContain('api.L5.scan');
    expect(closing).not.toContain('api.L5.mut');
    expect(names(plan('close', { goalFlags: ['mutation'] }))).toContain('api.L5.mut');
  });
  it('a setup floor replaces one stage and leaves the others at their default', () => {
    const setup = setupOf({ floor: { submit: ['L1'] } });
    expect(names(plan('submit', { changed: ['api/x.py'] }, setup))).toEqual(['api.L1.unit']);
    expect(names(plan('integrate', {}, setup))).toContain('api.L3.integ');
  });
  it('a layer the setup does not define is simply not planned', () => {
    expect(names(plan('submit', { changed: ['web/y.ts'] }))).toEqual(['web.L1.webunit', 'web.L2.webacc']);
  });
});

describe('planLayers: what the Lead adds', () => {
  it('adds a layer at the stage, for the changed parts and for system', () => {
    const runs = plan('submit', { changed: ['api/x.py'], packageLayers: { submit: ['L3'] } });
    expect(names(runs)).toEqual(['api.L0.lint', 'api.L1.unit', 'api.L2.acc', 'api.L3.integ', 'system.L3.sysint']);
    expect(runs.filter(run => run.why === 'lead').map(run => run.tool.id)).toEqual(['integ', 'sysint']);
  });
  it('does not run twice what the floor already runs', () => {
    const runs = plan('submit', { changed: ['api/x.py'], packageLayers: { submit: ['L2'] } });
    expect(names(runs).filter(name => name === 'api.L2.acc')).toHaveLength(1);
    expect(runs.find(run => run.layer === 'L2')?.why).toBe('floor');
  });
});

describe('planLayers: triggers', () => {
  const triggers = [{ when: { changed: ['web/**'] }, at: 'submit', run: ['system.L4'] }];
  it('a changed file that matches pulls the layer into the stage', () => {
    const runs = plan('submit', { changed: ['web/ui/a.ts'] }, setupOf({ triggers }));
    expect(runs.find(run => run.part === 'system')).toMatchObject({ layer: 'L4', why: 'trigger' });
  });
  it('no match, no run; and a trigger does not fire at another stage', () => {
    expect(names(plan('submit', { changed: ['api/x.py'] }, setupOf({ triggers })))).not.toContain('system.L4.e2e');
    expect(names(plan('integrate', { changed: ['web/a.ts'] }, setupOf({ triggers })))).not.toContain('system.L4.e2e');
  });
  it('a Goal flag trigger fires on the flag', () => {
    const flagged = setupOf({ triggers: [{ when: { goalFlag: 'perf' }, at: 'submit', run: ['api.L5'] }] });
    expect(
      plan('submit', { changed: ['api/x.py'], goalFlags: ['perf'] }, flagged).find(run => run.layer === 'L5'),
    ).toMatchObject({
      tool: { id: 'scan' },
      why: 'goal-flag',
    });
    expect(names(plan('submit', { changed: ['api/x.py'] }, flagged))).not.toContain('api.L5.scan');
  });
  it('a triggered target keeps its own flag condition', () => {
    const flagged = setupOf({ triggers: [{ when: { changed: ['api/**'] }, at: 'submit', run: ['api.L5'] }] });
    expect(names(plan('submit', { changed: ['api/x.py'] }, flagged))).toContain('api.L5.scan');
    expect(names(plan('submit', { changed: ['api/x.py'] }, flagged))).not.toContain('api.L5.mut');
  });
});

describe('planLayers: reductions', () => {
  it('keeps the reduced floor layer in the plan, marked, so the table can show it', () => {
    const runs = plan('submit', { changed: ['api/x.py'], reductions: [{ stage: 'submit', layer: 'L2' }] });
    expect(names(runs)).toEqual(['api.L0.lint', 'api.L1.unit', 'api.L2.acc!']);
  });
  it('a reduction at another stage changes nothing here', () => {
    const runs = plan('submit', { changed: ['api/x.py'], reductions: [{ stage: 'close', layer: 'L2' }] });
    expect(names(runs).some(name => name.endsWith('!'))).toBe(false);
  });
  it('cannot cancel what a trigger or the Goal asked for', () => {
    const setup = setupOf({ triggers: [{ when: { changed: ['api/**'] }, at: 'submit', run: ['api.L2'] }] });
    const runs = plan('submit', { changed: ['api/x.py'], reductions: [{ stage: 'submit', layer: 'L2' }] }, setup);
    expect(runs.find(run => run.layer === 'L2')).toMatchObject({ why: 'floor' });
    expect(runs.find(run => run.layer === 'L2')?.reduced).toBeUndefined();
  });
  it('cannot cancel a tool a criterion needs', () => {
    const runs = plan('close', { requiredTools: ['api.L5.scan'], reductions: [{ stage: 'close', layer: 'L5' }] });
    expect(runs.find(run => run.tool.id === 'scan')).toMatchObject({ why: 'floor' });
    expect(runs.find(run => run.tool.id === 'scan')?.reduced).toBeUndefined();
    const only = plan(
      'close',
      {
        requiredTools: ['api.L5.scan'],
        reductions: [{ stage: 'close', layer: 'L5' }],
      },
      setupOf({ floor: { close: ['L1'] } }),
    );
    expect(only.find(run => run.tool.id === 'scan')).toMatchObject({ why: 'proof' });
    expect(only.find(run => run.tool.id === 'scan')?.reduced).toBeUndefined();
  });
});

describe('planLayers: tools a criterion needs', () => {
  it('run at close, whatever the floor says, and only at close', () => {
    const setup = setupOf({ floor: { close: ['L1'] } });
    expect(names(plan('close', { requiredTools: ['api.L5.scan'] }, setup))).toContain('api.L5.scan');
    expect(names(plan('integrate', { requiredTools: ['api.L5.scan'] }, setup))).not.toContain('api.L5.scan');
  });
  it('a tool behind a flag runs when a criterion names it, because the criterion is the Goal asking', () => {
    const runs = plan('close', { requiredTools: ['api.L5.mut'] }, setupOf({ floor: { close: ['L1'] } }));
    expect(runs.find(run => run.tool.id === 'mut')).toMatchObject({ why: 'proof' });
  });
  it('a tool that is not in the setup is ignored here (goal approve refuses it earlier)', () => {
    expect(() => plan('close', { requiredTools: ['api.L5.nope'] })).not.toThrow();
  });
});

describe('layerChoiceProblems', () => {
  const choose = (
    layers: Partial<Record<Stage, string[]>>,
    paths?: string[],
    setup: ProjectSetup = setupOf(),
  ): string[] => layerChoiceProblems({ setup, id: 'WP-A', layers, paths });
  it('accepts a layer some part of the package (or system) defines', () => {
    expect(choose({ submit: ['L3'] }, ['api/**'])).toEqual([]);
    expect(choose({ close: ['L4'] }, ['api/**'])).toEqual([]);
  });
  it('names a layer the setup does not define for the package, and the package', () => {
    expect(choose({ submit: ['L5'] }, ['web/**'])).toEqual([
      'WP-A adds L5 at submit, but no part its paths touch (and not system) defines L5 in the setup',
    ]);
  });
  it('a package without paths may use any part', () => {
    expect(choose({ submit: ['L5'] })).toEqual([]);
  });
  it('refuses L6 (a manual check, not a tool) and an unknown stage or layer', () => {
    expect(choose({ submit: ['L6'] })[0]).toMatch(/L6/);
    expect(choose({ nope: ['L1'] } as never)[0]).toMatch(/stage/);
    expect(choose({ submit: ['L9'] })[0]).toMatch(/L9/);
  });
});

describe('skippedLayers', () => {
  const skipped = (stage: Stage, over: Partial<Parameters<typeof planLayers>[0]> = {}, setup = setupOf()) => {
    const input = { setup, stage, changed: ['api/x.py'], goalFlags: [], reductions: [], ...over };
    return skippedLayers(input, planLayers(input));
  };
  it('says a flag-gated tool is off, naming the flag', () => {
    expect(skipped('close')).toContain('api.L5.mut tắt: Goal không gắn cờ mutation');
    expect(skipped('close', { goalFlags: ['mutation'] }).some(note => note.includes('mut'))).toBe(false);
  });
  it('says a floor layer has no tool anywhere in scope', () => {
    expect(skipped('submit', { changed: ['web/y.ts'] })).toContain(
      'L0 không chạy ở khâu submit: setup không có công cụ cho lớp này',
    );
  });
});

describe('a maintenance Goal at submit', () => {
  it('adds L1, L2, L3 and the scan of every part it touches, with the reason goal-kind', () => {
    const runs = plan('submit', { kind: 'maintenance', changed: ['api/package.json'] });
    expect(names(runs)).toEqual(['api.L0.lint', 'api.L1.unit', 'api.L2.acc', 'api.L3.integ', 'api.L5.scan']);
    expect(runs.find(run => run.layer === 'L3')?.why).toBe('goal-kind');
    expect(runs.find(run => run.layer === 'L1')?.why).toBe('floor');
  });
  it('leaves out a tool a flag switches on, and a part nothing changed in', () => {
    const runs = plan('submit', { kind: 'maintenance', changed: ['web/package.json'] });
    expect(names(runs)).toEqual(['web.L1.webunit', 'web.L2.webacc']);
  });
  it('changes nothing for another kind or another stage', () => {
    expect(names(plan('submit', { changed: ['api/x.py'] }))).toEqual(['api.L0.lint', 'api.L1.unit', 'api.L2.acc']);
    expect(names(plan('integrate', { kind: 'maintenance' }))).toEqual(names(plan('integrate')));
  });
});

import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { cleanProjects, goodTests, setupDocument, testingProject } from './test-lock.test-support.js';

afterEach(cleanProjects);
const available = ['cmake', 'ctest'].every(command => spawnSync(command, ['--version']).status === 0);

it.skipIf(!available)(
  'does not lock an unrelated file whose name happens to match a CTest name',
  async () => {
    const part = setupDocument.parts.app;
    const setup = {
      ...setupDocument,
      parts: {
        app: {
          ...part,
          layers: {
            ...part.layers,
            L2: [
              {
                id: 'ctest',
                command: 'cmake -S . -B build && ctest --test-dir build --output-junit {report}',
                format: 'junit',
                testFileRequired: true,
              },
            ],
          },
          tests: { ...part.tests, paths: ['tests/**', 'host_test'] },
        },
      },
    };
    const p = await testingProject({
      setup,
      files: {
        'CMakeLists.txt':
          'cmake_minimum_required(VERSION 3.21)\nproject(proof NONE)\nenable_testing()\nadd_test(NAME host_test COMMAND ${CMAKE_COMMAND} -E true)\n',
        host_test: 'not a test source\n',
      },
    });
    const commit = p.commit(
      {
        ...goodTests(p.goalId),
        'tests/unrelated_test.cpp': 'int unrelated = 1;\n',
        [`.apos/goals/${p.goalId}/tests.json`]: JSON.stringify([
          { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['host_test::host_test'] },
        ]),
      },
      'tests',
    );
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('cannot tell which file holds this test');
  },
  120_000,
);

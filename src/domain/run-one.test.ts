import { expect, it } from 'vitest';
import { fillRunOne, runOneProblem, within } from './run-one.js';

it('fills id, classname and name, splitting at the first ::', () => {
  expect(fillRunOne('x {id} | {classname} | {name}', { id: 'a.B::c::d' }, 'linux')).toBe('x a.B::c::d | a.B | c::d');
});
it('applies modifiers left to right: vitest full name as an anchored regex', () => {
  const id = 'src/a.test.ts::add > adds (two) numbers.';
  expect(fillRunOne('-t "^{name|spaced|regex}$"', { id }, 'linux')).toBe('-t "^add adds \\\\(two\\\\) numbers\\\\.$"');
});
it('strips a trailing argument list for JUnit 5 names', () => {
  expect(fillRunOne('{classname}.{name|noparens}', { id: 'p.T::works()' }, 'linux')).toBe('p.T.works');
  expect(fillRunOne('{name|noparens}', { id: 'p.T::params[1]' }, 'linux')).toBe('params[1]');
});
it('builds a pytest node id from the file attribute, with or without a class', () => {
  const run = (id: string, file: string) => fillRunOne('"{file}::{within}{name}"', { id, file }, 'linux');
  expect(run('tests.test_calc::test_add', 'tests/test_calc.py')).toBe('"tests/test_calc.py::test_add"');
  expect(run('tests.test_calc.TestCalc::test_mul', 'tests/test_calc.py')).toBe(
    '"tests/test_calc.py::TestCalc::test_mul"',
  );
  expect(run('t.test_x.A.B::test_y[1]', 't/test_x.py')).toBe('"t/test_x.py::A::B::test_y[1]"');
  expect(within('other.Cls', 't/test_x.py')).toBe('');
});
it('escapes quotes for a double-quoted context, differently on Windows', () => {
  expect(fillRunOne('"{name}"', { id: 'f::a "q" $x' }, 'linux')).toBe('"a \\"q\\" \\$x"');
  expect(fillRunOne('"{name}"', { id: 'f::a "q"' }, 'win32')).toBe('"a \\"q\\""');
});
it('checks templates: unknown modifier, unknown placeholder, none at all', () => {
  expect(runOneProblem('run {id} {report}')).toBeUndefined();
  expect(runOneProblem('run "{file}::{within}{name|regex}"')).toBeUndefined();
  expect(runOneProblem('run {name|shout}')).toMatch(/unknown modifier \|shout/);
  expect(runOneProblem('run {nam}')).toMatch(/unknown placeholder \{nam\}/);
  expect(runOneProblem('run it')).toMatch(/needs a placeholder/);
});

import type { CatalogEntry } from './catalog.js';

/**
 * Content of the four first-wave catalog entries, as TypeScript until the file format (YAML or JSON) is
 * decided; the files in `catalog/` are generated from this.
 *
 * Verified by running the tool on this machine: pytest 9.0.2 (`--junitxml`), vitest 4.1.12 (`--reporter=junit
 * --outputFile`, `-t`). NOT verified here (no tool installed or needs project config): Gradle, Maven
 * Surefire, ruff, bandit, eslint's SARIF formatter, semgrep. A probe is what proves a command on a real
 * project; this content is only a starting point.
 */
export const STACKS: CatalogEntry[] = [
  {
    stack: 'typescript',
    notes: [
      'verified: vitest 4.1.12 (--reporter=junit --outputFile, --exclude, -t with an anchored full name; nested describe ok). Not verified: @microsoft/eslint-formatter-sarif, semgrep, tsc, Stryker (the mutation score is computed from reports/mutation/mutation.json; needs @stryker-mutator/core and the vitest runner in the project).',
    ],
    detect: { files: ['package.json'], contains: { 'package.json': '"vitest"' } },
    layers: {
      // `tsc` and `eslint` are two tools on one layer: the first is the default a draft picks.
      // Needs `@microsoft/eslint-formatter-sarif` in the project: ESLint ships no SARIF formatter.
      L0: [
        { id: 'tsc', command: 'npx tsc --noEmit', format: 'exit' },
        {
          id: 'eslint',
          command: 'npx eslint . --format @microsoft/eslint-formatter-sarif --output-file {report}',
          format: 'sarif',
        },
      ],
      L1: [
        {
          id: 'vitest',
          command:
            'npx vitest run --reporter=junit --outputFile={report} --exclude "**/*.{acceptance,integration}.test.ts"',
          format: 'junit',
        },
      ],
      L2: [
        {
          id: 'vitest-acceptance',
          command: 'npx vitest run acceptance.test --reporter=junit --outputFile={report}',
          format: 'junit',
          runOne: 'npx vitest run "{classname}" --reporter=junit --outputFile={report} -t "^{name|spaced|regex}$"',
        },
      ],
      L3: [
        {
          id: 'vitest-integration',
          command: 'npx vitest run integration.test --reporter=junit --outputFile={report}',
          format: 'junit',
          runOne: 'npx vitest run "{classname}" --reporter=junit --outputFile={report} -t "^{name|spaced|regex}$"',
        },
      ],
      L5: [
        { id: 'semgrep', command: 'semgrep scan --config auto --sarif-output={report} .', format: 'sarif' },
        {
          id: 'stryker',
          command:
            "npx stryker run --mutate \"{changed}\" --reporters json && node -e \"const r=require('./reports/mutation/mutation.json');let k=0,t=0;for(const f of Object.values(r.files))for(const m of f.mutants){if(['Ignored','CompileError','RuntimeError'].includes(m.status))continue;t++;if(['Killed','Timeout'].includes(m.status))k++}require('fs').writeFileSync('{report}',JSON.stringify({mutationScore:t?100*k/t:0}))\"",
          format: 'metric',
          metric: 'mutationScore',
          when: 'flag:mutation',
        },
      ],
    },
    loadErrorPatterns: [
      'Failed to load',
      'Cannot find module',
      'Failed to resolve import',
      'SyntaxError',
      'Transform failed',
    ],
    testPaths: ['**/*.test.ts', '**/*.spec.ts', 'tests/**'],
    testInfra: [
      'vitest.config.*',
      'vite.config.*',
      'jest.config.*',
      '**/vitest.setup.*',
      '**/setupTests.*',
      'tsconfig*.json',
    ],
    assertPatterns: ['\\bexpect\\s*\\(', '\\bassert(?:\\.\\w+)?\\s*\\(', '\\bexpectTypeOf\\s*\\('],
    notImplementedPatterns: ['[Nn]ot implemented', 'NotImplemented', 'TODO: implement'],
    entryRule: {
      importPatterns: [
        '^\\s*(?:import|export)\\b[^\'"\\n]*?\\bfrom\\s+[\'"]([^\'"]+)[\'"]',
        '^\\s*\\}\\s*from\\s+[\'"]([^\'"]+)[\'"]',
        '^\\s*import\\s+[\'"]([^\'"]+)[\'"]',
      ],
      allowImports: ['^vitest$', '^node:', '^@vitest/'],
      moduleSeparator: '/',
      moduleFiles: ['{path}.ts', '{path}.tsx', '{path}/index.ts'],
      stripExtension: '\\.(?:js|jsx|ts|tsx|mjs|cjs)$',
    },
    forbid: [
      '\\b(?:it|test|describe)\\.(?:skip|only|todo|fails)\\b',
      '\\b(?:xit|xtest|xdescribe|fit|fdescribe)\\s*\\(',
      '@ts-(?:ignore|nocheck)',
      'eslint-disable',
    ],
    needsHuman: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'tsconfig*.json',
      'eslint.config.*',
      'vitest.config.*',
      '.github/**',
    ],
  },
  {
    stack: 'python',
    notes: [
      'verified: pytest 9.0.2 (-o junit_family=xunit1 gives the file attribute; runOne by node id "file::Class::name"). Not verified: ruff (--output-format sarif), mypy, bandit, mutmut 2.x (export-cicd-stats writes mutmut-cicd-stats.json; the score is killed / total).',
    ],
    detect: { files: ['pyproject.toml'] },
    layers: {
      L0: [
        { id: 'ruff', command: 'ruff check --output-format sarif --output-file {report} .', format: 'sarif' },
        { id: 'mypy', command: 'mypy .', format: 'exit' },
      ],
      L1: [
        {
          id: 'pytest',
          command:
            'pytest -o junit_family=xunit1 --junitxml={report} --ignore=tests/acceptance --ignore=tests/integration',
          format: 'junit',
        },
      ],
      L2: [
        {
          id: 'pytest-acceptance',
          command: 'pytest -o junit_family=xunit1 tests/acceptance --junitxml={report}',
          format: 'junit',
          runOne: 'pytest -o junit_family=xunit1 "{file}::{within}{name}" --junitxml={report}',
        },
      ],
      L3: [
        {
          id: 'pytest-integration',
          command: 'pytest -o junit_family=xunit1 tests/integration --junitxml={report}',
          format: 'junit',
          runOne: 'pytest -o junit_family=xunit1 "{file}::{within}{name}" --junitxml={report}',
        },
      ],
      L5: [
        { id: 'bandit', command: 'bandit -r . -f sarif -o {report}', format: 'sarif' },
        {
          id: 'mutmut',
          command:
            "python -c \"import json,subprocess as s;s.run(['mutmut','run','--paths-to-mutate','{changed}']);s.run(['mutmut','export-cicd-stats']);d=json.load(open('mutmut-cicd-stats.json'));t=d['total'];json.dump({'mutationScore':100*d['killed']/t if t else 0},open('{report}','w'))\"",
          format: 'metric',
          metric: 'mutationScore',
          when: 'flag:mutation',
        },
      ],
    },
    loadErrorPatterns: [
      '^collection failure',
      'ImportError while importing test module',
      'ModuleNotFoundError',
      'SyntaxError',
    ],
    testPaths: ['tests/**', '**/test_*.py', '**/*_test.py'],
    testInfra: ['**/conftest.py', 'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml', '**/__init__.py'],
    assertPatterns: [
      '^\\s*assert\\b',
      '\\bself\\.assert\\w+\\s*\\(',
      '\\bpytest\\.raises\\s*\\(',
      '\\bpytest\\.warns\\s*\\(',
    ],
    notImplementedPatterns: ['NotImplementedError', 'not implemented'],
    entryRule: {
      importPatterns: [
        '^\\s*from\\s+([\\w.]+)\\s+import\\s+([^#]+)',
        '^\\s*import\\s+([\\w.]+(?:\\s+as\\s+\\w+)?(?:\\s*,\\s*[\\w.]+(?:\\s+as\\s+\\w+)?)*)',
      ],
      allowImports: [
        '^(?:__future__|abc|argparse|collections|contextlib|copy|dataclasses|datetime|decimal|enum|functools|itertools|json|logging|math|os|pathlib|pytest|random|re|shutil|string|sys|tempfile|time|typing|unittest|uuid)(?:\\.|$)',
      ],
      moduleSeparator: '.',
      moduleFiles: ['{path}.py', '{path}/__init__.py'],
    },
    forbid: [
      '@pytest\\.mark\\.(?:skip|skipif|xfail)',
      '\\bpytest\\.(?:skip|xfail)\\s*\\(',
      '@unittest\\.(?:skip|expectedFailure)',
      '#\\s*type:\\s*ignore',
      '#\\s*nosec',
    ],
    needsHuman: [
      'pyproject.toml',
      'requirements*.txt',
      'setup.py',
      'setup.cfg',
      'tox.ini',
      'pytest.ini',
      'poetry.lock',
      'uv.lock',
      '.github/**',
    ],
  },
  {
    stack: 'java-gradle',
    notes: ['Not verified on this machine: Gradle (cleanTest test --tests, report directory build/test-results/test).'],
    detect: { files: ['gradlew'] },
    layers: {
      L0: [{ id: 'compile', command: './gradlew compileJava compileTestJava', format: 'exit' }],
      // `cleanTest` first: Gradle skips an up-to-date `test`, which would give the probe's second run nothing to compare.
      // The report is a directory of XML files; the check reads every file the glob matches and merges them.
      L1: [
        {
          id: 'gradle-unit',
          command: './gradlew cleanTest test --tests "*Unit*"',
          format: 'junit',
          report: 'build/test-results/test/*.xml',
        },
      ],
      L2: [
        {
          id: 'gradle-acceptance',
          command: './gradlew cleanTest test --tests "*Acceptance*"',
          format: 'junit',
          report: 'build/test-results/test/*.xml',
          runOne: './gradlew cleanTest test --tests "{classname}.{name|noparens}"',
        },
      ],
      L3: [
        {
          id: 'gradle-integration',
          command: './gradlew cleanTest test --tests "*Integration*"',
          format: 'junit',
          report: 'build/test-results/test/*.xml',
          runOne: './gradlew cleanTest test --tests "{classname}.{name|noparens}"',
        },
      ],
    },
    loadErrorPatterns: [
      'initializationError',
      'ClassNotFoundException',
      'NoClassDefFoundError',
      'ExceptionInInitializerError',
    ],
    testPaths: ['src/test/**'],
    testInfra: ['src/test/resources/**', 'build.gradle*', 'settings.gradle*'],
    assertPatterns: [
      '\\bassert(?:That|Equals|NotEquals|True|False|Null|NotNull|Same|NotSame|Throws|ThrowsExactly|ArrayEquals|DoesNotThrow|All|Timeout)\\s*\\(',
      '\\bverify\\s*\\(',
    ],
    notImplementedPatterns: ['UnsupportedOperationException', 'NotImplementedException', 'not implemented'],
    forbid: ['@Disabled\\b', '@Ignore\\b', '@SuppressWarnings\\s*\\(\\s*"all"'],
    needsHuman: [
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'gradle.properties',
      'gradle/**',
      'gradlew',
      'gradlew.bat',
      '.github/**',
    ],
  },
  {
    stack: 'java-maven',
    notes: ['Not verified on this machine: Maven Surefire (-Dtest, -Dsurefire.failIfNoSpecifiedTests).'],
    detect: { files: ['pom.xml'] },
    layers: {
      L0: [{ id: 'compile', command: 'mvn -B -q test-compile', format: 'exit' }],
      L1: [
        {
          id: 'surefire-unit',
          command: 'mvn -B test -Dtest="*Unit*" -Dsurefire.failIfNoSpecifiedTests=false',
          format: 'junit',
          report: 'target/surefire-reports/TEST-*.xml',
        },
      ],
      L2: [
        {
          id: 'surefire-acceptance',
          command: 'mvn -B test -Dtest="*Acceptance*" -Dsurefire.failIfNoSpecifiedTests=false',
          format: 'junit',
          report: 'target/surefire-reports/TEST-*.xml',
          runOne: 'mvn -B test -Dtest="{classname}#{name|noparens}" -Dsurefire.failIfNoSpecifiedTests=false',
        },
      ],
      L3: [
        {
          id: 'surefire-integration',
          command: 'mvn -B test -Dtest="*Integration*" -Dsurefire.failIfNoSpecifiedTests=false',
          format: 'junit',
          report: 'target/surefire-reports/TEST-*.xml',
          runOne: 'mvn -B test -Dtest="{classname}#{name|noparens}" -Dsurefire.failIfNoSpecifiedTests=false',
        },
      ],
    },
    loadErrorPatterns: [
      'initializationError',
      'ClassNotFoundException',
      'NoClassDefFoundError',
      'ExceptionInInitializerError',
    ],
    testPaths: ['src/test/**'],
    testInfra: ['src/test/resources/**', 'pom.xml', '**/pom.xml'],
    assertPatterns: [
      '\\bassert(?:That|Equals|NotEquals|True|False|Null|NotNull|Same|NotSame|Throws|ThrowsExactly|ArrayEquals|DoesNotThrow|All|Timeout)\\s*\\(',
      '\\bverify\\s*\\(',
    ],
    notImplementedPatterns: ['UnsupportedOperationException', 'NotImplementedException', 'not implemented'],
    forbid: ['@Disabled\\b', '@Ignore\\b', '@SuppressWarnings\\s*\\(\\s*"all"'],
    needsHuman: ['pom.xml', '**/pom.xml', '.mvn/**', 'mvnw', 'mvnw.cmd', '.github/**'],
  },
];

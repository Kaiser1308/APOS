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
      'verified: vitest 4.1.12 (--reporter=junit --outputFile, --exclude, -t). Not verified: @microsoft/eslint-formatter-sarif, semgrep, tsc.',
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
          runOne: 'npx vitest run {classname} --reporter=junit --outputFile={report} -t "{name}"',
        },
      ],
      L3: [
        {
          id: 'vitest-integration',
          command: 'npx vitest run integration.test --reporter=junit --outputFile={report}',
          format: 'junit',
          runOne: 'npx vitest run {classname} --reporter=junit --outputFile={report} -t "{name}"',
        },
      ],
      L5: [{ id: 'semgrep', command: 'semgrep scan --config auto --sarif-output={report} .', format: 'sarif' }],
    },
    assertPatterns: ['\\bexpect\\s*\\(', '\\bassert(?:\\.\\w+)?\\s*\\(', '\\bexpectTypeOf\\s*\\('],
    notImplementedPatterns: ['[Nn]ot implemented', 'NotImplemented', 'TODO: implement'],
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
    notes: ['verified: pytest 9.0.2 (--junitxml). Not verified: ruff (--output-format sarif), mypy, bandit.'],
    detect: { files: ['pyproject.toml'] },
    layers: {
      L0: [
        { id: 'ruff', command: 'ruff check --output-format sarif --output-file {report} .', format: 'sarif' },
        { id: 'mypy', command: 'mypy .', format: 'exit' },
      ],
      L1: [
        {
          id: 'pytest',
          command: 'pytest --junitxml={report} --ignore=tests/acceptance --ignore=tests/integration',
          format: 'junit',
        },
      ],
      L2: [
        {
          id: 'pytest-acceptance',
          command: 'pytest tests/acceptance --junitxml={report}',
          format: 'junit',
          runOne: 'pytest tests/acceptance -k "{name}" --junitxml={report}',
        },
      ],
      L3: [
        {
          id: 'pytest-integration',
          command: 'pytest tests/integration --junitxml={report}',
          format: 'junit',
          runOne: 'pytest tests/integration -k "{name}" --junitxml={report}',
        },
      ],
      L5: [{ id: 'bandit', command: 'bandit -r . -f sarif -o {report}', format: 'sarif' }],
    },
    assertPatterns: [
      '^\\s*assert\\b',
      '\\bself\\.assert\\w+\\s*\\(',
      '\\bpytest\\.raises\\s*\\(',
      '\\bpytest\\.warns\\s*\\(',
    ],
    notImplementedPatterns: ['NotImplementedError', 'not implemented'],
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
          runOne: './gradlew cleanTest test --tests "{classname}.{name}"',
        },
      ],
      L3: [
        {
          id: 'gradle-integration',
          command: './gradlew cleanTest test --tests "*Integration*"',
          format: 'junit',
          report: 'build/test-results/test/*.xml',
          runOne: './gradlew cleanTest test --tests "{classname}.{name}"',
        },
      ],
    },
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
          runOne: 'mvn -B test -Dtest="{classname}#{name}" -Dsurefire.failIfNoSpecifiedTests=false',
        },
      ],
      L3: [
        {
          id: 'surefire-integration',
          command: 'mvn -B test -Dtest="*Integration*" -Dsurefire.failIfNoSpecifiedTests=false',
          format: 'junit',
          report: 'target/surefire-reports/TEST-*.xml',
          runOne: 'mvn -B test -Dtest="{classname}#{name}" -Dsurefire.failIfNoSpecifiedTests=false',
        },
      ],
    },
    assertPatterns: [
      '\\bassert(?:That|Equals|NotEquals|True|False|Null|NotNull|Same|NotSame|Throws|ThrowsExactly|ArrayEquals|DoesNotThrow|All|Timeout)\\s*\\(',
      '\\bverify\\s*\\(',
    ],
    notImplementedPatterns: ['UnsupportedOperationException', 'NotImplementedException', 'not implemented'],
    forbid: ['@Disabled\\b', '@Ignore\\b', '@SuppressWarnings\\s*\\(\\s*"all"'],
    needsHuman: ['pom.xml', '**/pom.xml', '.mvn/**', 'mvnw', 'mvnw.cmd', '.github/**'],
  },
];

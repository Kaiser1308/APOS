/** @type {import('dependency-cruiser').IConfiguration} */
const NOT_TEST = '[.](test|test-support)[.]ts$|^src/test-setup[.]ts$';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Không có vòng import ngoài src/domain/ (vòng chỉ có type trong domain/ xem rule dưới).',
      severity: 'error',
      from: { pathNot: [NOT_TEST, '^src/domain/'] },
      to: {
        circular: true,
      },
    },
    {
      name: 'no-circular-domain',
      comment: 'Trong src/domain/, vòng chỉ gồm import type được phép vĩnh viễn (O9); vòng có import giá trị thì cấm.',
      severity: 'error',
      from: { path: '^src/domain/', pathNot: NOT_TEST },
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'domain-pure',
      comment: 'domain thuần: không import tầng khác.',
      severity: 'error',
      from: { path: '^src/domain/', pathNot: NOT_TEST },
      to: { path: '^src/(ports|store|runtime|app|cli|ui)/|^src/cli' },
    },
    {
      name: 'ports-only-domain',
      comment: 'ports chỉ import domain.',
      severity: 'error',
      from: { path: '^src/ports/', pathNot: NOT_TEST },
      to: { path: '^src/', pathNot: ['^src/domain/', '^src/ports/'] },
    },
    {
      name: 'runtime-store-no-app',
      comment: 'runtime và store không import app, cli, ui.',
      severity: 'error',
      from: {
        path: '^src/(runtime|store)/',
        pathNot: [NOT_TEST],
      },
      to: { path: '^src/(app|cli|ui)/|^src/cli' },
    },
    {
      name: 'ui-read-only',
      comment: 'ui không import app và runtime, trừ app/inbox và runtime/orca (ngoại lệ vĩnh viễn, O10).',
      severity: 'error',
      from: { path: '^src/ui/', pathNot: NOT_TEST },
      to: { path: '^src/(app|runtime)/', pathNot: ['^src/app/inbox[.]ts$', '^src/runtime/orca/'] },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: NOT_TEST },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};

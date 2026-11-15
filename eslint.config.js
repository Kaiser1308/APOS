// @ts-check
import tseslint from 'typescript-eslint';

const NON_TEST_TS = ['src/**/*.ts'];
const TEST_FILES = ['src/**/*.test.ts', 'src/**/*.test-support.ts', 'src/test-setup.ts'];

const NO_AS_UNKNOWN_AS = {
  selector: "TSAsExpression > TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
  message: 'Không dùng `as unknown as`; thu hẹp kiểu bằng type guard.',
};
const NO_HAND_BUILT_EVENT = {
  selector:
    "ObjectExpression:has(Property[key.name='id'] > CallExpression[callee.name='randomUUID']):has(Property[key.name='goalId'])",
  message: 'Tạo event bằng `newEvent()` trong `src/app/events.ts`.',
};

/**
 * Vi phạm hiện có, tạm cho qua để CI xanh. Mỗi mục ghi task sẽ gỡ.
 * KHÔNG thêm mục mới; chỉ gỡ ra. Rule nào tắt ở đây thì file đó phải sửa ở task `removeAt`.
 */
const TEMPORARY_EXCEPTIONS = [
  {
    files: [
      'src/app/controller.test.ts',
      'src/app/integration.test.ts',
      'src/app/merge.test.ts',
      'src/app/metrics.test.ts',
      'src/app/registry.test.ts',
      'src/app/review.test.ts',
      'src/ui/read-model.ts',
    ],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
    removeAt: 'Task 10',
  },
  {
    files: [
      'src/app/handoff.test.ts',
      'src/app/solo.test.ts',
      'src/app/supervisor.test.ts',
      'src/app/verification.test.ts',
      'src/cli.test.ts',
    ],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
    removeAt: 'Task 10',
  },
  {
    files: ['src/app/controller.ts'],
    rules: { 'max-lines': 'off' },
    removeAt: 'Task 10',
  },
  {
    files: ['src/app/multi-supervisor.test.ts', 'src/app/supervisor.test.ts'],
    rules: { 'prefer-const': 'off' },
    removeAt: 'Task 10',
  },
];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.superpowers/', 'docs/'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: NON_TEST_TS,
    ignores: TEST_FILES,
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS, NO_HAND_BUILT_EVENT],
    },
  },
  {
    // Ngoại lệ vĩnh viễn: một reducer, xem docs/architecture/convention-refactor.md O8.
    files: ['src/domain/transitions.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // Nơi duy nhất được dựng event thủ công (Đ4); luật `as unknown as` vẫn áp dụng.
    files: ['src/app/events.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS] },
  },
  ...TEMPORARY_EXCEPTIONS.map(({ files, rules }) => ({ files, rules })),
);

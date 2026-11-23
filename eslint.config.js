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

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.superpowers/', 'docs/', 'coverage/'] },
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
      // Tests are intentionally exempt from both selectors (R4 for the event rule; `as unknown as` is simply not applied to them).
      'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS, NO_HAND_BUILT_EVENT],
    },
  },
  {
    // Ngoại lệ vĩnh viễn: một reducer, xem docs/archive/architecture/convention-refactor-v2.md O8.
    files: ['src/domain/transitions.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // Nơi duy nhất được dựng event thủ công (Đ4); luật `as unknown as` vẫn áp dụng.
    // Both selectors share the one `no-restricted-syntax` key, so any per-file override of it must re-list
    // the selector it does not intend to disable.
    files: ['src/app/events.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS] },
  },
);

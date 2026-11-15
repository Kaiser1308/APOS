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
    files: ['src/app/controller.ts'],
    rules: { 'max-lines': 'off' },
    removeAt: 'Task 10b',
  },
];

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

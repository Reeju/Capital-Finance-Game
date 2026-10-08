import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/server/data/**', 'test-results/**', 'playwright-report/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-globals': 'off',
    },
  },
  // The engine must stay deterministic: no wall clock, no Math.random.
  {
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: { 'no-restricted-syntax': ['error', { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'Use the seeded RNG streams.' }, { selector: "MemberExpression[object.name='Date']", message: 'The engine never reads the clock.' }, { selector: "NewExpression[callee.name='Date']", message: 'The engine never reads the clock.' }] },
  },
  { files: ['tests/**', '**/__tests__/**'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } },
);

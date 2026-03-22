import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/*',
      'esm/*',
      'esm_*/*',
      'eslint.config.mjs',
      '**/*.js',
      'benchmarks/*',
      'test/fakerecord.ts',
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    rules: {
      'no-underscore-dangle': 'off',
      curly: 'error',
      eqeqeq: 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true },
      ],
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      semi: ['error', 'never'],

      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],
    },
  },
)

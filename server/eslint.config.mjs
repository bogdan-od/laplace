// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['eslint.config.mjs', 'dist'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // engine.mjs replaces Date, Math.random and crypto of the whole process:
      // only app/machine/node_worker.mjs (a worker thread) may load it.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@core/*'],
              allowTypeImports: true,
              message: 'The @core alias is for types only; load the core through src/core.ts.',
            },
            {
              group: ['**/core/engine.mjs', '**/engine.mjs'],
              message:
                'engine.mjs patches the globals of its process; load it only in a worker (app/machine/node_worker.mjs).',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/engine\\.mjs$/]",
          message: 'engine.mjs must not be loaded in the server process.',
        },
        {
          selector: "ImportExpression[source.value=/engine\\.mjs$/]",
          message: 'engine.mjs must not be loaded in the server process.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      // node:test registers top-level tests itself: calling test() without await is the norm.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['test', 'it', 'describe', 'suite'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);

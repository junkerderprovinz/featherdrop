// Flat ESLint config (ESLint 10+). Replaces the legacy .eslintrc.json.
//
// Mirrors the old setup one-for-one:
//   eslint:recommended                     -> js.configs.recommended
//   plugin:@typescript-eslint/recommended  -> tseslint.configs.recommended
//   plugin:react-hooks/recommended         -> the two react-hooks rules below
//   parserOptions / env / rules            -> the shared block
//   ignorePatterns                         -> the `ignores` entry
//
// react-hooks scope: the pre-migration `plugin:react-hooks/recommended` (v5)
// enabled exactly `rules-of-hooks` (error) + `exhaustive-deps` (warn). v7's
// recommended preset additionally turns on the new opt-in React Compiler rules
// (set-state-in-effect, immutability, use-memo, purity, ...). To keep this a
// behaviour-preserving toolchain bump we run the same two rules on the v7 engine
// rather than adopting the expanded set; enabling the React Compiler rules is a
// separate, deliberate project decision.
//
// TypeScript note: the project type-checks with the TS 7 native compiler
// (devDependency `@typescript/native`, which provides the `tsc` binary), while
// typescript-eslint parses with the TS 6 JS API (the `typescript` devDependency
// is aliased to `@typescript/typescript6`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Global ignores (translated from the old `ignorePatterns`).
  { ignores: ['node_modules/**', 'client-dist/**', 'server-go/**', '.next/**', 'data/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // react-hooks/recommended coverage carried over from the old config.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Preserved from the old .eslintrc.json.
      'no-inner-declarations': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);

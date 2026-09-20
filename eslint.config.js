// react-hooks runs only rules-of-hooks and exhaustive-deps. The v7 recommended
// preset would also turn on the React Compiler rules, which this project has not
// adopted.
//
// Type checking uses the native TS 7 compiler (`@typescript/native`), while
// typescript-eslint parses with the TS 6 API that the `typescript`
// devDependency aliases.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
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
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-inner-declarations': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);

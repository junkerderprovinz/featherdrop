// Vue files are parsed by vue-eslint-parser with typescript-eslint inside
// their <script> blocks. Type checking runs through vue-tsc, while
// typescript-eslint parses with the TS 6 API that the `typescript`
// devDependency aliases.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', 'client-dist/**', 'server-go/**', 'data/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,
  vue.configs['flat/recommended'],

  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-inner-declarations': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Formatting is left to the code's own layout, as in the .ts files.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      // One-word names such as Home or Options are the screens' own names.
      'vue/multi-word-component-names': 'off',
    },
  },
);

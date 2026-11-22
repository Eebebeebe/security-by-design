// ESLint als erste, schnelle SAST-Stufe (läuft lokal + im CI).
// eslint-plugin-security findet typische Node-Fallen (eval, unsichere RegExp, child_process ...).
import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Zugriffe über validierte Schlüssel (zod) sind gewollt; sonst sehr viele False Positives.
      'security/detect-object-injection': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'script',
      parserOptions: { projectService: false, program: null },
      globals: { ...globals.browser },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Im Frontend nie HTML aus Daten bauen -> XSS. Nur textContent / createElement.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'XSS-Gefahr: textContent/createElement verwenden.' },
        { property: 'outerHTML', message: 'XSS-Gefahr: textContent/createElement verwenden.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'XSS-Gefahr: insertAdjacentHTML verboten.',
        },
      ],
    },
  },
  {
    // Tests: Response-Bodies von supertest sind untypisiert (any) – hier bewusst erlaubt.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);

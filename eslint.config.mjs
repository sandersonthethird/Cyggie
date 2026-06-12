// ESLint flat config (ESLint v9+).
//
// Scope: the desktop app source (`src/`) plus the shared workspace packages
// (`packages/`). The other pnpm workspaces — `mobile/` (Expo/React Native),
// `api-gateway/` (Node server), and `web/` — are separate packages with
// different runtime envs and should carry their own ESLint configs; they're
// ignored here so this root config stays correct for the Electron app.
//
// Run with `pnpm lint`. The `--ext` flag is gone in flat config — file
// matching is driven by the `files`/`ignores` globs below.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'

export default tseslint.config(
  {
    // This codebase was never linted before, so existing `// eslint-disable`
    // comments were written speculatively against an assumed config. Don't
    // flood output with "unused directive" noise for rules we choose not to
    // enable; real problems still surface.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/.vite/**',
      '**/coverage/**',
      // Separate workspaces — lint via their own configs, not this one.
      'mobile/**',
      'api-gateway/**',
      'web/**',
      // Generated SQL / drizzle artifacts.
      'packages/db/migrations/**',
      // Match the previous `--ext .ts,.tsx` scope: only lint TypeScript.
      // Plain JS/config/build scripts are not part of the TS project.
      '**/*.{js,jsx,cjs,mjs}',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Desktop app spans both the Electron main (Node) and renderer (browser).
      globals: { ...globals.node, ...globals.browser },
    },
    // jsx-a11y is registered (not enabled) so the codebase's existing
    // `// eslint-disable jsx-a11y/*` directives resolve to a defined rule
    // instead of erroring with "definition not found".
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      // TypeScript itself catches undefined identifiers, and core `no-undef`
      // misfires on ambient/DOM/Node globals and type-only names. Disable it on
      // TS per typescript-eslint's standard guidance.
      'no-undef': 'off',
      // The two long-standing hook rules. We intentionally do NOT use
      // react-hooks v7's `recommended-latest`, which adds the aggressive
      // React-Compiler rule suite (e.g. set-state-in-effect) that flags many
      // legitimate existing patterns as errors.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Warn-level for the high-volume legacy-debt rules the codebase already
      // sprinkles disables for — surfaces signal without failing the build on
      // a never-before-linted tree.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      // Allow intentionally-unused args/vars prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Tests may use loose typing and node globals freely.
    files: ['**/*.{test,spec}.{ts,tsx}', 'src/tests/**', '**/__tests__/**'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)

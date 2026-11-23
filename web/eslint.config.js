import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    // Vendored: installed from the shadcn / @flyingrobots registries and hash-pinned (test/fixtures/*.sha256),
    // so never hand-edited; their lint findings belong upstream.
    'src/components/ui/',
    'src/components/ai-elements/',
    'src/components/*-example.tsx',
    'src/components/markdown.tsx',
    'src/hooks/use-mobile.ts',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'react-refresh/only-export-components': 'off',
      // A destructured prop that is dropped on purpose (the next/* shims omit props an <img>/<a> must not receive).
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
])

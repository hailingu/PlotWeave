import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 原生画布的压缩脚本及 Xcode 拷贝均为生成产物；检查对应的 src 源码。
    ignores: [
      'dist',
      'coverage',
      'src-tauri',
      'native/macos/App/WebCanvas',
      'native/macos/build',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Type-aware lint entry (issue #357): enforces the `void`-prefixed
    // fire-and-forget convention automatically. Scoped to production source
    // under src/ — test files and *.test-d.ts contract probes stay on the
    // non-type-aware baseline (issue #357 defers them to a separate batch).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.test-d.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { defaultProject: './tsconfig.json' },
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
)

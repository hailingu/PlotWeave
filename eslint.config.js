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
      // react-hooks v7 的 recommended 预设在核心两条之外附带整套 React
      // Compiler 规则（refs/immutability/set-state-in-effect 等 14 条）。该
      // 规则集对本仓既有代码风格产生实质误报（如把 ref 作为 JSX 属性传递
      // `ref={props.canvasRef}` 误判为 render 期读取），且其采用与否属独立
      // 评估项；此处固定 v5 代际推荐语义的两条核心规则，维持升级前的既有
      // 强制度（issue #783）。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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

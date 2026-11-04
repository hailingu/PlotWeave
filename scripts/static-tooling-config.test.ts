/** Static tooling coverage contracts for issues #855/#856, checked through compiler/linter APIs. */
import { resolve } from 'node:path'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const eslint = new ESLint({ cwd: root })

describe('Node tooling static analysis', () => {
  it('includes every production script in the dedicated compiler program', () => {
    const path = resolve(root, 'tsconfig.scripts.json')
    const config = ts.readConfigFile(path, ts.sys.readFile)
    expect(config.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    expect(parsed.errors).toEqual([])
    const scripts = ts.sys
      .readDirectory(resolve(root, 'scripts'), ['.ts'], ['**/*.test.ts'])
      .map((file) => resolve(file))
    expect(scripts.length).toBeGreaterThan(0)
    for (const file of scripts) expect(parsed.fileNames).toContain(file)
    expect(parsed.options.noUncheckedIndexedAccess).toBe(true)
    expect(parsed.options.exactOptionalPropertyTypes).toBe(true)
    expect(parsed.options.types).toEqual(['node'])
  })

  it('applies recommended rules and Node globals to existing and future mjs scripts', async () => {
    const paths = [
      ...ts.sys.readDirectory(resolve(root, 'scripts'), ['.mjs']),
      resolve(root, 'scripts/future/probe.mjs'),
    ]
    for (const filePath of paths) {
      const results = await eslint.lintText(
        'process.exitCode = missingToolingValue\n',
        {
          filePath,
        },
      )
      expect(
        results
          .flatMap((result) => result.messages)
          .map((message) => ({
            ruleId: message.ruleId,
            messageId: message.messageId,
          })),
      ).toEqual([{ ruleId: 'no-undef', messageId: 'undef' }])
    }
  })
})

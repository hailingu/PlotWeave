/** 为脚本集成测试构造独立的真实 Git 仓库；只复用播种结果，不共享可变仓库。 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

/** 调用方可逐例删除副本；工厂最终清理自己的模板和全部副本。 */
export interface GitScenarioFixture {
  create: () => string
  dispose: () => void
}

/** 临时仓库不继承外层 Git 操作的索引、工作树或对象目录定位。 */
export function gitFixtureEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key]
  }
  return env
}

/** 一次播种，按用例复制完整仓库；不使用硬链接或 linked worktree 共享对象。 */
export function gitScenarioFixture(
  seed: (root: string) => void,
): GitScenarioFixture {
  const roots: string[] = []
  let template: string | undefined
  return {
    create: () => {
      if (template === undefined) {
        const candidate = mkdtempSync(resolve(tmpdir(), 'plotweave-git-seed-'))
        try {
          seed(candidate)
          template = candidate
          roots.push(candidate)
        } catch (error) {
          rmSync(candidate, { recursive: true, force: true })
          throw error
        }
      }
      const root = mkdtempSync(resolve(tmpdir(), 'plotweave-git-scenario-'))
      roots.push(root)
      cpSync(template, root, { recursive: true })
      return root
    },
    dispose: () => {
      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
      }
      template = undefined
    },
  }
}

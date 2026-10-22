/**
 * #504 的共享媒体生命周期所有权契约：编译器解析 mediaUrl 的实际调用
 * 签名，两个节点的依赖闭包只能由 useAssetMedia 发起项目媒体读取。
 * 不匹配源码措辞、函数布局或调用点的拼写，别名调用也按签名归属识别。
 */
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

/** 用仓库的编译配置检查两个节点闭包内项目媒体调用的实现所有者。 */
function mediaRequestOwners(): string[] {
  const configPath = resolve(repositoryRoot, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error('无法读取媒体契约的 TypeScript 配置')
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    repositoryRoot,
  )
  const program = ts.createProgram(
    ['ImageNode.tsx', 'ShotNode.tsx'].map((name) =>
      resolve(import.meta.dirname, name),
    ),
    parsed.options,
  )
  const checker = program.getTypeChecker()
  const assets = program.getSourceFile(
    resolve(repositoryRoot, 'src/editor/projectAssets.ts'),
  )
  if (!assets) throw new Error('项目媒体门面未进入节点依赖闭包')
  const module = checker.getSymbolAtLocation(assets)
  const facade =
    module &&
    checker
      .getExportsOfModule(module)
      .find((symbol) => symbol.name === 'projectAssets')
  const media =
    facade &&
    checker.getTypeOfSymbolAtLocation(facade, assets).getProperty('mediaUrl')
  if (!media?.valueDeclaration) throw new Error('项目媒体门面未导出 mediaUrl')
  const owners = new Set<string>()
  for (const source of program.getSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        checker.getResolvedSignature(node)?.declaration?.parent ===
          media.valueDeclaration
      ) {
        owners.add(relative(repositoryRoot, source.fileName))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...owners].sort()
}

it('两节点的项目媒体请求只有共享生命周期一个实现所有者（#504）', () => {
  expect(mediaRequestOwners()).toEqual(['src/editor/nodes/useAssetMedia.ts'])
})

/**
 * sheetToken 契约测试的共享用例数据表（issue #538）：同一错误码/同一入口的
 * 合成夹具矩阵原先在 sheetTokenBoundaries / sheetTokenContractFamilies /
 * sheetTokensSemantics / sheetTokenReferences 四个测试文件间重复维护，
 * 现收敛为单一事实源表，由各入口从同表驱动。本模块只承载用例数据与
 * 维度注释，不持有断言逻辑——期望行为仍由各测试文件按其入口表达。
 * 与 sheetTokensEngine 等同属测试设施（issue #311 归类，sonar
 * 「源码排除 + 测试纳入」组合，导入者只能是测试文件或测试设施）。
 */

/** F1 全局所有权拒绝场景：`[选择器, 是否包裹在失活媒体内]`。
 *
 * 一维是「可能命中文档根的全局选择器形态」（简单选择器与组合器链合并），
 * 另一维是失活 `@media` 包裹——所有权拒绝发生在来源校验层，先于媒体
 * 求值，两个维度合用一张表；四扫描入口（`sheetDecls`、
 * `localDefinitions`、`danglingRefs`、`displayTypeErrors`）共用同一
 * TOKEN_GLOBAL_OUTSIDE_SOURCE 断言形，由 sheetTokenContractFamilies 驱动。
 */
export const GLOBAL_OWNERSHIP_REJECTION_CASES: readonly (readonly [
  selector: string,
  inInactiveMedia: boolean,
])[] = [
  [':root', false],
  ['html', false],
  ['body', false],
  ['*', false],
  ['.card, :root', false],
  [':root.dark', false],
  ['body[data-theme="dark"]', false],
  [':root', true],
  ['html > body', true],
  ['html>body', true],
  [':root body', true],
  ['HTML > BODY[data-theme="dark"]', true],
  ['.unused, html > body', true],
  [':root > *', true],
  ['html > body > *', true],
  ['html[data-note="a > b"] > body', true],
]

/** TOKEN_ROOT_SELECTOR_UNMODELED 选择器：可能命中文档根、但取值未建模的
 * 分支（含组合器链形态），经 `tokenValuesOf` 在令牌源上统一拒绝；由
 * sheetTokenBoundaries 的根分支套件驱动（原 sheetTokenContractFamilies
 * F1-b 两条组合器用例已并入，issue #538）。 */
export const ROOT_SELECTOR_UNMODELED_SELECTORS: readonly string[] = [
  'html',
  'body',
  '*',
  ':root.dark',
  ':root, html',
  ':is(:root)',
  ':root .child',
  'html > body',
  'html > body > *',
]

/** `isDisplayColorProp` 分类枚举：`[属性名, 是否承载展示色]`。
 *
 * border 全系简写/长形（四向与逻辑方向）、`-color` 长形（含厂商前缀与
 * scrollbar/stop-color）、图像/强调/描边入口为 true；box-shadow、尺寸类、
 * 非颜色长形与自定义属性为 false。原分设在 sheetTokensSemantics（结构
 * 覆盖）与 sheetTokenBoundaries（F6 分类）两处且集合交叉，现并为一张
 * 表，由 sheetTokensSemantics 驱动（issue #538）。 */
export const DISPLAY_COLOR_PROP_CASES: readonly (readonly [
  prop: string,
  carriesDisplayColor: boolean,
])[] = [
  ['border', true],
  ['border-top', true],
  ['border-left', true],
  ['border-inline-start', true],
  ['border-block-end-color', true],
  ['border-color', true],
  ['border-image', true],
  ['border-image-source', true],
  ['outline', true],
  ['fill', true],
  ['stroke', true],
  ['background', true],
  ['background-color', true],
  ['background-image', true],
  ['text-shadow', true],
  ['text-emphasis-color', true],
  ['text-emphasis', true],
  ['scrollbar-color', true],
  ['-webkit-text-fill-color', true],
  ['stop-color', true],
  ['-webkit-text-stroke', true],
  ['box-shadow', false],
  ['border-width', false],
  ['border-radius', false],
  ['border-top-width', false],
  ['border-image-width', false],
  ['border-image-slice', false],
  ['mask-image', false],
  ['padding', false],
  ['--xy-controls-button-color', false],
  ['color-scheme', false],
  ['text-emphasis-style', false],
  ['-webkit-text-stroke-width', false],
]

/** CSS-wide 关键字判定边界用例（issue #339）：`值 × CSS 空白下是否为关键字`。
 *
 * `cssWide: true` 的值经 CSS 空白集裁剪后是 CSS-wide 关键字（引擎按
 * 保证无效/未建模分支处理，类型入口认作合法整值关键字）；false 的值因
 * NBSP（U+00A0，非 CSS 空白的有效标识符码点）粘住关键字，是普通标识符，
 * 任何关键字分支都不得触发。供 `resolveChain`（sheetTokenReferences）
 * 与 `colorTypeOk`（sheetTokensSemantics）两个入口从同表驱动。 */
export interface CssWideKeywordBoundaryCase {
  readonly value: string
  readonly cssWide: boolean
}

/** NBSP 包围与普通 CSS 空白对照的整值关键字判定矩阵（issue #339）。 */
export const CSS_WIDE_KEYWORD_BOUNDARY_CASES: readonly CssWideKeywordBoundaryCase[] =
  [
    { value: '\u00a0unset', cssWide: false },
    { value: 'unset\u00a0', cssWide: false },
    { value: '\u00a0initial\u00a0', cssWide: false },
    { value: '\u00a0inherit\u00a0', cssWide: false },
    { value: '\u00a0revert\u00a0', cssWide: false },
    { value: '\u00a0revert-layer\u00a0', cssWide: false },
    { value: ' \tunset\n', cssWide: true },
    { value: ' UNSET ', cssWide: true },
    { value: ' initial ', cssWide: true },
  ]

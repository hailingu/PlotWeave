/**
 * 应用引导入口（issue #358 评审 5326220397）：ES 模块先求值全部静态
 * 导入再执行模块体——若守卫装在 main.tsx 里，应用导入图（App、
 * ErrorBoundary、libraryDiagnosticTransport 及其传递依赖）顶层求值期
 * 的抛错会发生在守卫安装之前，引导失败拿不到承诺的结构化诊断。
 * 本模块自身仅依赖 globalErrorGuard（纯定义无传递边），先安装全局
 * 兜底，再动态加载应用本体；动态导入的求值失败以未处理拒绝形态被
 * 同一守卫捕获。index.html 直接加载本文件。
 */
import { installGlobalErrorGuard } from './globalErrorGuard'

installGlobalErrorGuard()

void import('./main')

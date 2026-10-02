#!/bin/sh
# Rust 模块图守卫的元守卫（issue #471）：src-tauri 的文件粒度无环守卫
# （src-tauri/src/module_graph.rs 及其子模块，见 rust-standard.md
# 「Module Boundary Guards」）以 lib.rs 的 `#[cfg(test)] mod module_graph;`
# 为唯一挂载点——删除该行（或等价地清空模块用例）会让全部守卫测试
# 静默消失，而 cargo test 依旧全绿。本脚本以工具链自己的测试枚举为
# 语义依据：读取 `cargo test --lib -- --list` 的实际输出（rustc 测试
# 装载器枚举出的用例全名），断言 `module_graph::` 前缀用例数不低于
# 存活下限；不对 lib.rs 普通文本做出现次数断言（issue #471 验收标准）。
# 挂接在门禁的串行 Rust 阶段与 CI 的 rust 任务——只在 cargo 已就绪或
# 本就串行的位置运行，绝不进并行 vitest 套件：冷 cargo 构建的全核
# rustc 会饿死同样 spawn 子进程的兄弟测试（0e80937 推送实测 8 例超时）。
# cargo 不可用或列举失败均判失败（fail-closed）。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 门禁根覆盖（issue #405）：与 sonar-quality-gate.sh 同源的注入点——
# pre-push 慢路径经 PLOTWEAVE_GATE_REPOSITORY_ROOT 在被推提交的临时
# 检出树上执行元检查。
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}
# cargo 替换注入点：与 PLOTWEAVE_*_BIN 同类的测试/钩子注入点（见
# docs/development/quality-gate-cost.md）。
cargo_bin=${PLOTWEAVE_CARGO_BIN:-cargo}
# 守卫用例存活下限（issue #471 方案 A）：防「整建制静默消失」——删除
# 挂载点或清空模块即归零触发。非精确跟踪值（落地时的当前值为 122），
# 守卫合理缩减跌破下限时，须连同本下限与 rust-standard.md 的元守卫
# 条目一并有意识更新，不得顺手调低放行。
guard_test_floor=90

cd "$repository_root"

# 输出一致的阻塞原因并终止。
fail() {
  printf '模块图守卫元检查失败：%s\n' "$1" >&2
  exit 1
}

command -v "$cargo_bin" >/dev/null 2>&1 ||
  # $var 后不得紧跟多字节字符（macOS /bin/sh 即 bash 3.2 会并入变量名判
  # unbound），故变量置于消息末尾（与 rust-coverage.sh 同约定）
  fail "缺少命令：$cargo_bin"

# 合并捕获 stdout 与 stderr：成功时编译进度等 stderr 噪音不匹配计数
# 模式、无害；失败时尾部诊断随后输出，编译错误不因此静默。
if ! listing=$("$cargo_bin" test --lib --manifest-path src-tauri/Cargo.toml -- --list 2>&1); then
  printf '%s\n' "$listing" | tail -n 40 >&2
  fail 'cargo test --lib -- --list 失败（工具链或编译错误，尾部诊断见上）'
fi

# 计数锚定行首 `module_graph::` 前缀与行尾 `: test`：cargo 的位置参数
# 过滤是路径子串匹配，无关用例会混入计数稀释判别力，故取全量清单在
# 本脚本侧过滤。grep -c 零命中退出码为 1，set -e 下吸收为 0 再比较。
count=$(printf '%s\n' "$listing" | grep -c '^module_graph::.*: test$') || count=0

[ "$count" -ge "$guard_test_floor" ] ||
  # ${guard_test_floor} 用括号形式收尾：其后紧跟多字节标点时，macOS
  # /bin/sh（bash 3.2）会把多字节字符并入变量名判 unbound（本仓库既有约定）
  fail "守卫用例数 $count 跌破存活下限 ${guard_test_floor}: lib.rs 挂载点 #[cfg(test)] mod module_graph 被移除或模块被清空？（issue #471）"

printf '[meta-guard] 模块图守卫元检查通过：%s 个 module_graph:: 用例（存活下限 %s，issue #471）。\n' \
  "$count" "$guard_test_floor"

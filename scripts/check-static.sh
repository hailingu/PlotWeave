#!/bin/sh
# 静态检查共享入口（issue #227）：格式（Prettier）、lint（ESLint 零警告）、
# 文件规模（issue #432）与严格类型检查（issues #230/#231：noUncheckedIndexedAccess +
# exactOptionalPropertyTypes，生产源码范围，含 *.test-d.ts 契约探针）
# ——本地 Git 门禁与手动检查同一入口，任一失败即非零退出（子项输出自身
# 诊断）。保留既有 SonarQube 门禁：本入口在覆盖率生成之前 fail-fast。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 门禁根覆盖（issue #405）：与 sonar-quality-gate.sh 同源的注入点——
# pre-push 慢路径经 PLOTWEAVE_GATE_REPOSITORY_ROOT 让本入口（当前副本）
# 在被推提交的临时检出树上执行。
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}

npm_bin=${PLOTWEAVE_NPM_BIN:-npm}
node_bin=${PLOTWEAVE_NODE_BIN:-node}

cd "$repository_root"

printf '%s\n' '[check-static] Prettier 格式检查……'
"$npm_bin" run format:check

printf '%s\n' '[check-static] ESLint 零警告检查……'
"$npm_bin" run lint -- --max-warnings=0

printf '%s\n' '[check-static] 维护源码文件规模检查……'
"$node_bin" "$script_directory/check-file-size.ts"

printf '%s\n' '[check-static] 严格类型检查（索引访问 + 可选字段存在性）……'
"$npm_bin" run typecheck:strict

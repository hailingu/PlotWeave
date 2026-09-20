#!/bin/sh
# 静态检查共享入口（issue #227）：格式（Prettier）、lint（ESLint 零警告）
# 与严格类型检查（issues #230/#231：noUncheckedIndexedAccess +
# exactOptionalPropertyTypes，生产源码范围，含 *.test-d.ts 契约探针）
# ——本地 Git 门禁与手动检查同一入口，任一失败即非零退出（子项输出自身
# 诊断）。保留既有 SonarQube 门禁：本入口在覆盖率生成之前 fail-fast。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)

npm_bin=${PLOTWEAVE_NPM_BIN:-npm}

cd "$repository_root"

printf '%s\n' '[check-static] Prettier 格式检查……'
"$npm_bin" run format:check

printf '%s\n' '[check-static] ESLint 零警告检查……'
"$npm_bin" run lint -- --max-warnings=0

printf '%s\n' '[check-static] 严格类型检查（索引访问 + 可选字段存在性）……'
"$npm_bin" run typecheck:strict

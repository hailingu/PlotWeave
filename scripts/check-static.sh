#!/bin/sh
# 静态检查共享入口（issue #227）：格式（Prettier）与 lint（ESLint 零警告）
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

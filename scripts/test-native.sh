#!/bin/sh
# 原生公共入口：功能回归采集 App 覆盖率，stress 保留原规模且关闭 instrumentation。
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}
mode=${1:-regression}
case $mode in
  regression) stress_enabled=0 ;;
  stress|first-drag) stress_enabled=1 ;;
  *) printf '[NATIVE_TEST_MODE_INVALID] 用法：sh scripts/test-native.sh [regression|stress|first-drag]\n' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf '[NATIVE_TEST_ARGUMENTS_INVALID] 原生测试入口只接受一个模式参数。\n' >&2
  exit 2
fi
native_jobs=${PLOTWEAVE_GATE_CPU_BUDGET:-4}
case $native_jobs in
  *[!0-9]*|'') printf '[GATE_CPU_BUDGET_INVALID] 原生构建预算须为正整数。\n' >&2; exit 2 ;;
esac
if ! [ "$native_jobs" -ge 1 ] 2>/dev/null; then
  printf '[GATE_CPU_BUDGET_INVALID] 原生构建预算须为正整数。\n' >&2
  exit 2
fi

cd "$repository_root"
coverage_directory="$repository_root/native/macos/build/coverage"
if [ "$mode" = regression ]; then
  mkdir -p "$coverage_directory"
  # 本入口拥有的报告先失效，构建/测试失败时不能留下伪装为本轮的旧摘要。
  rm -f "$coverage_directory/coverage-summary.json" "$coverage_directory/coverage-summary.md" "$coverage_directory/xccov.json"
fi
"${PLOTWEAVE_NPM_BIN:-npm}" run build:native-canvas
set -- -project native/macos/PlotWeaveNative.xcodeproj \
  -scheme PlotWeaveNative -destination 'platform=macOS' \
  -derivedDataPath native/macos/build/DerivedData -jobs "$native_jobs"
TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=$stress_enabled
export TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS
printf '[native-tests] 模式：%s（串行；构建预算 %s）\n' "$mode" "$native_jobs"
if [ "$mode" = stress ]; then
  set -- "$@" -enableCodeCoverage NO \
    '-only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests' \
    '-only-testing:PlotWeaveNativeTests/WebCanvasFirstDragLatencyTests/sameNodeFirstAndSecondDragRecordStartupEvidence()'
  exec "${PLOTWEAVE_XCODEBUILD_BIN:-xcodebuild}" "$@" -parallel-testing-enabled NO test
fi

# 单独选择首拖证据，避免为小图交互调查启动大图和长循环（issue #688）。
if [ "$mode" = first-drag ]; then
  exec "${PLOTWEAVE_XCODEBUILD_BIN:-xcodebuild}" "$@" -enableCodeCoverage NO \
    '-only-testing:PlotWeaveNativeTests/WebCanvasFirstDragLatencyTests' \
    -parallel-testing-enabled NO test
fi

# 每轮独立结果目录；成功后删除大体积 bundle，失败时保留诊断取证。
coverage_run=$(mktemp -d "$repository_root/native/macos/build/native-coverage.XXXXXX")
cleanup_coverage() {
  native_status=$?
  trap - 0 HUP INT TERM
  if [ "$native_status" -eq 0 ]; then
    rm -rf "$coverage_run"
  else
    printf '[NATIVE_COVERAGE_DIAGNOSTICS] 保留本轮结果：%s\n' "$coverage_run" >&2
  fi
  exit "$native_status"
}
trap cleanup_coverage 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
set -- "$@" -enableCodeCoverage YES -resultBundlePath "$coverage_run/NativeTests.xcresult"
"${PLOTWEAVE_XCODEBUILD_BIN:-xcodebuild}" "$@" -parallel-testing-enabled NO test
"${PLOTWEAVE_XCRUN_BIN:-xcrun}" xccov view --report --json "$coverage_run/NativeTests.xcresult" > "$coverage_run/xccov.json"
"${PLOTWEAVE_NODE_BIN:-node}" "$script_directory/native-coverage.ts" "$coverage_run/xccov.json" "$repository_root" "$coverage_directory" "${PLOTWEAVE_NATIVE_MIN_LINE_COVERAGE:-}"

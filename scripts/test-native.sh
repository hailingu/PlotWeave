#!/bin/sh
# 原生测试公共入口：默认保留功能回归，stress 显式运行原规模压力/性能测量。
# 选择契约见 quality-gate-push.md「Native Regression And Stress」。
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}
mode=${1:-regression}
case $mode in
  regression) stress_enabled=0 ;;
  stress) stress_enabled=1 ;;
  *) printf '[NATIVE_TEST_MODE_INVALID] 用法：sh scripts/test-native.sh [regression|stress]\n' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  printf '[NATIVE_TEST_ARGUMENTS_INVALID] 原生测试入口只接受一个模式参数。\n' >&2
  exit 2
fi

cd "$repository_root"
"${PLOTWEAVE_NPM_BIN:-npm}" run build:native-canvas
set -- -project native/macos/PlotWeaveNative.xcodeproj \
  -scheme PlotWeaveNative -destination 'platform=macOS' \
  -derivedDataPath native/macos/build/DerivedData
if [ "$mode" = stress ]; then
  # 用完整套件选择参数化测量；保留同套件的轻量报告校验。
  set -- "$@" '-only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests' \
    '-only-testing:PlotWeaveNativeTests/WebCanvasFirstDragLatencyTests/sameNodeFirstAndSecondDragRecordStartupEvidence()'
fi
printf '[native-tests] 模式：%s（窗口/焦点回归串行运行）\n' "$mode"
TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=$stress_enabled
export TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS
exec "${PLOTWEAVE_XCODEBUILD_BIN:-xcodebuild}" "$@" -parallel-testing-enabled NO test

//! WebContent 前后进程集合的纯归属规则。

use std::collections::HashSet;

/// 只接受恰好一个新 WebContent PID；空或多元素差集不得进入内存证据。
pub fn new_page_pids(
    baseline: &HashSet<i32>,
    current: &HashSet<i32>,
) -> Result<HashSet<i32>, String> {
    let candidates: HashSet<i32> = current.difference(baseline).copied().collect();
    if candidates.len() == 1 {
        Ok(candidates)
    } else {
        Err(format!("PW_PERF_WEBCONTENT_AMBIGUOUS:{}", candidates.len()))
    }
}

//! macOS 公开 proc API 的 WebContent 归属与常驻内存采样（issue #572）。

use std::collections::HashSet;
use std::mem::{size_of, MaybeUninit};

/// 宿主与已归属 WebContent 进程的一次常驻内存快照。
#[derive(Clone)]
pub struct MemorySample {
    app_resident_bytes: u64,
    web_content_resident_bytes: u64,
    web_content_process_count: usize,
}

impl MemorySample {
    /// 与 Swift WebProcessMemorySample.description 相同的证据文本。
    pub fn description(&self) -> String {
        const MB: f64 = 1_048_576.0;
        format!(
            "app={:.1}MB web(sum)={:.1}MB webProcesses={}",
            self.app_resident_bytes as f64 / MB,
            self.web_content_resident_bytes as f64 / MB,
            self.web_content_process_count
        )
    }
}

/// 枚举当前所有完整进程名包含 WebContent 的 PID。
pub fn web_content_pids() -> HashSet<i32> {
    let needed = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return HashSet::new();
    }
    let slots = needed as usize + 64;
    let mut pids = vec![0 as libc::pid_t; slots];
    let bytes = (slots * size_of::<libc::pid_t>()) as i32;
    let written = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if written <= 0 {
        return HashSet::new();
    }
    pids.iter()
        .take((written as usize).min(slots))
        .filter(|pid| **pid > 0)
        .filter(|pid| process_name(**pid).is_some_and(|name| name.contains("WebContent")))
        .copied()
        .collect()
}

/// 以系统当前进程集合建立单元素页面归属。
pub fn page_web_content_pids(baseline: &HashSet<i32>) -> Result<HashSet<i32>, String> {
    crate::attribution::new_page_pids(baseline, &web_content_pids())
}

/// 汇总宿主与已归属 WebContent 进程 RSS；任一进程不可读都使证据失败。
pub fn sample(tracking: &HashSet<i32>) -> Result<MemorySample, String> {
    let app_resident_bytes = resident_bytes(std::process::id() as i32)
        .ok_or_else(|| "PW_PERF_HOST_RSS_UNAVAILABLE".to_string())?;
    let mut web_content_resident_bytes = 0;
    let mut web_content_process_count = 0;
    for pid in tracking {
        let bytes = resident_bytes(*pid)
            .ok_or_else(|| format!("PW_PERF_WEBCONTENT_RSS_UNAVAILABLE:{pid}"))?;
        web_content_resident_bytes += bytes;
        web_content_process_count += 1;
    }
    Ok(MemorySample {
        app_resident_bytes,
        web_content_resident_bytes,
        web_content_process_count,
    })
}

fn process_name(pid: i32) -> Option<String> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: info 提供 size 字节的可写存储；仅在接口确认完整写入后读取。
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: 上一个检查保证 proc_pidinfo 已初始化完整结构体。
    let info = unsafe { info.assume_init() };
    let bytes: Vec<u8> = info
        .pbi_name
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn resident_bytes(pid: i32) -> Option<u64> {
    let mut info = MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = size_of::<libc::proc_taskinfo>() as i32;
    // SAFETY: info 提供 size 字节的可写存储；仅在接口确认完整写入后读取。
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: 上一个检查保证 proc_pidinfo 已初始化完整结构体。
    Some(unsafe { info.assume_init() }.pti_resident_size)
}

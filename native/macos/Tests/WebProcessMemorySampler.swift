import AppKit

/// Samples resident memory of the hosting app and its WebContent (page)
/// processes (plan §7.2 / matrix M15, issue #523). On this macOS generation
/// WebContent processes are re-parented to launchd, so ownership cannot come
/// from `pbi_ppid`; attribution uses a before/after diff of every
/// `com.apple.WebKit.WebContent` pid on the machine — the processes that
/// appear after this test loads its page are the page's. Public process APIs
/// only: `proc_listallpids` + `proc_pidinfo`.
struct WebProcessMemorySample: Equatable {

    /// Resident bytes of the hosting app process itself.
    let appResidentBytes: UInt64

    /// Summed resident bytes of the tracked WebContent (page) processes.
    let webContentResidentBytes: UInt64

    /// Number of tracked WebContent processes still alive; zero means the
    /// tracked page processes all exited (or were never attributed).
    let webContentProcessCount: Int

    /// Megabyte rounding for human-readable gate logs and evidence records.
    var description: String {
        let mb = 1_048_576.0
        return String(
            format: "app=%.1fMB web(sum)=%.1fMB webProcesses=%d",
            Double(appResidentBytes) / mb,
            Double(webContentResidentBytes) / mb,
            webContentProcessCount
        )
    }
}

/// One-shot sampler; stateless, safe to call from the main actor between waits.
enum WebProcessMemorySampler {

    /// Every live `com.apple.WebKit.WebContent` pid on the machine.
    static func webContentPids() -> Set<Int32> {
        let capacity = proc_listallpids(nil, 0)
        guard capacity > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(capacity))
        let written = proc_listallpids(&pids, capacity)
        guard written > 0 else { return [] }
        var webPids: Set<Int32> = []
        for index in 0..<Int(written) {
            let pid = pids[index]
            guard pid > 0 else { continue }
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { continue }
            // pbi_comm truncates to 16 chars ("com.apple.WebKi…"); pbi_name
            // keeps the full executable name needed to match WebContent.
            let name = withUnsafeBytes(of: info.pbi_name) { raw -> String in
                String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
            }
            if name.contains("WebContent") { webPids.insert(pid) }
        }
        return webPids
    }

    /// WebContent pids that appeared since `baseline` — this test's page.
    static func pageWebContentPids(since baseline: Set<Int32>) -> Set<Int32> {
        webContentPids().subtracting(baseline)
    }

    /// Reads the app's resident size plus the still-alive tracked processes.
    static func sample(tracking: Set<Int32>) -> WebProcessMemorySample {
        var webBytes: UInt64 = 0
        var webCount = 0
        for pid in tracking {
            let bytes = residentBytes(pid: pid)
            if bytes > 0 {
                webBytes += bytes
                webCount += 1
            }
        }
        return WebProcessMemorySample(
            appResidentBytes: residentBytes(pid: getpid()),
            webContentResidentBytes: webBytes,
            webContentProcessCount: webCount
        )
    }

    /// Resident size of one process; exited or unreadable processes report 0.
    private static func residentBytes(pid: Int32) -> UInt64 {
        var info = proc_taskinfo()
        let result = proc_pidinfo(
            pid, PROC_PIDTASKINFO, 0, &info, Int32(MemoryLayout<proc_taskinfo>.size)
        )
        guard result == Int32(MemoryLayout<proc_taskinfo>.size) else { return 0 }
        return info.pti_resident_size
    }
}

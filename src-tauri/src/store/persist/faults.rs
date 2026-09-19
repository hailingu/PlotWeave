//! 原子写测试夹具：线程隔离的单阶段 I/O 故障及临时文件碰撞。
//! 只替换指定阶段，其余创建、写入、同步和改名仍在真实文件系统执行。

use std::cell::RefCell;
use std::io;

/// 数据模型 §10.2 持久化协议中的系统 I/O 阶段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    Create,
    Write,
    FileSync,
    Rename,
    #[cfg(unix)]
    DirectorySync,
    #[cfg(unix)]
    EntrySync,
    #[cfg(unix)]
    AnchorProbe,
}

#[derive(Default)]
struct State {
    fail: Option<Stage>,
    temp_name: Option<String>,
    stages: Vec<Stage>,
    probe: Option<(Stage, Box<dyn FnOnce() + Send>)>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// 当前线程的注入作用域；析构复位，断言失败也不污染之后的测试。
pub(crate) struct Injection;

impl Injection {
    /// 设置一次测试的失败阶段或指定碰撞文件名；两者均为空时仅记录阶段。
    pub(crate) fn new(fail: Option<Stage>, temp_name: Option<&str>) -> Self {
        STATE.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(slot.is_none(), "不允许嵌套原子写故障注入");
            *slot = Some(State {
                fail,
                temp_name: temp_name.map(str::to_owned),
                ..State::default()
            });
        });
        Self
    }

    /// 返回实际抵达的协议阶段，用于验证屏障与改名的顺序契约。
    pub(crate) fn stages(&self) -> Vec<Stage> {
        STATE.with(|slot| slot.borrow().as_ref().unwrap().stages.clone())
    }

    /// 仅挂协议阶段探针的注入（不注入失败）：抵达指定阶段时执行一次
    /// `probe`——例如在 rename 前回拨临时文件 mtime 模拟挂起恢复/时钟
    /// 前跳，或暂停写入线程与另一线程的清扫做确定性协同。
    pub(crate) fn with_probe(stage: Stage, probe: impl FnOnce() + Send + 'static) -> Self {
        STATE.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(slot.is_none(), "不允许嵌套原子写故障注入");
            *slot = Some(State {
                probe: Some((stage, Box::new(probe))),
                ..State::default()
            });
        });
        Self
    }
}

impl Drop for Injection {
    fn drop(&mut self) {
        STATE.with(|slot| *slot.borrow_mut() = None);
    }
}

/// 包住单个真实系统调用；模拟磁盘/同步失败，保留其余阶段的副作用。
/// 抵达挂有探针的阶段时先执行探针（探针可观察/修改真实文件系统状态、
/// 参与跨线程协同），再按注入判定失败或执行原操作。
pub(super) fn run<T>(stage: Stage, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    let (fail, probe) = STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return (false, None);
        };
        state.stages.push(stage);
        let probe = if matches!(&state.probe, Some((s, _)) if *s == stage) {
            state.probe.take().map(|(_, p)| p)
        } else {
            None
        };
        (state.fail == Some(stage), probe)
    });
    if let Some(probe) = probe {
        probe();
    }
    if fail {
        Err(io::Error::other(format!("injected {stage:?} failure")))
    } else {
        operation()
    }
}

/// 覆盖本次随机临时名以稳定触发 O_EXCL 碰撞，不改变真实创建与清理操作。
pub(super) fn temp_name(generated: String) -> String {
    STATE.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|state| state.temp_name.clone())
            .unwrap_or(generated)
    })
}

/// 仅判定指定阶段的失败注入，不记录协议阶段：探测类辅助调用不属于
/// §10.2 协议序，进入 `stages` 会污染顺序契约断言。
pub(super) fn fail_at(stage: Stage) -> Option<io::Error> {
    STATE.with(|slot| {
        let slot = slot.borrow();
        if matches!(slot.as_ref(), Some(state) if state.fail == Some(stage)) {
            Some(io::Error::other(format!("injected {stage:?} failure")))
        } else {
            None
        }
    })
}

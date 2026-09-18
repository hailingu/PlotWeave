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
}

#[derive(Default)]
struct State {
    fail: Option<Stage>,
    temp_name: Option<String>,
    stages: Vec<Stage>,
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
}

impl Drop for Injection {
    fn drop(&mut self) {
        STATE.with(|slot| *slot.borrow_mut() = None);
    }
}

/// 包住单个真实系统调用；模拟磁盘/同步失败，保留其余阶段的副作用。
pub(super) fn run<T>(stage: Stage, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    let fail = STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return false;
        };
        state.stages.push(stage);
        state.fail == Some(stage)
    });
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

//! module_graph 守卫的环检测层（issue #399；仅测试构建参与编译）：
//! Tarjan 强连通分量 + 成员内 DFS 回路，产出可读环路径——口径对齐前端
//! `cyclesOf`（非平凡 SCC 各一条路径，自环已在建边时剔除）。

use std::collections::{BTreeMap, BTreeSet};

use super::ModuleKey;

/// Tarjan 状态机（strong_components 的载体，模块级定义——嵌套函数的
/// 复杂度会计入外层）。
struct Tarjan<'a> {
    edges: &'a BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
    index: BTreeMap<ModuleKey, usize>,
    low: BTreeMap<ModuleKey, usize>,
    on_stack: BTreeSet<ModuleKey>,
    stack: Vec<ModuleKey>,
    sccs: Vec<Vec<ModuleKey>>,
    counter: usize,
}

impl Tarjan<'_> {
    /// 标准 Tarjan 递归体：入栈 v、下钻未访问邻居、回填 low，根节点弹栈。
    fn strongconnect(&mut self, v: &ModuleKey) {
        self.index.insert(v.clone(), self.counter);
        self.low.insert(v.clone(), self.counter);
        self.counter += 1;
        self.stack.push(v.clone());
        self.on_stack.insert(v.clone());
        let neighbors: Vec<ModuleKey> = self.edges[v].iter().cloned().collect();
        for w in neighbors {
            if !self.index.contains_key(&w) {
                self.strongconnect(&w);
                let lifted = self.low[&w].min(self.low[v]);
                self.low.insert(v.clone(), lifted);
            } else if self.on_stack.contains(&w) {
                let lifted = self.index[&w].min(self.low[v]);
                self.low.insert(v.clone(), lifted);
            }
        }
        if self.low[v] == self.index[v] {
            let mut scc: Vec<ModuleKey> = Vec::new();
            while let Some(top) = self.stack.pop() {
                self.on_stack.remove(&top);
                scc.push(top.clone());
                if &top == v {
                    break;
                }
            }
            if scc.len() > 1 {
                self.sccs.push(scc);
            }
        }
    }
}

/// Tarjan 强连通分量（递归；图仅数十节点无栈风险）：仅产出非平凡 SCC。
fn strong_components(edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>) -> Vec<Vec<ModuleKey>> {
    let mut tarjan = Tarjan {
        edges,
        index: BTreeMap::new(),
        low: BTreeMap::new(),
        on_stack: BTreeSet::new(),
        stack: Vec::new(),
        sccs: Vec::new(),
        counter: 0,
    };
    let roots: Vec<ModuleKey> = edges.keys().cloned().collect();
    for root in roots {
        if !tarjan.index.contains_key(&root) {
            tarjan.strongconnect(&root);
        }
    }
    tarjan.sccs
}

/// 全图中的环：每个非平凡 SCC 给一条可读环路径（成员内 DFS 找回路）。
pub(super) fn cycles_of(edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>) -> Vec<String> {
    let mut cycles = Vec::new();
    for scc in strong_components(edges) {
        let members: BTreeSet<ModuleKey> = scc.iter().cloned().collect();
        let start = scc[0].clone();
        cycles.push(cycle_path(&start, &members, edges).join(" → "));
    }
    cycles.sort();
    cycles
}

/// 在 SCC 成员内部自 start 找一条回到起点的具体路径。
fn cycle_path(
    start: &ModuleKey,
    members: &BTreeSet<ModuleKey>,
    edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
) -> Vec<ModuleKey> {
    let mut path = vec![start.clone()];
    let mut visited: BTreeSet<ModuleKey> = BTreeSet::from([start.clone()]);
    match dfs_cycle(start, start, members, edges, &mut path, &mut visited) {
        Some(closed) => closed,
        None => members.iter().cloned().collect(),
    }
}

/// cycle_path 的递归体：沿成员内边推进，回到 start 即闭合成环。
fn dfs_cycle(
    start: &ModuleKey,
    node: &ModuleKey,
    members: &BTreeSet<ModuleKey>,
    edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
    path: &mut Vec<ModuleKey>,
    visited: &mut BTreeSet<ModuleKey>,
) -> Option<Vec<ModuleKey>> {
    let neighbors: Vec<ModuleKey> = edges[node].iter().cloned().collect();
    for next in neighbors {
        if !members.contains(&next) {
            continue;
        }
        if &next == start {
            let mut closed = path.clone();
            closed.push(start.clone());
            return Some(closed);
        }
        if visited.contains(&next) {
            continue;
        }
        visited.insert(next.clone());
        path.push(next.clone());
        let found = dfs_cycle(start, &next, members, edges, path, visited);
        if found.is_some() {
            return found;
        }
        path.pop();
    }
    None
}

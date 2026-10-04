# PlotWeave 数据模型设计

> 本文是旧路径与章节编号的兼容入口。现行契约见[数据模型主索引](data-model/README.md)；下表保留原章节标题和锚点，供历史记录及源码注释查找。结构迁移见 [issue #281](https://github.com/hailingu/PlotWeave/issues/281)。

[数据模型主索引](data-model/README.md) · [修订历史](data-model-revisions.md) · [设计同步记录](design-sync.md)

## 旧章节迁移对照

## 一、设计背景与原则

现行正文：[数据模型 · 设计原则、分层与演进](data-model/overview.md#一设计背景与原则)

## 二、总体分层

现行正文：[数据模型 · 设计原则、分层与演进](data-model/overview.md#二总体分层)

## 三、ProjectDocument

现行正文：[数据模型 · 项目文档](data-model/project-document.md#三projectdocument)

## 四、节点模型

现行正文：[数据模型 · 图模型](data-model/graph-model.md#四节点模型)

### 4.1 通用结构

现行正文：[数据模型 · 图模型](data-model/graph-model.md#41-通用结构)

### 4.2 各类型 spec

现行正文：[数据模型 · 图模型](data-model/graph-model.md#42-各类型-spec)

### 4.3 端口与连接

现行正文：[数据模型 · 图模型](data-model/graph-model.md#43-端口与连接)

## 五、边模型

现行正文：[数据模型 · 图模型](data-model/graph-model.md#五边模型)

## 六、设定集（settings）

现行正文：[数据模型 · 设定与引用](data-model/settings-and-references.md#六设定集settings)

## 七、资产模型

现行正文：[数据模型 · 资产](data-model/assets.md#七资产模型)

### 7.1 两个作用域

现行正文：[数据模型 · 资产](data-model/assets.md#71-两个作用域)

### 7.2 库资产的分类与编组

现行正文：[数据模型 · 资产](data-model/assets.md#72-库资产的分类与编组)

### 7.3 流转规则

现行正文：[数据模型 · 资产](data-model/assets.md#73-流转规则)

## 八、引用模型与联动规则

现行正文：[数据模型 · 设定与引用](data-model/settings-and-references.md#八引用模型与联动规则)

### 8.1 引用类型与真相归属

现行正文：[数据模型 · 设定与引用](data-model/settings-and-references.md#81-引用类型与真相归属)

### 8.2 生命周期联动规则

现行正文：[数据模型 · 设定与引用](data-model/settings-and-references.md#82-生命周期联动规则)

### 8.3 为什么这样设计（失效模式对照）

现行正文：[数据模型 · 设定与引用](data-model/settings-and-references.md#83-为什么这样设计失效模式对照)

## 九、命令与撤销

现行正文：[数据模型 · 命令与撤销](data-model/commands.md#九命令与撤销)

### 9.1 命令结构

现行正文：[数据模型 · 命令与撤销](data-model/commands.md#91-命令结构)

### 9.2 命令清单

现行正文：[数据模型 · 命令与撤销](data-model/commands.md#92-命令清单)

### 9.3 命令数据模型

现行正文：[数据模型 · 命令与撤销](data-model/commands.md#93-命令数据模型)

### 9.4 撤销规则

现行正文：[数据模型 · 命令与撤销](data-model/commands.md#94-撤销规则)

## 十、本地存储体系

现行正文：[数据模型 · 持久化](data-model/persistence.md#十本地存储体系)

### 10.1 目录布局

现行正文：[数据模型 · 持久化](data-model/persistence.md#101-目录布局)

### 10.2 写入安全

现行正文：[数据模型 · 持久化](data-model/persistence.md#102-写入安全)

#### 设置保存状态与不变量（issue #121）

现行正文：[数据模型 · 持久化](data-model/persistence.md#设置保存状态与不变量issue-121)

### 10.3 Provider 与模型配置

现行正文：[数据模型 · Provider 设置](data-model/provider-settings.md#103-provider-与模型配置)

### 10.4 密钥管理

现行正文：[数据模型 · Provider 设置](data-model/provider-settings.md#104-密钥管理)

### 10.5 Rust 持久化命令（Tauri commands）

现行正文：[数据模型 · 持久化](data-model/persistence.md#105-rust-持久化命令tauri-commands)

## 十一、加载与归一化

现行正文：[数据模型 · 加载与归一化](data-model/normalization.md#十一加载与归一化)

## 十二、AI Agent 交互

现行正文：[数据模型 · AI 交互](data-model/ai-integration.md#十二ai-agent-交互)

### 12.1 核心决策：Agent 是命令的另一个生产者

现行正文：[数据模型 · AI 交互](data-model/ai-integration.md#121-核心决策agent-是命令的另一个生产者)

### 12.2 应用内 Agent（首版）

现行正文：[数据模型 · AI 交互](data-model/ai-integration.md#122-应用内-agent首版)

### 12.3 MCP 暴露（可选，后置）

现行正文：[数据模型 · AI 交互](data-model/ai-integration.md#123-mcp-暴露可选后置)

## 十三、后续演进预留

现行正文：[数据模型 · 设计原则、分层与演进](data-model/overview.md#十三后续演进预留)

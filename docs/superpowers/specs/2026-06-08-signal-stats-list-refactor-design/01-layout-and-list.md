# 01 · 总体布局与全宽方案表

[← 返回 index](./index.md)

## 1. 布局变更：主从 → 全宽表

**现状**（`SignalStatsView.vue:1-89`）：左侧 220px 窄方案列表（仅显示 name + 日期区间）
+ 右侧常驻详情面板（顶部运行/编辑/删除按钮 + `SignalStatsResult` 组件）。

**目标**：去掉左窄列表，内容区改为单 `n-card` 包一张全宽 `n-data-table`，仿
`StrategyConditionsView.vue:12-17` 的风格（`:bordered="false"`，列全部 render 函数，header
extra 放「新建方案」按钮）。详情与编辑各用一个 `AppModal`。

```text
┌────────────────────────────────────────────────────────────────────────┐
│  n-card 「信号前向统计」                       [header-extra: 新建方案 ▸] │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ n-data-table（全宽，:bordered=false，每行 = 一个方案）             │ │
│  │ 名称│统计区间│出场方式│标的池│状态│样本│胜率│PF│最新运行│操作      │ │
│  │ ───────────────────────────────────────────────────────────────    │ │
│  │ 动量突破│25-01-01~25-06-30│固定5日│全市场│●已完成│45│62.2%│1.83│… │ │
│  │ 缩量回踩│25-01-01~25-06-30│条件出场│指定30只│○未运行│—│—│—│—│…  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘

   点行名 / 点「详情」 ─▶ 详情 AppModal（见 02 文档）
   点「编辑」/「新建」 ─▶ 编辑 AppModal（SignalTestForm，沿用现状）
```

## 2. 列设计（注意①）

每行 = 一个方案，融合**方案配置**（来自 test 实体）+ **最新一次运行指标**（来自后端新增的
`latestRun` 字段，见 [03 文档](./03-backend-changes.md)「改动 B：findAll 补 latestRun」）。共 10 列：

| # | 列标题 | 数据来源 | 渲染规则 |
|---|---|---|---|
| 1 | 方案名称 | `test.name` | 纯文本，`word-break` |
| 2 | 统计区间 | `test.dateStart` ~ `test.dateEnd` | `formatTradeDate` 两端拼接 |
| 3 | 出场方式 | `test.exitMode` / `horizonN` / `maxHold` | NTag：`fixed_n`→`固定N日(N=5)`；`strategy`→`条件出场(≤maxHold)` |
| 4 | 标的池 | `test.universe` | NTag：`all`→`全市场`；`list`→`指定N只`（N=`tsCodes.length`） |
| 5 | 状态 | `test.latestRun?.status` | NTag 四态，见 §2.1 |
| 6 | 样本数 | `latestRun?.sampleCount` | 数字；null→`—` |
| 7 | 胜率 | `latestRun?.winRate` | `(x*100).toFixed(1)%`；null→`—` |
| 8 | 盈亏比 PF | `latestRun?.profitFactor` | `Number(x).toFixed(2)`；null（无亏损样本）→`—` |
| 9 | 最新运行时间 | `latestRun?.createdAt` | `formatUTCDateTime`；running 显脉冲点；null→`—` |
| 10 | 操作 | — | 运行 / 详情 / 编辑 / 删除（见 §2.2） |

**完整指标**（赔率 b、凯利 f*、均持仓、均盈、均亏、最差单笔、最佳单笔）不挤进表格，全部放
详情统计卡（见 [02 文档](./02-detail-modal.md)「§1 统计卡区」）。

### 2.1 状态列四态

| latestRun | status | 标签 | NTag type | 备注 |
|---|---|---|---|---|
| `null`（无 run） | — | 未运行 | `default` | 空心圈 ○ |
| 有 | `running` | 运行中 | `info` | 脉冲动画点（仿 `StrategyConditionsView` 第 130-143 行 + CSS `last-run-pulse`） |
| 有 | `completed` | 已完成 | `success` | 实心点 ● |
| 有 | `failed` | 失败 | `error` | 可 tooltip 显 `errorMessage` |

### 2.2 操作列

垂直/水平 `NSpace` 堆叠（仿 `StrategyConditionsView.vue:166-227`）：

- **运行**：`NButton`，`loading` 当该行 `store.runningId === row.id`；`disabled` 当
  `store.runningId !== null`（全局串行，同现状）。触发 `store.startRun(row.id)`。
- **详情**：`NButton`，`disabled` 当无 `latestRun`（没跑过没东西看）。点击 `openDetail(row)`。
- **编辑**：`NButton`，`openEdit(row)`。
- **删除**：`NPopconfirm` 包裹 `NButton type=error`，文案「确定删除此方案？运行历史和明细将一并
  删除。」，positive → `store.deleteTest(row.id)`。

> 点击**行名**（第 1 列）也触发 `openDetail(row)`；无 `latestRun` 时点行名给一个
> `message.info('该方案尚未运行，请先点「运行」')`，不开空详情。

## 3. 弹窗编排（互斥不叠加）

`SignalStatsView.vue` 持有两个独立 `AppModal`：

```text
showDetail (ref)  ──▶ AppModal 详情（body = SignalStatsResult，见 02）
showForm   (ref)  ──▶ AppModal 编辑/新建（body = SignalTestForm，沿用现状）
```

**互斥规则**：

- 「编辑」入口只在**表格操作列**，不在详情弹窗内部 —— 从根上避免弹窗套弹窗。
- 若未来需要「详情里点编辑」，约定先 `showDetail=false` 再 `showForm=true`（同一 tick 内先关
  后开），本次不实现该入口。
- 两个 modal 各自 `v-model:show`，状态独立，不共享 `editingTest` 之外的状态。

## 4. 交互流程

```text
进入页面
  └─ onMounted: store.fetchTests()   // 返回带 latestRun 的方案列表
        │
        ▼
  全宽表格渲染
        │
   ┌────┴─────────────┬──────────────┬───────────────┐
   ▼                  ▼              ▼               ▼
 点「运行」        点「详情」/行名   点「编辑」      点「删除」
   │                  │              │               │
 startRun(id)      openDetail(row)  openEdit(row)   deleteTest(id)
 轮询进度          showDetail=true  showForm=true   行消失
   │                  │
 完成→fetchTests   弹窗内 02 流程
 刷新该行 latestRun
```

下一篇：[02 · 详情弹窗](./02-detail-modal.md)

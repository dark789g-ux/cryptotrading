# 05 · 测试与验证

[← 返回 index](./index.md) · [← 04 前端改动](./04-frontend-changes.md)

## 1. 后端单测

### 1.1 metrics（`signal-stats.metrics.spec.ts` 补充）

新增 `bestTradeRet` 断言，覆盖：

| 用例 | rets | 期望 bestTradeRet |
|---|---|---|
| 正常混合 | `[0.05, -0.02, 0.10]` | `0.10` |
| 全亏 | `[-0.03, -0.01]` | `-0.01`（仍是 max，负值） |
| 全胜 | `[0.02, 0.08]` | `0.08` |
| N=0 | `[]` | `null` |
| 单样本 | `[0.04]` | `0.04`（= worst = best） |

### 1.2 ret-histogram 分档纯函数（新建 `signal-stats.histogram.spec.ts`）

分档逻辑已落纯函数 `buildRetHistogram(runId, rets, bins)`（见
[03 文档](./03-backend-changes.md)「§C.2」），不依赖 DB，直接单测。覆盖：

| 用例 | 输入 | 期望 |
|---|---|---|
| 0 对齐 | 含正负 ret | 存在 `lo===0` 的档边界；无 `lo<0 && hi>0` 的跨色档 |
| 空 run | `[]` | `bins: []`，`binWidth: null`，`sampleCount: 0` |
| 全胜 | 全 `>0` | 所有档 `sign==='win'`，无 loss 档 |
| 全亏 | 全 `<0` | 所有档 `sign==='loss'` |
| 全相等 | `[0.05,0.05,0.05]` | `range=0` 兜底单档，不崩 |
| 计数守恒 | 任意 | `Σ bins.count === rets.length === sampleCount` |
| 空档补齐 | 稀疏分布 | 中间空档 `count===0` 仍存在、区间连续 |
| **浮点边界** | ret 恰落桶边界（如 `binWidth=0.02`、ret=`0.06`） | 归属确定档（锁定 C.2 第 4 步护栏），不因浮点末位漂移 |

> service `getRetHistogram` 只做「run 存在校验 + `SELECT ret` 取数 + 转 number + 调纯函数」，
> 这层靠真机/集成验（不靠 mock QueryBuilder 充数，参照 `.claude/rules/database-sql.md` 教训）。

### 1.3 service（`signal-stats.service.spec.ts` 补充）

- `findAll` 返回每个 test 带 `latestRun`（有 run / 无 run→null）。
- `getRetHistogram`：run 不存在 → `NotFoundException`；无明细 run → `bins: []`。

## 2. 构建

- `pnpm --filter @cryptotrading/server build`
- `pnpm --filter @cryptotrading/web type-check`
- **`pnpm --filter @cryptotrading/web build`（vite）** — 硬性，type-check 绿 ≠ SFC 能编译。
- `pnpm --filter @cryptotrading/web lint:quant-lines` 不覆盖 strategy 视图，但仍自查改动文件
  ≤500 行。

## 3. DB migration 执行与验证

```text
powershell apps/server/migrations/20260608_signal_test_run_best_trade_ret.ps1
```

期望输出：列存在断言 = 1；有明细的 run 回填后 `best_trade_ret IS NULL` 计数 = 0。
执行后**重启后端进程**（`nest start` 无 watch，新列/新路由不重启不生效）。

## 4. 真机端到端验证（browser-driving）

前置：migration 已跑 + 后端重启 + 前端 dev（HMR）。

1. **表格渲染**：进入「信号前向统计」，全宽表格出现，每行 10 列；未跑过的方案状态列「未运行」、
   指标列 `—`；跑过的显「已完成」+ 胜率/PF/样本数。
2. **运行**：点某行「运行」→ 状态列变「运行中」（脉冲）→ 完成后该行自动刷新为「已完成」+ 指标
   （验证 `startRun` 完成后 `fetchTests` 刷新）。
3. **详情弹窗**：点行名/「详情」→ AppModal 打开，可最大化；
   - 10 个统计卡齐全，**「最佳单笔」**有值（绿）、「最差单笔」有值（红）。
   - 默认 tab「收益率分布」：直方图渲染，**0 左侧红档、右侧绿档**；hover tooltip 显区间+频数。
   - 切 tab「逐笔明细」：标准分页表，50/页，收益率正绿负红，出场原因 tag。
4. **互斥**：详情弹窗开着时表格「编辑」不可达（编辑入口只在行操作列）；关详情、点「编辑」→
   编辑弹窗正常，二者不叠加。
5. **边界**：找/造一个全胜样本的方案 → 直方图只有绿档不报错；空/失败 run → 详情显进度条或
   error alert，直方图 tab 显「暂无数据」。
6. **存量回填**：打开一个 migration 之前就跑完的旧方案详情 → 「最佳单笔」不是 `—`（回填生效）。

## 5. 边界与风险清单

| 风险 | 处置 |
|---|---|
| TypeORM `distinctOn` 版本不稳 | 退化原生 SQL `DISTINCT ON`，真机确认字段水合齐全 |
| 旧 run 未回填 best_trade_ret | migration 内 UPDATE 回填 + ps1 断言无残留 NULL |
| 大样本 run 直方图性能 | 后端 SQL 分档（GROUP BY），只回传数十个桶，与样本量解耦 |
| numeric 以 string 返回前端 | 展示前统一 `Number(x)`；null→`—`；直方图 number 由后端算好 |
| run 完成后整表 fetchTests 抖动 | MVP 接受；后续可改为只 patch 单行 latestRun |
| 弹窗套弹窗 | 编辑入口仅在行操作列，详情内不放编辑入口（见 01 §3） |
| 改 SignalStatsResult 破坏现有引用 | 全仓 grep `SignalStatsResult` 确认仅被 View 引用后再改造 |

## 6. 完成定义（DoD）

- 后端单测（metrics 含 bestTradeRet、histogram 分档、service）全绿。
- server build + web type-check + **web vite build** 全绿。
- migration 跑通且回填断言通过；后端重启。
- 真机第 4 节 6 项验证全过（截图留档）。
- 按子系统分层 commit（后端 metrics+实体+runner / migration / 后端接口 / 前端组件 / API+store），
  遵循用户「复杂改动分层 commit」偏好。

[← 返回 index](./index.md)

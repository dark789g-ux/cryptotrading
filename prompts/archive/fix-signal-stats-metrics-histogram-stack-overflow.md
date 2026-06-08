# 修复 signal-stats 大样本聚合/直方图 `Math.max(...rets)` 栈溢出

## 一句话目标

修复 signal-stats run 在**大样本（有效 trade 数 > 约 12 万）场景的聚合指标阶段栈溢出**（`RangeError: Maximum call stack size exceeded`）导致 run `failed` 的 bug。根因是 `Math.min(...rets)` / `Math.max(...rets)` 把整段全量收益数组 spread 进函数调用、超 V8 函数实参数量上限。涉及 **两处**：`signal-stats.metrics.ts:89-90`（run 落库阶段必经）与 `signal-stats.histogram.ts:57-58`（详情直方图接口，连带隐患）。改为 `reduce`/`for` 循环（数值完全等价、O(n)、无栈风险），加大数组单测，重启后端，重跑长区间 run 验证「跑完 + 详情直方图正常」。

## 背景（怎么发现的）

2026-06-09 做 signal-stats 前端 e2e 复测（交接 `verify-signal-stats-frontend-e2e.md`，已归档）。**A 清单（UI 回归 1~7）全过**——全宽方案表 / 详情弹窗 / 10 KPI 卡（含 best_trade_ret）/ **直方图首开渲染 canvas=1**（`2e015b7` 修复未回退）/ 逐笔明细 9 列分页 / 最大化 1100→1836 不空白 / 接口自检 200。**前端侧健康，只有下面这个后端大样本聚合 bug。**

B 阶段「UI 实触发长区间(2023-01-01~2026-05-31)全市场重 run」时暴露此 bug。

## 根因（file:line 为证，已落源头核对真代码，非二手转述）

**调用链**（`apps/server/src/strategy-conditions/signal-stats/`）：

1. `signal-stats.runner.ts:151` — `const rets = trades.map((t) => t.ret);`（`rets.length` = 有效 trade 数，大样本下达 44 万级）
2. `signal-stats.runner.ts:153` — `const stats = calcSignalStats(rets, holdDays);`
3. `signal-stats.metrics.ts:89-90` — **元凶**：
   ```ts
   const worstTradeRet = Math.min(...rets);
   const bestTradeRet = Math.max(...rets);
   ```
   `...rets` 把 44 万个元素作为函数实参展开 → 超 V8 实参数量上限 → 抛 `RangeError: Maximum call stack size exceeded`。
4. 异常被 `signal-stats.runner.ts:56-66` 的 `executeRun` try/catch 捕获 → `runRepo.update(runId, { status:'failed', errorMessage:msg })`。

**连带第二处**（同模式，run 修好后必须一起修，否则 run 完成→开详情又崩）：

- `signal-stats.histogram.ts:57-58`：
  ```ts
  const lo = Math.min(...rets);
  const hi = Math.max(...rets);
  ```
  `buildRetHistogram` 被详情直方图接口 `GET /api/signal-tests/runs/:runId/ret-histogram` 调用，`rets` 同为全量逐笔收益。对 > 约 12 万样本且**已完成**的方案开详情，会在分档时同样栈溢出。

> 注：这两处**一直潜伏**，不是出场模拟提速重构引入的。以前大样本 run 在出场模拟阶段就卡几十分钟/超时，根本到不了聚合这步；**提速后 run 能快速跑到聚合阶段，才把这个老 spread 溢出暴露出来**。

## 复现（真机实测证据链，2026-06-09）

- **失败 run**：新建方案 `kdj_j_lt_0_e2e_long`（testId `15c7a18e-cfc0-42f3-ae89-dcdba15f52d8`），UI 实触发 run `d7b5bab2-69be-4312-a23b-ac1016e305f8`。
  - 区间 2023-01-01~2026-05-31、全市场、`kdj_j < 0`、固定 N=1。
  - 进度轨迹：触发后枚举 `progressScanned` 稳步推进，约 **2分45秒** 到 `822/822`（枚举+出场模拟完成，**出场模拟确实不再是 50min 瓶颈**）→ 进入聚合 → 约 **3分26秒** 时 `status=failed`、`errorMessage="Maximum call stack size exceeded"`、`sampleCount=null`（聚合在落库前崩，故 `signal_test_trade` 无该 run 数据、指标全 null）。
- **对照（证明是样本量阈值问题）**：金标准方案 `kdj_j_lt_-10_2023-2026`（run `06239e89-38b6-4189-8b98-4ef53220ae09`，**80276** trades）能正常算出 `bestTradeRet=65.7%`、详情直方图 16 档正常 → **80276 < V8 实参上限，44 万 > 上限**。阈值在 8 万~44 万之间（V8 实测约 12.5 万，具体看引擎版本）。

## 修复方向（已定，等价改写）

两处 `Math.min/max(...arr)` → 线性扫描。两处调用点都已有非空 early-return（`metrics.ts:35` `N===0` 返回、`histogram.ts:53` `rets.length===0` 返回），故 `rets[0]` 必存在：

```ts
// metrics.ts:89-90 替换为
let worstTradeRet = rets[0];
let bestTradeRet = rets[0];
for (let i = 1; i < rets.length; i++) {
  const r = rets[i];
  if (r < worstTradeRet) worstTradeRet = r;
  if (r > bestTradeRet) bestTradeRet = r;
}
```

```ts
// histogram.ts:57-58 替换为（lo/hi 同样线性求）
let lo = rets[0];
let hi = rets[0];
for (let i = 1; i < rets.length; i++) {
  const v = rets[i];
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}
```

（用 `reduce((m,r)=>r<m?r:m, rets[0])` 亦可，但大数组 `for` 循环更省一层闭包开销，可任选。）

## 待接手敲定 / 注意

1. **先全局复扫，确认无第三处遗漏**：本会话只 grep 了 `signal-stats/` 目录命中这两处（pattern 覆盖 `Math.max/min(...`、`push(...`、`fromCharCode(...`、`concat(...`）。接手后建议把扫描面扩到 `apps/server/src/strategy-conditions/` 乃至 `apps/server/src/`，确认没有别的「大数组 spread 进函数」隐患（任何对 O(信号数)/O(trade数) 数组做 `f(...arr)` 的写法都危险）。
2. **single-file ≤500 行**等组织规范不受影响（仅改函数体）。

## 硬约束 / 项目规范

- **改后端必须重启后端进程**：`pnpm dev` 的后端是 `nest start`（**无 `--watch`**），改完 `apps/server` 代码不重启则旧逻辑仍在跑，重跑 run 会假象未修复。
- **源文件 UTF-8**；对象键名用英文。
- **别覆盖金标准**：方案 `kdj_j_lt_-10_2023-2026` 的 run `06239e89-38b6-4189-8b98-4ef53220ae09`（80276 样本）是基准，勿重跑/覆盖。
- **别动孤儿 running**：`kdj_j_lt_20` / `kdj_j_lt_10`（`*_2023-2026`）卡在「运行中」是**另一个交接** `sync-signal-stats-run-status.md` 的 DB 状态问题，与本 bug 无关，别追别修。
- 单测命令：`pnpm --filter @cryptotrading/server exec jest signal-stats.metrics`（及 `signal-stats.histogram`）。构建：`pnpm --filter @cryptotrading/server build`。

## 验证标准（通过判据）

1. **单测**：`signal-stats.metrics.spec.ts` 与 `signal-stats.histogram.spec.ts` 各加一个**大数组 case**（如 200000+ 元素的 rets），断言：(a) 不抛栈溢出；(b) min/max 与小规模朴素实现数值一致。原有 case 全绿。
2. **构建**：`pnpm --filter @cryptotrading/server build` 绿。
3. **重启后端**后，**重跑** `kdj_j_lt_0_e2e_long`（点列表该行「运行」按钮，或 `POST /api/signal-tests/15c7a18e-cfc0-42f3-ae89-dcdba15f52d8/run`）：
   - run 走到 `status=completed`（不再 `failed`）；
   - `sampleCount` 为 44 万级真实值、`bestTradeRet`/`worstTradeRet` 等指标非 null；
   - `signal_test_trade` 落入该 run 的逐笔数据。
4. **详情直方图回归**（验 histogram 那处也修好）：开 `kdj_j_lt_0_e2e_long` 详情 →「收益率分布」tab 直方图正常渲染（`.ret-chart` 内 `canvas≥1`、`[_echarts_instance_]≥1`），且 `GET /api/signal-tests/runs/<新runId>/ret-histogram` 返回 200 + `{sampleCount,binWidth,bins:[{lo,hi,count,sign}]}`，**不再栈溢出**。
5. 全程后端日志无 `Maximum call stack size exceeded`。

## 前序进度 / 现有数据

- 本会话（2026-06-09）已做：A 清单 1~7 全过（截图 `C:\tmp\sigstats-maximized.png` / `sigstats-detail.png`）；B UI 实触发成功并定位本 bug；按用户决定写此交接、**未动后端**。
- 失败 run `d7b5bab2`（test `15c7a18e` = `kdj_j_lt_0_e2e_long`）留在库里 `status=failed`，可直接重跑复现/验证。
- 修复属后端单点 hotfix，建议提交：`fix(signal-stats): 聚合/直方图改线性扫描避免大样本 Math.max(...rets) 栈溢出`。
- 完成后将本文档移入 `prompts/archive/`。

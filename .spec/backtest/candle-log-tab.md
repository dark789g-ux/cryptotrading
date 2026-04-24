# 回测详情 - "K线记录" Tab 开发计划

> 状态：待开发
> 需求来源：在 [BacktestDetail.vue](../../apps/web/src/components/backtest/BacktestDetail.vue) 新增 Tab，展示每根K线上的操作
> 创建时间：2026-04-18

---

## 一、需求澄清共识

| 项 | 决策 |
|---|---|
| 数据范围 | **每根K线全操作日志**（需新增引擎逐根事件收集） |
| 展示粒度 | **全局时间轴**（一根K线一行，聚合所有标的的当根动作） |
| 存储方式 | **B. 新建表 `backtest_candle_log`**（不嵌入 `BacktestRun.stats` JSON） |
| 兼容策略 | **仅对新回测生效**，历史回测无此数据时前端显示空态 |
| 后端改造范围 | 仅 engine 事件收集 + report 输出 + 新 Entity/Controller，不动策略表单等其他模块 |

---

## 二、关键架构变更（范围蔓延项，已独立确认）

### 冷却期机制重构（策略规则变更，非纯展示）

**当前行为**（per-symbol 冷却）：
- 基础冷却：标的平仓后，该标的在 `cooldownBars` 根K线内不可再入场
- 连亏升级：该标的连续亏损 ≥ `consecutiveLossesThreshold` 时，该标的冷却时长升级为 `baseCooldownCandles → maxCooldownCandles`（随连亏次数递增）
- 盈利削减：若 `consecutiveLossesReduceOnProfit = true`，一次盈利削减连亏计数

**目标行为**（账户级全局冷却，与标的无关）：

1. **连亏计数 `consecLosses`**（账户级，不区分标的）：
   - 每笔**亏损**交易平仓 → `+1`
   - 每笔**盈利**交易平仓 → **清零**
   - 冷却期结束时 → 清零

2. **冷却触发**：
   - 当 `consecLosses ≥ consecutiveLossesThreshold` → 账户进入全局冷却

3. **冷却时长**（全局持久累加式）：

   **持久状态 `cooldownDuration`**（整个回测生命周期内持续存在，不因冷却结束而清零）：
   - **初始值** = `baseCooldownCandles`（回测开始时）
   - **每次亏损平仓**（不论账户是否处于冷却期）→ `cooldownDuration += 1`
   - **每次盈利平仓**（不论账户是否处于冷却期）→ `cooldownDuration -= 1`
   - **取值范围**：`[0, maxCooldownCandles]`（封顶饱和）

   **触发冷却**：当 `consecLosses ≥ consecutiveLossesThreshold` → 进入冷却，结束 barIdx = 当前 barIdx + `cooldownDuration`

   **冷却期内的同步更新**：若账户当前处于冷却期，则上述 ±1 会实时同步到结束 barIdx（±1 根 K线）

   **冷却解除条件**（满足任一）：
   - 到达结束 barIdx（自然结束）
   - 冷却期内盈利使 `cooldownDuration` 降至 0（立即解除）
   - 解除时 `consecLosses` 清零；`cooldownDuration` **不清零**，保留当前值进入下一阶段

   **举例说明**（参数：`consecutiveLossesThreshold=3, baseCooldownCandles=5, maxCooldownCandles=15`）：

   | 事件 | consecLosses | cooldownDuration | 账户状态 | 冷却结束 barIdx |
   |---|---|---|---|---|
   | 回测开始 | 0 | **5**（= base）| 正常 | — |
   | K#100 亏损（第1笔）| 1 | 5+1 = **6** | 正常 | — |
   | K#102 亏损（第2笔）| 2 | 6+1 = **7** | 正常 | — |
   | K#105 亏损（第3笔，达阈值，触发）| 3 | 7+1 = **8** | **进入冷却** | 105+8 = **113** |
   | K#106~107 无平仓 | 3 | 8 | 冷却中 | 113 |
   | K#108 亏损（冷却内）| 4 | 8+1 = **9** | 冷却中 | 113+1 = **114** |
   | K#110 亏损（冷却内）| 5 | 9+1 = **10** | 冷却中 | 114+1 = **115** |
   | K#111 盈利（冷却内）| **0**（清零）| 10-1 = **9** | 冷却中 | 115-1 = **114** |
   | K#114 末尾 | 0 | 9 | **解除冷却** | — |
   | K#120 盈利（非冷却期）| 0 | 9-1 = **8** | 正常 | — |
   | K#125 亏损（第1笔新一轮）| 1 | 8+1 = **9** | 正常 | — |
   | ... consecLosses 再次累至 3 触发 | 3 | (当时值) | 进入冷却 | 当前 barIdx + cooldownDuration |

   **关键点**：
   - `cooldownDuration` 是**全回测持久变量**，随每次平仓 ±1 持续变化，跨越多轮冷却
   - 冷却期内的 ±1 同步反映到结束 barIdx，无需重算
   - 冷却结束时只清零 `consecLosses`，`cooldownDuration` 保留
   - 上下界：`[0, maxCooldownCandles]`；触达封顶后亏损不再累加，触 0 后盈利不再削减
   - `baseCooldownCandles` 仅作为回测启动时的初始值使用

4. **冷却期间行为**：
   - ❌ 禁止任何标的入场
   - ✅ 已持仓标的可正常平仓
   - ⚠️ 若冷却期内再发生亏损平仓 → `consecLosses+1` → **动态延长本次冷却**（按公式重算结束时点）

5. **冷却结束**：剩余时长归零时，`consecLosses` 清零，账户解除冷却

6. **参数变化**：
   - `cooldownBars`（单标的冷却时长）→ **废弃**（全局冷却不再使用此参数）
   - `consecutiveLossesReduceOnProfit`（盈利削减开关）→ **废弃**（新逻辑为盈利清零，无需开关）
   - `consecutiveLossesThreshold` / `baseCooldownCandles` / `maxCooldownCandles` → 保留，语义同上

**⚠️ 影响警告**：
- 所有历史策略的回测结果在相同参数下**会发生变化**（收益曲线不同）
- 涉及文件：[cooldown.ts](../../apps/server/src/backtest/engine/cooldown.ts)、[signal-scanner.ts](../../apps/server/src/backtest/engine/signal-scanner.ts)、[engine.ts](../../apps/server/src/backtest/engine/engine.ts)、[position-handler.ts](../../apps/server/src/backtest/engine/position-handler.ts)
- 策略配置：`cooldownBars` 与 `consecutiveLossesReduceOnProfit` 字段废弃，策略表单/Entity/默认值需同步清理（超出本任务范围，需独立决策是否同步处理）
- 建议开发时先做新旧冷却对比回测，再确认上线

---

## 三、列字段设计（全局时间轴，一行一根K线）

| 列 | 说明 | 数据来源 |
|---|---|---|
| 序号 | 倒序编号 | 计算 |
| 时间 | K线时间戳 | `candleLog[i].ts` |
| 开盘净值 | 该K线**开盘时刻**账户快照（现金 + 按开盘价估值的持仓）| 新增：引擎在 K线开始时记录 |
| 收盘净值 | 该K线**收盘时刻**账户净值 | `portfolioLog[i][1]`（已有）|
| 持仓数 / 上限 | 如 `3/5` | `posSnapshots[i].length / maxPositions` |
| 入场 | 当根买入笔数 + 标的列表（ellipsis + tooltip 显示详情）| 新增：引擎当根事件 |
| 出场 | 当根卖出笔数 + 标的+原因（ellipsis + tooltip）| 新增：引擎当根事件 |
| 是否处于冷却期 | 是 / 否（全局冷却状态）| 新增：全局冷却标志 |

**删除的列**：~~命中未入~~、~~持仓浮盈%~~、~~冷却中标的数~~

---

## 四、改动文件清单

### 后端（apps/server）

| 类型 | 路径 | 职责 |
|---|---|---|
| 修改 | `src/backtest/engine/cooldown.ts` | 从 per-symbol 重构为账户级：状态由 `Map<symbol,barIdx>` 改为 `{ consecLosses: number; cooldownDuration: number; cooldownUntilBarIdx: number \| null }`；导出 `initCooldown(base)` / `registerExit(isWin, barIdx)` / `isInCooldown(barIdx)` |
| 修改 | `src/backtest/engine/signal-scanner.ts` | 入场过滤改为检查账户级冷却（删除 per-symbol 冷却 Map 参数）|
| 修改 | `src/backtest/engine/position-handler.ts` | 每次平仓调用 `registerExit(isWin, barIdx)`：①（不论是否在冷却中）`cooldownDuration` 随亏损+1 / 盈利-1（clamp [0, max]）；② 亏损 → `consecLosses+1`，达阈值则触发冷却；③ 盈利 → `consecLosses` 清零；④ 若当前处于冷却期则同步调整结束 barIdx |
| 修改 | `src/backtest/engine/engine.ts` | ① 主循环内新增 `candleLog` 累积；② K线开始时记录开盘净值快照；③ 当根入场/出场事件收集；④ 冷却状态写入 |
| 修改 | `src/backtest/engine/models.ts` | 新增 `CandleLogEntry` 类型定义 |
| 修改 | `src/backtest/engine/report.ts` | `prepareReportData` 不直接返回 candleLog（过大），改由独立接口分页查询 |
| 新增 | `src/entities/backtest-candle-log.entity.ts` | TypeORM Entity |
| 新增 | `src/backtest/candle-log.controller.ts` | `GET /backtest/runs/:runId/candle-log` 分页接口 |
| 修改 | `src/backtest/backtest.service.ts` | 回测完成后批量插入 candle-log |
| 修改 | `src/backtest/backtest.module.ts` | 注册新 Entity 与 Controller |

### 前端（apps/web）

| 类型 | 路径 | 职责 |
|---|---|---|
| 修改 | `src/components/backtest/BacktestDetail.vue` | 在 `n-tabs` 内新增 `<n-tab-pane name="candleLog" tab="K线记录">`；表格分页走后端 |
| 修改 | `src/composables/useApi.ts` | 新增 `backtestApi.getCandleLog(runId, page, pageSize, filters)` |

---

## 五、数据结构

### CandleLogEntry（引擎输出 & DB 存储）

```ts
interface CandleLogEntry {
  runId: string;
  barIdx: number;           // K线序号
  ts: string;               // 时间戳 YYYY-MM-DD HH:MM:SS
  openEquity: number;       // 开盘净值
  closeEquity: number;      // 收盘净值
  posCount: number;         // 当根持仓数
  maxPositions: number;     // 冗余，便于前端渲染 "3/5"
  entries: Array<{          // 当根入场事件
    symbol: string;
    price: number;
    shares: number;
    amount: number;
    reason: string;
  }>;
  exits: Array<{            // 当根出场事件
    symbol: string;
    price: number;
    shares: number;
    amount: number;
    pnl: number;
    reason: string;
    isHalf: boolean;
  }>;
  inCooldown: boolean;      // 全局冷却状态
}
```

### 数据库表 `backtest_candle_log`

```sql
CREATE TABLE backtest_candle_log (
  id              VARCHAR PRIMARY KEY,
  run_id          VARCHAR NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  bar_idx         INTEGER NOT NULL,
  ts              TIMESTAMP NOT NULL,
  open_equity     NUMERIC(20,4) NOT NULL,
  close_equity    NUMERIC(20,4) NOT NULL,
  pos_count       INTEGER NOT NULL,
  max_positions   INTEGER NOT NULL,
  entries_json    JSONB NOT NULL DEFAULT '[]',
  exits_json      JSONB NOT NULL DEFAULT '[]',
  in_cooldown     BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_candle_log_run ON backtest_candle_log(run_id, bar_idx);
```

**存储量估算**：单次回测 8760 行（1年1h）× ~300 字节/行 ≈ 2.6 MB/run。若 1年15m 则 ~10 MB/run。可接受。

---

## 六、接口契约

### GET /backtest/runs/:runId/candle-log

**Query 参数**：
- `page` number，默认 1
- `pageSize` number，默认 50，最大 200
- `onlyWithAction` boolean，可选，true 时仅返回 `entries.length > 0 || exits.length > 0` 的行
- `symbol` string，可选，按标的过滤（entries/exits 含该 symbol）
- `sortBy` 默认 `bar_idx`
- `sortOrder` `asc`|`desc`，默认 `desc`

**响应**：
```ts
{
  rows: CandleLogEntry[],
  total: number,
  page: number,
  pageSize: number,
}
```

**错误码**：
- 404 run 不存在
- 404 该 run 无 candle-log 数据（老回测）→ 前端显示空态

---

## 七、边界处理

| 场景 | 策略 |
|---|---|
| 历史回测无 candle-log | 前端检测空数据 → `<n-empty description="该历史回测未记录K线日志">` |
| 超大回测（>5万根）| 强制分页（pageSize ≤ 200），不做虚拟滚动 |
| 一根K线多个卖出事件（分批止盈）| `exits` 数组保留每条独立事件，前端 tooltip 展开显示 |
| 预热期 K线 | **不计入** candle-log（与现有 `portfolioLog` 起始时点一致）|
| 全局冷却期内的 K线 | `inCooldown = true`，正常记录但 `entries` 必为空；`exits` 可能非空（已持仓平仓不受限制），且若为亏损平仓会动态延长本次冷却 |

---

## 八、潜在需求（本次不做，列出备案）

- C1. 行点击联动资产曲线图（跳转/高亮）
- C2. CSV 导出
- C3. 行详情侧抽屉（展开 entries/exits 完整 JSON）
- A3. 筛选"仅有操作的K线"**本次实现**（作为基础筛选）

---

## 九、不做什么（显式列出，避免蔓延）

- 不改策略配置表单 UI（废弃参数 `cooldownBars` / `consecutiveLossesReduceOnProfit` 在表单中仍显示，运行时忽略；彻底清理由后续任务处理）
- 不做回测结果迁移脚本（历史 run 不回填 candle-log）
- 不改资产净值曲线图
- 不引入前端虚拟滚动库
- 不做多回测对比视图

---

## 十、手动验证清单（开发完成后执行）

1. 新回测运行 → 打开详情 → 切到"K线记录"Tab → 应看到分页表格，第一页 50 行，倒序展示
2. 筛选"仅有操作" → 应只剩有入场/出场的行
3. 查看带分批止盈的回测 → 某根K线的出场 tooltip 应展开多条事件
4. 打开**旧回测**（无 candle-log）→ 应显示空态提示，无报错
5. 新旧冷却机制对比回测：同参数、同数据 → 收益曲线应有差异（确认全局冷却已生效）
6. 开盘净值 vs 收盘净值：持仓为空时两者应相等

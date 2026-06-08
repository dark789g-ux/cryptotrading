# 提升 signal-stats 出场模拟阶段速度 — 设计 spec

- 日期：2026-06-08
- 来源交接：`prompts/speed-up-signal-stats-exit-simulation.md`
- 范围决策（已与用户敲定）：**A+D+C 一步到位 + strategy 模式一并批量化 + 坚持 zero-drift（跳过方向 B）**

## 1. 背景与目标

`signal-stats` run 的**出场模拟阶段**（`simulateSignal` 逐信号出场）是绝对瓶颈：一次真实长 run（J<20、3.5 年、约 128 万信号）枚举 814 个 SSE 交易日仅 4 分钟，出场模拟阶段 4 个并发 run 跑 50+ 分钟仍 3 个未完成。

瓶颈是**逐信号 N+1 DB 查询**：128 万信号 × 3~4 条顺序 `await` ≈ 数百万条串行 SQL。

**目标**：出场模拟阶段从小时/数十分钟降到分钟级，且**输出与优化前 byte-identical（zero-drift）**。

## 2. 现状摸底（file:line 为证）

| 事实 | 位置 |
|------|------|
| runner `doExecute` 8 阶段；阶段5 出场循环 120-139 | `apps/server/src/strategy-conditions/signal-stats/signal-stats.runner.ts:120-139` |
| 出场循环完全串行 `for (const signal of signals) { await simulateSignal(...) }` | `signal-stats.runner.ts:123-139` |
| sseCalendar 全局预取一次复用 | `signal-stats.runner.ts:88`（`listAllSseTradingDays`，查 `raw.trade_cal WHERE exchange='SSE' AND is_open=1`） |
| 信号只含 `{signalDate, tsCode}`，无 buyDate（simulator 内部推下一 SSE 日） | `signal-stats.enumerator.ts:22-25`（`BuySignal`） |
| `windowDates = sseCalendar.slice(buyIdx).filter(d=>d<=dateEnd)`（窗口过取到 dateEnd） | `signal-stats.simulator.db.ts:81` |
| 每信号顺序 await：fetchQuotes/fetchLimits/[strategy]fetchExitSignalHits/fetchSymbol | `signal-stats.simulator.db.ts:87-98` |
| fetchQuotes：`SELECT trade_date,qfq_open,qfq_close,open FROM raw.daily_quote WHERE ts_code=$1 AND trade_date=ANY($2::text[])` | `signal-stats.simulator.db.ts:133-154` |
| fetchLimits：`SELECT trade_date,up_limit FROM raw.stk_limit WHERE ts_code=$1 AND trade_date=ANY($2::text[])` | `signal-stats.simulator.db.ts:157-167` |
| fetchExitSignalHits：单条跨日 `daily_indicator` join（按日命中卖出条件） | `signal-stats.simulator.db.ts:174-199` |
| fetchSymbol：`SELECT list_date,delist_date FROM a_share_symbols WHERE ts_code=$1`，每信号查一次 | `signal-stats.simulator.db.ts:203-214` |
| 纯函数 `simulateTradeCore` / `decideFixedN` / `decideStrategy`，不碰 DB | `signal-stats.simulator.ts:123 / :220 / :259` |
| `HoldingDaySnapshot` 字段：calDate/hasQuote/qfqOpen/qfqClose/rawOpen/upLimit/exitSignalHit | `signal-stats.simulator.ts:60-78` |
| fixed_n / strategy 分支 | `signal-stats.simulator.ts:157-161` |
| 落库已批量（每批 200 `tradeRepo.save`）；非瓶颈，本次不动 | `signal-stats.runner.ts:175-177` → `insertTradesBatched:186-206` |
| PG 连接池默认 `max:10`（`app.module.ts` 无 `extra/poolSize` 配置） | `apps/server/src/app.module.ts:93-173` |
| 现有单测：`simulator.spec.ts`（纯函数）/`runner.spec.ts`/`enumerator.spec.ts`/`metrics.spec.ts`/`service.spec.ts` | `apps/server/src/strategy-conditions/signal-stats/*.spec.ts` |
| 行数：runner 207 / simulator.db 222 / simulator 305（离 500 红线有余量） | 同上 |

**口径基准（zero-drift 依据）**：纯函数只吃「持有窗口快照序列 `days[]` + delistDate + exit」。对每个信号，`windowDates = sseCalendar.slice(thisBuyIdx).filter(<=dateEnd)` 是该 tsCode `unionWindow` 的后缀；某日的 quote/limit/命中 值与"用哪条 SQL 取回"无关。**只要喂给纯函数的 `days[]` 逐元素一致，输出 byte-identical。改"怎么取数"而不改"取到的窗口序列" = 零口径漂移。**

## 3. 数据流：before vs after

```text
【现状】每信号 N+1，完全串行
runner 循环 ──for each of ~128万 signals──▶ simulateSignal
                                              ├─ fetchQuotes (daily_quote)        await
                                              ├─ fetchLimits (stk_limit)          await
                                              ├─ fetchSymbol (a_share_symbols)    await  ← 静态表，5000 标的被查上百次
                                              ├─[strategy] fetchExitSignalHits    await
                                              └─ simulateTradeCore (纯函数)
   DB 往返 ≈ 128万 × 3~4 ≈ 数百万条 SQL，串行

【目标】按 tsCode 批量预取 + 有界并发 + 内存切窗
runner ─▶ simulateSignalsBatched(signals, …)
            ├─ groupByTsCode(signals)             → Map<tsCode, signal[]>  (~5000 组)
            ├─ prefetchSymbolMap(distinctTsCodes) → 1 条 SQL，全部 list/delist
            └─ mapWithConcurrency(tsCodes, limit=8, perTsCode):
                 perTsCode(tsCode):
                   unionWindow = sseCal.slice(minBuyIdx).filter(≤dateEnd)  // 该 tsCode 全部信号窗口的并集
                   quoteMap = fetchQuotes(tsCode, unionWindow)             // 1 条
                   limitMap = fetchLimits(tsCode, unionWindow)             // 1 条
                   hitSet   = [strategy] fetchExitSignalHits(tsCode, unionWindow, conds)  // 1 条；查整 unionWindow
                   for each signal of tsCode:                    // ★ 下列量逐信号变，禁提到 tsCode 级算一次
                       thisBuyIdx    = indexOf(nextSseDay(signalDate))           // signalDate 的下一 SSE 日
                       windowDates   = sseCal.slice(thisBuyIdx).filter(≤dateEnd) // unionWindow 的后缀，与现状逐字一致
                       daysSinceList = thisBuyIdx − effListIdx(symbolMap[tsCode].listDate)  // ★ per-signal（依赖 thisBuyIdx）
                       days = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet)     // 纯 helper；exitSignalHit 排除 windowDates[0]
                       outcome = simulateTradeCore({ tsCode, signalDate, days, daysSinceList,
                                                     delistDate: symbolMap[tsCode].delistDate, exit })  // 纯函数零改动
                   release maps
   DB 往返 ≈ 5000 × 2~3 ≈ 1~1.5 万条 SQL，8 路并发 → 秒级~分钟级
```

降幅：DB 查询 `O(128万×3) → O(5000×2)`，约 300 倍。

## 4. 模块边界与职责

```text
runner.ts                 阶段5：一行 simulateSignalsBatched(...) 取代 123-139 的 for 循环；
                          仍由 runner 遍历 outcomes 累加 trades / filterCounts（聚合逻辑+单测不动）

simulator.db.ts           DB 访问类（SignalSimulator）
  ├─ simulateSignalsBatched(...)        ← 新增编排入口（分组 / 预取 / 并发 / 切窗）
  ├─ prefetchSymbolMap(tsCodes)         ← 新增（替代 per-signal fetchSymbol；方向 D）
  ├─ fetchQuotes / fetchLimits          ← 复用，改为 per-tsCode 传 unionWindow
  ├─ fetchExitSignalHits                ← 复用，粒度 per-signal → per-tsCode
  └─ (旧 simulateSignal 开发期保留做等价测试，最终随等价测试转金标准快照后删)

simulator.ts (纯函数)      simulateTradeCore / decideFixedN / decideStrategy  ← 完全不动
  └─ buildHoldingDays(windowDates, quoteMap, limitMap, hitSet): HoldingDaySnapshot[]
        ← 只抽现 simulator.db.ts:108-120 的 `windowDates.map(...)` days[] 构造循环（纯逻辑）；
          不含 fetchSymbol / daysSinceList / fetchExitSignalHits（这些留编排层）。
          内部对每个 (idx, calDate)：exitSignalHit = idx > 0 && hitSet.has(calDate)
          ── 复刻现 fetchExitSignalHits 用 windowDates.slice(1) 的语义（buyDate 恒不命中）。
          新旧路径都调它 → days[] 构造零漂移。

mapWithConcurrency(items, limit, fn)  ← 极小有界并发 helper（无新依赖；放 utils 或 inline）
```

**关键**：`buildHoldingDays` 抽成共享纯 helper 是 zero-drift 的支点——新旧路径用**同一个** days 构造器。simulator.db.ts 现 222 行，新增编排约 60~80 行仍 <500；若逼近红线，把编排拆 `signal-stats.simulator.batch.ts`。

## 5. 并发模型（C，连接池对齐）

```text
PG pool 默认 max = 10（app.module.ts 无自定义，本次不改全局配置）
  ├─ 外层并发 limit = 8       （留 2 连接给落库批写 / 其它）
  └─ 单 tsCode 内 2~3 条 fetch 保持串行 await（不在内层 Promise.all）
        理由：内层 Promise.all(3) × 外层 8 = 24 连接 > pool 10 → 连接饥饿排队；
              内层并行收益（2~3 条）远小于外层（5000 组），不值得为它压低外层并发
峰值在途连接 = 8（外层各占 1）
```

并发度 8 为代码常量（必要时可调，但不引入 env 变量）。

## 6. 内存与 strategy 批量化

- **内存**：signals 数组（128万 × 2 字段）枚举阶段已全在内存，本改动不新增这部分。分组后**逐 tsCode 处理、处理完即释放该组 quoteMap/limitMap**；并发 8 → 同时最多 8 组窗口在内存（每组 ~800 行 × 几列，KB 级）。**无需流式分批**。
- **strategy 批量化**：`fetchExitSignalHits` SQL 已是"单条跨日 join、`trade_date=ANY($)`"，只把传入 dates 从单信号窗口换成 tsCode 的 unionWindow；命中日按日判定与窗口无关 → 切窗后每信号 hitSet 子集一致，**零漂移**。fixed_n 与 strategy 走同一编排，只差是否查 hitSet。

## 7. 错误处理 / 数据完整性（遵 `.claude/rules/data-integrity.md`）

- **不新增 SQL 列字面量**：fetchQuotes/Limits/ExitSignalHits 的 SQL 原样复用（列名已验证）；唯一新 SQL 是 `prefetchSymbolMap` 的 `SELECT ts_code, list_date, delist_date FROM a_share_symbols WHERE ts_code = ANY($1)`——与现 `fetchSymbol` 同表同列，**落地前仍亲查真 DB 一条样本确认列名/表名**。
- **不静默吞错**：批量 fetch 不加 `.catch(()=>[])`；查询异常向上抛，由 runner 现有 try/catch 落 `run.status=failed`（与现状一致）。
- **tsCode 缺失边界（zero-drift 检查点）**：`prefetchSymbolMap` 查不到的 tsCode → `Map.get` 返回 undefined，必须映射成与现 `fetchSymbol` 返回 `null` **完全相同**的下游行为（实现时对照现 `simulator.db.ts:98-105` 的 `sym?.listDate` / `daysSinceList=null` / `delistDate=null` 分支）。
- **空 map 不伪装成功**：某 tsCode 在 unionWindow 内 0 条 quote（停牌全程等）→ days 全 hasQuote=false → 纯函数判 insufficient_data，与现状一致。

### zero-drift 关键陷阱（亲查真源确认，实现必复刻）

1. **`daysSinceList` 是 per-signal 量，禁按 tsCode 算一次**：现 `simulator.db.ts:99-104` `daysSinceList = buyIdx − effListIdx`，`buyIdx` 随信号变，故同一 tsCode 的不同信号其值不同。批量编排里 `effListIdx`（依赖 `symbolMap[tsCode].listDate` + 全局 sseCal）可按 tsCode 缓存，但 **`daysSinceList` 必须在 per-signal 循环内用 `thisBuyIdx` 重算**。
2. **`exitSignalHit` 必须排除每信号自己的 buyDate（`windowDates[0]`）**：现 `simulator.db.ts:94` `fetchExitSignalHits(tsCode, windowDates.slice(1), ...)` —— buyDate 从不进 hitSet，故 `days[0].exitSignalHit` 恒 false。批量版改查整 `unionWindow` 后，某晚信号的 buyDate 会落在查询区间内变 true。`buildHoldingDays` 内 `exitSignalHit = idx > 0 && hitSet.has(calDate)` 复刻 `slice(1)` 语义，保证 `days[]` byte-identical（不能只保证"出场决策相同"——spec 的不变量是 days[] 逐元素一致）。等价测试须含一条"同 tsCode 多信号、中段信号 buyDate 恰为另一信号命中日"的用例覆盖此陷阱。

## 8. 测试与 zero-drift 回归（TDD，验收前提）

```text
Phase 0  锁基线（改实现之前）
  ① simulator.spec.ts 纯函数单测保持全绿（保护 simulateTradeCore/decideFixedN/decideStrategy 语义）
  ② 新增 signal-stats.batch-equivalence.spec.ts：
       mock DataSource 返回固定合成数据集（覆盖 停牌 / 退市强平 / 涨停不可买 / insufficient_data /
       多信号同 tsCode / strategy 命中 / tsCode 缺 symbol），
       断言【新批量路径 outcomes】deep-equal【旧 per-signal 路径 outcomes】
       → 单测级 zero-drift 直接证明（开发期保留旧路径专为此）

Phase 1  实现 A+D+C + strategy 批量

Phase 2  验收
  ① pnpm --filter @cryptotrading/server build 通过
  ② pnpm --filter @cryptotrading/server exec jest signal-stats 全绿（纯函数 + 等价 + runner 编排）
  ③ 重启后端（dev 无 --watch，必须重启进程才生效，端到端前确认跑最新代码）
  ④ E2E zero-drift：重跑 kdj_j_lt_-10_2023-2026 配置（~9万信号，较快）
       → 与库内【已完成金标准 run】按 (ts_code, signal_date) join 逐行 diff：
         ret / buy_date / exit_date / exit_reason / hold_days 必须全等；
         聚合 win_rate / payoff / PF / kelly / filtered_count 逐字段相等
  ⑤ 性能对照：J<20（~128万，最重）记录优化前后 wall-clock，确认数量级下降
```

等价测试通过 + E2E diff 全等后，删除旧 `simulateSignal`，等价测试转为新路径金标准快照冻结（不留死代码）。

**E2E diff 参考 SQL**（按 ts_code+signal_date 对齐两 run，列出差异行）：

```sql
-- :old / :new 替换为金标准 run_id 与新跑 run_id
SELECT a.ts_code, a.signal_date,
       a.ret  AS old_ret,  b.ret  AS new_ret,
       a.exit_reason AS old_reason, b.exit_reason AS new_reason,
       a.hold_days AS old_hold, b.hold_days AS new_hold
  FROM signal_test_trade a
  FULL JOIN signal_test_trade b
       ON a.ts_code=b.ts_code AND a.signal_date=b.signal_date
      AND b.run_id=:new
 WHERE a.run_id=:old
   AND (a.ret IS DISTINCT FROM b.ret
     OR a.buy_date IS DISTINCT FROM b.buy_date
     OR a.exit_date IS DISTINCT FROM b.exit_date
     OR a.exit_reason IS DISTINCT FROM b.exit_reason
     OR a.hold_days IS DISTINCT FROM b.hold_days);
-- 期望：0 行
```

## 9. 范围边界（明确不做）

- **不做方向 B**（窗口收窄）——零漂移，A 已吃掉其收益。
- **不动落库**（已批量）、**不动枚举阶段**（4 分钟，非瓶颈）、**不改纯函数签名/语义**。
- **不加出场阶段进度推送**——run 状态同步是独立交接 `prompts/sync-signal-stats-run-status.md` 的事，本次不耦合。
- **不改全局连接池配置**。

## 10. 验收标准（汇总）

1. **zero-drift（核心）**：等价单测 deep-equal 全绿；E2E diff SQL 返回 0 行；聚合指标逐字段相等。
2. **性能**：出场模拟阶段耗时数量级下降（小时/数十分钟 → 分钟级），记录优化前后 wall-clock。
3. `pnpm --filter @cryptotrading/server build` 通过 + 重启；`jest signal-stats` 全绿。

## 11. 实现任务拆分（供 subagent-driven-development）

按"互不相交文件域"切，避免并行覆盖：

- **T1（纯函数域，`simulator.ts`）**：抽 `buildHoldingDays(windowDates, quoteMap, limitMap, hitSet): HoldingDaySnapshot[]` 共享纯 helper（只搬现 `simulator.db.ts:108-120` 的 days[] 构造循环；内部 `exitSignalHit = idx>0 && hitSet.has(calDate)` 复刻 slice(1) 语义；不接触 sseCalendar / listDate / daysSinceList）；不改三个 decide* 函数签名/语义。**交付物含 `buildHoldingDays` 的确切导出签名作为给 T3 的契约**，避免并行期签名漂移。
- **T2（并发 helper）**：新增 `mapWithConcurrency(items, limit, fn)`（极小，无新依赖）+ 单测。
- **T3（DB 访问域，`simulator.db.ts`）**：新增 `simulateSignalsBatched` 编排 + `prefetchSymbolMap`；fetchQuotes/Limits/ExitSignalHits 改 per-tsCode unionWindow；**per-signal 循环内重算 `thisBuyIdx` / `windowDates` / `daysSinceList`（daysSinceList 禁按 tsCode 算一次，见第7节陷阱1）**，调 T1 的 `buildHoldingDays` 后 `simulateTradeCore({tsCode,signalDate,days,daysSinceList,delistDate,exit})`；保留旧 simulateSignal（开发期）。依赖 T1、T2。
- **T4（等价测试）**：`batch-equivalence.spec.ts`，新旧路径 deep-equal。依赖 T3。
- **T5（runner 域，`runner.ts`）**：阶段5 改调 `simulateSignalsBatched`，保留 outcomes→trades/filterCounts 聚合。依赖 T3。
- **T6（收尾）**：build + jest + 重启 + E2E zero-drift diff + 性能对照；diff 全等后删旧 simulateSignal、等价测试转金标准快照。

依赖序：T1‖T2 → T3 → T4‖T5 → T6。

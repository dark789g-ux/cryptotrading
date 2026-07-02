# 数据同步设计规范

通用同步设计规则，适用于 Tushare / Yahoo Finance 等数据源的行情、指标、基本面同步。

---

## 1. 遍历范式：按 `trade_date` 批量优先于按 `ts_code` 逐只

**规则**：同步行情数据时，优先选择按 `trade_date` 批量拉取，而非按 `ts_code` 逐只串行。

**判断流程**：
1. 查接口官方文档（通过 `tushare-sync-dev` skill），确认 `trade_date` 是否为可选入参。
2. 确认单次返回上限（如 `fund_daily` 5000 行、`fund_adj` 2000 行）。
3. 对比标的数量（如 ETF ~1610 只）—— 若单次上限 >= 标的数，则按 `trade_date` 批量无需分页。

**例外**：仅支持 `ts_code` 入参、不支持 `trade_date` 的接口才逐只。

**反例 / 教训**：ETF 日线同步原实现按 `ts_code` 逐只串行（1610 只 x 2 接口 = 3220 次 HTTP），单日 ~11 分钟。且裸 `for + await` 让 `TushareClientService` 全局 `pLimit(5)` 失效（串行中每次只有 1 个 pending promise，limit 从未触及），实际退化为完全串行。改为按 `trade_date` 并发后降至 ~30 秒。

---

## 2. 并发：`Promise.all` + 全局 `pLimit`，禁裸 `for + await`

**规则**：多个独立请求（如多个交易日、多只标的）必须用 `Promise.all` / `Promise.allSettled` 并发发出，让 `TushareClientService` 的全局 `pLimit(5)` 真正生效。

**禁**：裸 `for + await` 循环逐个请求——每次循环体内只有 1 个 pending promise，`pLimit` 永远不会积攒到 5 个并发槽位。

**正确写法**：
```ts
// ✅ 并发：pLimit 可同时调度 5 个请求
await Promise.all(tradeDates.map(async (td) => {
  const rows = await runWithRetry(() => client.query('daily', { trade_date: td }, FIELDS), ...);
  // 处理 ...
}));

// ❌ 串行：每次只有 1 个 pending promise，pLimit 失效
for (const td of tradeDates) {
  const rows = await runWithRetry(() => client.query('daily', { trade_date: td }, FIELDS), ...);
}
```

---

## 3. 复用 `_shared` 工具，禁重复造轮子

**规则**：`market-data/_shared/sync-helpers.ts` 已提供 `runWithRetry` / `deduplicateBy` / `batchUpsert`；`a-shares/sync/a-shares-sync-utils.ts` 提供 `resolveOpenTradeDates`。新同步代码必须优先复用，禁止另起炉灶。

**反例 / 教训**：ETF catalog 步曾自造 `batchUpsertEntities`（用 `createQueryBuilder().insert().orUpdate()`），因列名映射不一致导致 `column tsCode does not exist`（TypeORM insert 用实体属性名，orUpdate 的 conflict target 用 DB 列名，混用必炸）。`_shared/batchUpsert` 用 `repo.upsert()` 统一处理映射。

---

## 4. 派生指标时序：依赖「范围内最值」的派生需两阶段

**规则**：当派生指标的计算依赖「整个日期范围内的最值」（如 qfq 前复权的分母 `latestAdj` = 范围内最新交易日的复权因子），必须采用两阶段设计：

- **Phase 1**：并发拉取所有依赖数据（如 `fund_adj`），攒入 map，预算最值。
- **Phase 2**：并发拉取主数据（如 `fund_daily`），结合 Phase 1 的预算结果计算派生值。

**禁**：在流式处理中假设「当前行是最后一行」来计算最值——按 `trade_date` 并发时，先到的日期不一定是最后一个交易日。

**参考**：[.claude/rules/derived-metrics.md](../../.claude/rules/derived-metrics.md) —— 嵌入源 step 收尾 vs 独立成 step 的判据。

---

## 5. 过滤非目标标的：`trade_date` 批量返回全市场

**规则**：按 `trade_date` 批量查询返回的是**全市场**数据（如 `fund_daily` 返回所有基金，含 LOF、封闭式等），必须用 `trackedSet`（目标标的集合）过滤。

**两处过滤**：
- Phase 1 拉复权因子时：`if (!trackedSet.has(r.ts_code)) continue`
- Phase 2 拉日线时：`rows.filter((r) => trackedSet.has(r.ts_code))`

**不过滤的后果**：非 ETF 基金数据污染 `raw.fund_daily` 表，后续查询 / 指标计算出错。

---

## 6. 数据完整性

**规则**：同步任务必须遵守 [data-integrity.md](../../.claude/rules/data-integrity.md) 的全部硬规则，核心要点：

1. **空数据双路径 warn**：`payload.data === null` 和 `payload.data.items.length === 0` 都要 warn。
2. **禁 `.catch(() => [])`**：错误必须在响应体 `errors` / `failedItems` 字段透出。
3. **接口名 / 上限 / 积分必查 `tushare-sync-dev` skill**：禁止凭变量名 / 注释 / 历史代码推断接口名称。
4. **fetcher 返回 0 行必须显式 `failedItems`**：`code=0 + 0 行` 是另一种伪装成功。
5. **行级硬约束**：业务上不允许 NULL 的列，每一行都非空。
6. **批量返回达上限必须 warn**：按 `trade_date` 批量拉取（如 `fund_daily` / `fund_adj`）返回的是**全市场**数据，若 `rows.length >= 接口上限`（如 5000 / 2000）必须 `logger.warn`——Tushare 达上限会**静默截断**不报错，tracked 标的可能丢数据。warn 不阻断（可能恰好未截断），但提示人工排查。
7. **部分缺失（部分行）必须对账 actual vs baseline**：第 4 条「0 行 failedItems」覆盖了 `code=0 + 0 行` 的伪装成功，但 `code=0 + 非空却残缺`（如 `moneyflow_ths` 当日返回 5184 行、应有 ~5517）是**更隐蔽的伪装成功**——fetcher 既不抛错、返回也不为 0，`{success: 5184, errors:[]}` 直接被当成功，缺的 333 只潜伏到用户查数据时才暴露。规则：按 `trade_date` 批量拉取的同步，写入后必须对账「实际入库行数 vs 期望基准」——基准选同日已落库的权威全量数据集（`money_flow_stocks` / `raw.stk_limit` 对账 `raw.daily_quote` 当日行数；`raw.fund_daily` 因返全市场基金而对账 `raw.etf_symbol WHERE tracked=true` 总数）；`actual < baseline` → push `errors`（apiName 标 `xxx_incomplete`，如 `moneyflow_ths_incomplete`）→ orchestrator 据此 `failed`，**禁静默 success**；基准当日未落库（`baseline = 0`）跳过不误报。复用现成 helper：`a-shares/sync/a-shares-sync-completeness.ts` 已抽通用版 `_shared/dataset-completeness.ts`，提供 `collectCompletenessErrors`（POST-sync 批量告警）与 `isDatasetComplete`（PRE-sync 门控），禁重写。**教训**：排查「北方华创净流入为空」发现 `moneyflow_ths` 当日 5184/5517 静默成功，全链路只有「抛错」和「0 行」两种异常信号，残缺行既不抛错也不为 0。参考 [data-integrity.md](../../.claude/rules/data-integrity.md)「数据集完整性最弱可接受标准」。
8. **对账基准必须与数据源实际覆盖范围一致**：第 7 条只规定「选权威全量数据集当 baseline」，但若被对账接口**本身不覆盖**某些标的，baseline 却仍用全量，对账会**永误报**——每天 failed，等于告警失效。规则：选完 baseline 表后必须再核对「baseline 全量」是否真等于「该数据源理应覆盖的全集」，凡数据源不覆盖的子集（如 `moneyflow_ths` 不覆盖北交所 `.BJ` 与退市股 `name LIKE '%退%'`）必须用 `filter` 从 baseline 排除。`_shared/dataset-completeness.ts` 的 `baseline.filter` 是**配置常量字符串**（不含用户输入，与 `trade_date = ANY($1::text[])` 参数化分开拼接），原样拼进 WHERE，支持含子查询的复杂 filter。**教训**：`money_flow_stocks` 初版 baseline 用 `raw.daily_quote` 当日全量 COUNT，实测 `moneyflow_ths` 不覆盖 327 只（323 北交所 100% 缺 + 4 退市股全缺），对账**每天报 327 只残缺**——收窄为 `vol > 0 AND ts_code NOT LIKE '%.BJ' AND ts_code NOT IN (SELECT ts_code FROM a_share_symbols WHERE name LIKE '%退%')` 后基准 = 5190 = 当日入库行数，对账正常通过。**判据**：写 baseline config 前先问「被对账接口理应返回哪些标的？baseline 全量是否包含它不该返回的标的？」，命中即加 `filter`。

---

## 7. 增量跳过判据：禁用「任意一行存在」，落到业务完整行 / 行数对账

**规则**：增量同步在入口过滤「已存在」以跳过重抓时，判据**禁**用「该标的 / 该日已有任意一行存在」——这种判据只看「有无」不看「够不够 / 完不完整」，残缺数据会被整只 / 整日跳过、永不再补。判据必须落到下列之一：

1. **逐只查接口**（交易所 PCF / 部分 Tushare 基本面，见规则 1 例外）：入口处批量查 DB 已存在 `ts_code` 集合过滤 `todo`（参考 `etf-pcf.service.ts:getExistingPcfCodes`），判据基于**业务完整行**——ETF PCF 的业务完整 = 至少一条成分股行（`conCode <> ''`），**清单头行（`conCode=''`）不算**。
2. **按 `trade_date` 批量拉取接口**（`daily` / `moneyflow_ths` / `stk_limit` / `fund_daily` 等）：行数对账（actual vs baseline，见第 6 节第 7 条），残缺日判不完整以触发补齐；或必须提供 overwrite 入口强制重拉（见第 9 节）。

**两类病灶是同一问题的两面**（只看「有无」不看「够不够」）：
- **逐只查**（`etf-pcf.service.ts:getExistingPcfCodes`）：按 `ts_code` 过滤，假设「client 原子返回完整 PCF」——对 SSE client（`fetchSsePcf` 两个独立 sqlId 各自 try/catch）**不成立**，「清单头成功落库 + 成分股请求失败」的残缺数据（只头行）被下次增量误判已同步，**永不再补**。
- **按 `trade_date` 批量**（`money-flow-sync.helpers.ts:filterExistingDates`）：按「该日已有任意行」**整日过滤**、不看完整性——当日返回 5184/5517 的残缺日会被整日跳过，缺的 333 只永远补不上。

**判据红线**：判据必须独立于 client 实现细节，落在 DB 行级业务语义（逐只）或行数对账（批量）上。**禁**假设「client 原子返回完整数据」。

**修复方向**（最好兼有）：跳过判据换成 `isDatasetComplete` 门控（`_shared/dataset-completeness.ts`），残缺只 / 残缺日自动补齐（与 `a-shares` 的 `shouldSyncDataset` 一致）；并保留 overwrite 入口（第 9 节）作人工兜底。

---

## 8. 编排层 syncMode 必须透传，禁硬编码

**规则**：一键同步（`one-click-sync`）等编排层，`syncMode: 'incremental' | 'overwrite'` 必须由 `StepContext` 携带、各 runner 读 `ctx.syncMode` 透传给底层 service **已有的 `syncMode` 入参**，**禁止在 runner 里硬编码 `'incremental'`**。

**为什么**：「service 支持 overwrite、编排层却硬编码 incremental」是高发隐患——service 的 overwrite 分支（如 `money-flow-sync.service.ts`「overwrite 模式：跳过增量过滤」）早已写好，但 `step-runners.ts` 把它（及其余 8 个 step）全硬编码成 incremental，等于把 service 的 overwrite 能力**整条旁路**。一旦再叠上「部分缺失静默成功」（第 6 节第 7 条）+「incremental 整日跳过残缺日」（第 7 节），用户**没有任何入口**能补上数据——底层能力再强也够不着。

**正确写法**：
```ts
// ✅ StepContext 携带 syncMode，runner 透传给 service
interface StepContext {
  syncMode: 'incremental' | 'overwrite';
  // ...
}
function runMoneyFlow(ctx: StepContext) {
  return moneyFlowService.syncStocks({ syncMode: ctx.syncMode, /* ... */ });
}

// ❌ runner 硬编码 incremental，把 service 的 overwrite 分支整条旁路
function runMoneyFlow(ctx: StepContext) {
  return moneyFlowService.syncStocks({ syncMode: 'incremental', /* ... */ });
}
```

**复用既有二值范式**：项目 7+ 模块已统一 `'incremental' | 'overwrite'` 二值（`a-shares` / `money-flow` / `etf` / AMV 族 / 指数日线等），编排层直接读 `ctx.syncMode` 透传，**禁造新词**、禁在编排层引入第三种模式。

**聚合 / 计算型 step 的特殊性（亲查，勿假设）**：聚合 step 是否真支持 overwrite，取决于其**落库 helper 有无 incremental 跳过分支**，不能假设「聚合 = 每次全量重算」：
- `etf-mf` 用 `INSERT ... ON CONFLICT DO UPDATE` 全量 upsert（无跳过），syncMode 真 no-op——加 `syncMode?` 仅 API 一致 + 日志。
- `etf-amv` 经 `persistAmvDaily` 落库，该 helper 的 incremental 分支会按 `(tsCode, tradeDate)` 跳过已有——**必须把 syncMode 透传到 `persistAmvDaily`**，否则 overwrite 不生效（曾被误判为 no-op，实查纠正）。

**反例 / 教训**：13 个 step 里 9 个底层 service 已支持 overwrite，但 `step-runners.ts` 全硬编码 incremental，导致 money-flow 的 overwrite 分支被旁路——排查「北方华创净流入为空」时，即使 service 层有补数据能力，编排层也把它堵死了。详见 `one-click-sync/step-runners.ts` `StepContext`、`one-click-sync-orchestrator.service.ts` `orchestrate`。

---

## 9. 检查清单（新增同步模块时逐条过）

- [ ] 查文档确认接口名、入参、单次上限、积分要求
- [ ] 判断遍历范式（`trade_date` 批量 vs `ts_code` 逐只）
- [ ] 用 `Promise.all` + `runWithRetry` 并发，禁裸 `for + await`
- [ ] 派生指标是否依赖「范围内最值」→ 是则两阶段
- [ ] 全市场接口是否需要 `trackedSet` 过滤
- [ ] 复用 `_shared` / `a-shares-sync-utils` 工具，不自造
- [ ] 空数据 push `errors`，禁 `.catch(() => [])`
- [ ] 直接用 `batchUpsert`（内部已按 conflictKeys 去重），无需外层再调 `deduplicateBy`
- [ ] 批量拉取返回行数 `>= 接口上限` 时 `logger.warn`（防静默截断）
- [ ] 逐只查接口：入口批量查 DB 过滤 `todo`；增量判据落到**业务完整行**（如 PCF 成分股行 `conCode <> ''`），禁用「任意一行存在」
- [ ] logger 带 `apiName` + 关键参数，方便排查
- [ ] 按 `trade_date` 批量拉取的同步，写入后对账 actual vs `daily_quote`（或 `etf_symbol.tracked`）基准，部分缺失 push `errors`（apiName `xxx_incomplete`），禁静默 success
- [ ] baseline 选型后核对覆盖范围：若被对账接口不覆盖某些标的（如 `moneyflow_ths` 不覆盖北交所 / 退市股），baseline 必须用 `filter` 收窄到「数据源覆盖子集」，禁用全量 baseline（永误报）
- [ ] 编排层 runner 禁硬编码 `syncMode`，必须读 `ctx.syncMode` 透传给底层 service
- [ ] 聚合 / 计算型 step 接 overwrite 前，**亲查落库 helper 有无 incremental 跳过分支**（如 `persistAmvDaily`），勿假设「聚合 = 全量重算 = no-op」

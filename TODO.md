# TODO：7/7 Tushare `daily` 同步截断修复

## 背景与根因（已排查确认）

- 现象：A 股股票列表页中芯国际（688981.SH）等标的在 `latest=20260707` 这天 OBV5D/10D/20D（及整行 MA/close/…）为空。
- 根因：**Tushare `daily(trade_date='20260707')` 平台侧只返回 5000 行**（应 ~5517）。7/6 等历史日完整返回 5517；同日 `daily_basic`(5595)、`adj_factor`(5536) 均正常 → 排除客户端限流/网络，是 `daily` 接口 7/7 当天异常。
- 代码缺陷：
  - `apps/server/src/market-data/a-shares/services/tushare-client.service.ts:81` 只校验 `code===0 && items.length>0`，**不对比预期行数**，5000 行被静默接受。
  - `apps/server/src/market-data/a-shares/sync/a-shares-sync.service.ts:112` `mergeChangedDates(changedRanges, result.tsCodes, ...)` 只对「Tushare 实际返回的」打 dirty → 缺失的 542 只不打 dirty、指标不重算，彻底隐形。
  - `count===0` 的 `daily_empty` 告警（service.ts:113）被 5000>0 绕过，未告警。
- 影响面：缺失 542 只 = 北交所(920) 324/324 全缺 + 科创板(688) 196/611 + 主板/创业板 22 只（多为 `*ST`/退市，疑真停牌）。真正需补 ≈ 520 只。

> 执行顺序：**C（先确认是否仍截断）→ A（止血补数）→ B（代码加固）**。
> 理由：A 的补数依赖「当前 daily 能否拿全」（C 的结论）；若 Tushare 仍截断，A 需改用「按 ts_code 分批」而非「按 trade_date 整拉」。

---

## C. 深挖 `daily` 截断原因（A 的前置）

> 目标：判定 7/7 截断是「偶发」还是「将持续」。直接决定 A 用哪条补数路径。

- [x] **C1 复跑验证**：用 Tushare token 直接调 `daily(trade_date='20260707')`，确认当前返回行数（是否仍 5000）。
      ```bash
      # 用 curl 或 python tushare pro_api 调，fields 同 DAILY_FIELDS
      # 记录返回行数 N。N≈5517=已恢复；N=5000=仍截断。
      ```
- [x] **C2 对照实验**：同 token 调最近交易日（如 `20260708` 或最新开市日）`daily(trade_date=...)`，看是否仍卡 5000。
- [x] **C3 跨接口对比**：确认同日 `daily_basic`/`adj_factor` 仍正常返回 >5000 行（排除 token 权限/全局限流）。
- [x] **C4 外部归因**：查 Tushare 公告/社区（tushare.pro 公告、QQ 群、GitHub issues）7/7 前后是否有 `daily` 故障、限流策略变更或默认 limit 调整。
- [x] **C5 结论归档**：在本文档底部「C 结论」区写下判定（偶发 / 持续）+ 依据，用于指导 A 的路径选择。

---

## A. 补同步缺失数据（紧急止血）

> 前置：C1/C2 确认 `daily` 已恢复正常返回（≥5500 行）。若仍截断，跳到 A-alt。

- [ ] **A1 圈定补数名单**：从 542 只中剔除「真停牌/退市」，得到真正需补的名单（预计 ~520 只）。
      ```sql
      -- 停牌判定：7/6 有行情但 7/7 缺，且名称含 ST/退市，或连续多日无行情
      SELECT s.ts_code, s.name, s.market
      FROM a_share_symbols s
      CROSS JOIN (SELECT MAX(trade_date) td FROM raw.daily_quote) l
      LEFT JOIN raw.daily_quote q ON q.ts_code=s.ts_code AND q.trade_date=l.td
      WHERE s.list_status='L' AND q.trade_date IS NULL
        AND s.name NOT LIKE '%退市%' AND s.name NOT LIKE '%ST%'
      ORDER BY s.market, s.ts_code;
      -- 人工复核：对照这些票 7/6 是否有行情（有→确属异常缺失）
      ```
- [ ] **A2 重跑 `daily` 同步 7/7（及 7/8 若为开市日）**。
      - 入口：前端「一键同步」/ `syncWithProgress`（service.ts:59），范围 20260707~20260708，`syncMode` 强制覆盖。
      - ⚠️ 待确认：`shouldSyncDataset`（`a-shares-sync-completeness.ts`）是否会因「该日已有 5000 行」跳过该交易日；若会，需临时强制 `syncMode` 忽略完整性检测，或直接对缺失名单用 `ts_code` 维度补拉（见 A-alt）。
- [ ] **A3 验证 `daily_quote` 补齐**：
      ```sql
      SELECT count(*) FROM raw.daily_quote WHERE trade_date='20260707';
      -- 期望 ≈5517（与 7/6 持平）。复跑 688981/920xxx 是否入库。
      ```
- [ ] **A4 触发指标重算**：补拉后 `markDirtyRanges` 会把这些票的 `indicator_dirty_from_date` 置为 7/7，随后 `recalculateDirtyIndicatorsForSymbols`（`a-shares-indicator.service.ts:48`）自动续算 OBV/MA。
      - 验证 dirty 已打：
        ```sql
        SELECT count(*) FILTER (WHERE indicator_dirty_from_date IS NOT NULL) AS dirty_cnt
        FROM a_share_sync_states WHERE ts_code IN (<A1 名单>);
        ```
- [ ] **A5 验证 OBV 恢复**：
      ```sql
      SELECT ts_code, obv5d, obv10d, obv20d FROM raw.daily_indicator
      WHERE ts_code='688981.SH' ORDER BY trade_date DESC LIMIT 3;
      -- 期望 20260707 行 obv 三列非 null。
      ```
- [ ] **A6 前端联调**：刷新 A 股股票列表，确认中芯国际 OBV 列有值。

### A-alt（C 判定为「仍截断」时的替代路径）
- [ ] 改用 **按 `ts_code` 维度** 补拉（绕开 `trade_date` 整拉的 5000 截断）：
      对 A1 名单分批（如每批 100 只）调 `daily(ts_code='A,B,C,...', trade_date='20260707')`，逐批 upsert。
      - 注意：Tushare 文档「建议循环日期取全市场，不要循环 ts_code」是性能建议，非禁止；小批量补数可用。
      - 同样需对这批票打 dirty 触发指标重算（直接 UPDATE `a_share_sync_states` 或复用 `markDirtyRanges`）。

---

## B. 代码加固（防再现）

> 目标：`daily`（及同类按 `trade_date` 整拉的接口）再次部分返回时，能**检测 + 自愈 + 告警**，而非静默丢失。

> 已完成（2026-07-08）。三层防线 + 三接口全覆盖。验证：31 tests passed，tsc 零错误。
>
> **文档确认**：Tushare `daily`/`adj_factor` 输入参数无 offset/limit，不支持翻页；但支持 `ts_code` 多值（逗号分隔）。`daily_basic` **不支持** ts_code 多值（实测返回 0 行），故其 B2 降级为「重试整拉 1 次」。

- [x] **B1a PRE 门控（incremental 防线）**：`dataset-completeness.ts` 加 `toleranceRatio?` 字段；`isDatasetComplete` 行数对账从严格 `<` 改为 `total < baseline*(1-tolerance)`。三接口配置：
      - daily：baseline 从 `'self'` 改为 `{table:'a_share_symbols', filter:"list_status='L'"}` + `toleranceRatio:0.05`（独立基准，不依赖其它表）。
      - daily_basic / adj_factor：baseline 保持 `{daily_quote}`，各加 `toleranceRatio:0.02`。
      - 阈值依据：正常停牌缺口 0.45%（L 5542 - daily ~5517），截断缺口 9.8%（5000/5542），5% 判定线（5265）可靠区分。
- [x] **B1b 同步过程行数校验**：`syncDailyQuotesByTradeDate` / `syncDailyMetricsByTradeDate` / `syncAdjFactorsByTradeDate` 加 `expectedTsCodes` 参数。daily/adj_factor 基准=L 全集；daily_basic/adj_factor 基准=daily.tsCodes（daily 先同步）。缺口 >5% 标记 `partial`。
- [x] **B2 自动补拉**：新建 `a-shares-sync-backfill.ts` 的 `queryWithBackfill`（整拉→校验→ts_code 多值分批补拉，100只/批）。daily/adj_factor 用此 helper；daily_basic 不支持多值，改用「重试整拉 1 次」策略（在 fetcher 内）。
- [x] **B3 告警可见化**：三个接口 partial 时各 push `failedItem`（apiName: `daily_partial` / `daily_basic_partial` / `adj_factor_partial`）+ `logger.warn` 打印缺口/补拉数。SSE 现有机制自动推前端，status 自动降 `partial`。
- [x] **B4 dirty 兜底**：daily/adj_factor 补拉后仍缺失的票（`expectedTsCodes - result.tsCodes`）→ `mergeChangedDates` 反向打 dirty（service.ts 内）。daily_basic 不反向打 dirty（PE/PB 缺失不影响 OBV/MA 技术指标重算）。
- [x] **B5 单测**：`dataset-completeness.spec.ts` +toleranceRatio 回归（容差内→完整、低于判定线→不完整、默认0严格<、self 不受影响）；新建 `a-shares-sync-fetchers.spec.ts` 7 用例覆盖 `queryWithBackfill`（充足不补拉、缺口触发补拉、补拉部分成功、5% 边界、分批）。

---

## C 结论

> C1–C5 已完成（2026-07-08 执行）。结论如下。
> 探针脚本：`C:\Users\Lucifer\AppData\Local\Temp\opencode\probe_tushare_daily.py`（stdlib urllib，不依赖 tushare 包，可随时复跑复核）。

- **判定：偶发**（Tushare 平台侧瞬时截断，现已自愈；非持续、非账号权限/限流问题）
- **依据**：
  - **C1 复跑**：`daily(trade_date='20260707')` 当前返回 **5517 行**（截断已消失；当日同步时被截为 5000）。✅已恢复
  - **C2 对照**：`daily(20260706)=5517`（与历史一致）；`daily(20260708)=0`（当日未到 15–16 点入库窗口，属正常，非异常）。
  - **C3 跨接口**：同日 `daily_basic=5595`、`adj_factor=5536`，均 >5500 正常 → 排除 token 权限下调 / 账号全局限流；`daily_basic`/`adj_factor` 当日同步时也正常，反向印证截断只命中 `daily` 单接口。
  - **文档确认**：`daily` 单次返回上限 **6000 条/次**（[daily 接口文档](https://tushare.pro/wctapi/documents/27.md)），全市场当前 ~5517 本无需分页；当日被截到 5000（低于上限）属平台异常，非分页设计。
  - **C4 外部归因**：tushare.pro 首页/社区为 SPA，公开网页未检索到 7/7 `daily` 故障、限流策略变更或默认 limit 调整的公告；此类瞬时截断多源于平台当日数据处理波动，QQ群/社区即时渠道未覆盖。无公开佐证表明其为持续性变更。
- **A 采用路径：A 常规**（`daily` 已能整拉拿全 ≥5500 行，无需 A-alt 按 `ts_code` 分批补拉）。
  - ⚠️ 但 **B 加固仍须做**：偶发截断仍会再现，当前代码（`tushare-client.service.ts:81` 不校验行数 + `mergeChangedDates` 只对返回票打 dirty）会再次静默丢数据。

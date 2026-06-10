# 锚点 run 台账（runs-manifest）

> spec：`docs/superpowers/specs/2026-06-10-0amv-regime-strategy-design/`（02 研究协议）。
> 离线切片 SQL 的 run_id **一律从本台账复制**。

## count 预检（2026-06-11，真 DB，enumerator 同口径）

窗口 20220401–20260531，主锚 `raw.daily_indicator`，布尔列按 query-builder 口径 `(i.brick_xg)::int >= 1`：

| 族 | 档位 | 信号量 | 判定 |
|---|---|---|---|
| A | brick_xg≥1 + brick_delta>0.5 | 600,369 | ✅ 锚点定为 delta>0.5 |
| A | （参考）delta>0.66 | 544,357 | — |
| B | kdj_j<10 | 1,077,397 | ❌ 超 100 万 |
| B | （参考）kdj_j<5 | 790,638 | —（5 不在扫描档位集，不用） |
| B | kdj_j<0 | 500,915 | ✅ 锚点按梯子收为 J<0 |

**收紧记录**：族 B 锚点 J<10 → J<0（spec 梯子 J<10→J<0→J<-5 第二档）。后果：扫描档位
`J∈{10}` 无法从该锚点离线复筛，如需考察须单独建 run；族 B 离线可扫档位为 {0(锚点), -5, -10, -15}。

## 锚点 run 配置（公共部分）

- 窗口：20220401–20260531；标的池：`universe: {"type":"all"}`（复制 04L2，核查点 6）。
- 入场（锚点身份核心，不带任何 oamv 条件）：
  - 族 A：`[{brick_xg gte 1}, {brick_delta gt 0.5}]`
  - 族 B：`[{kdj_j lt 0}]`
- 命名：`0amv-anchor-{A|B}-exit{1..9}`。

## 出场配置编号

| # | exit_mode | 参数 |
|---|---|---|
| 1 | trailing_lock | max_hold=null |
| 2 | trailing_lock | max_hold=10 |
| 3 | trailing_lock | max_hold=20 |
| 4 | fixed_n | N=5 |
| 5 | fixed_n | N=10 |
| 6 | fixed_n | N=20 |
| 7 | strategy | 卖出 `kdj_j gt 90`，max_hold=20 |
| 8 | strategy | 卖出 `close lt ma10`（field 比较），max_hold=20 |
| 9 | strategy | 卖出 `oamv_macd lt 0`，max_hold=20（首跑前小窗口 smoke 复验大盘字段出场） |

## 配置 9 smoke（大盘字段出场可用性复验，2026-06-11）

test `9da81847-0315-4e11-908d-86951117ec0d` / run `481349d8-ed71-44db-82d5-0c6d2c60eeaf`，
窗口 20250101–20250331，族 A 入场 + strategy 出场 `oamv_macd lt 0` + maxHold 20。
结果：completed，33771 样本，exit_reason = signal 27743 / max_hold 6028，
**所有 signal 出场日的大盘 amv_macd 均 <0（0 条违例）**——核查点 1 真机复验通过。
（注：smoke 窗口 kelly 无研究意义，不作任何结论。）

## 出场配置 8 变更记录

原设想 `close lt ma10`：ma10 不在 `ASHARE_FIELD_COL_MAP`（仅 ma5/30/60/120/240/bbi），
2026-06-11 落源头核实后改为 `close lt bbi`（BBI 多空线，速度最接近 ma10），spec 02 已同步。

## 已建方案 test id（2026-06-11 批量创建，run id 待批次完成回填）

| 名称 | test id | | 名称 | test id |
|---|---|---|---|---|
| A-exit2 | `5aa8c70a-c27e-4f00-8207-b1ef685c036f` | | B-exit1 | `0916c088-d747-4015-bd14-a821129f739e` |
| A-exit3 | `2d04f712-4349-4b74-8695-62750965a770` | | B-exit2 | `4584fd71-35f7-4d09-8e6d-66842bdc1392` |
| A-exit4 | `dee2fadf-d53a-435b-9043-acabc54a984e` | | B-exit3 | `3a93e6a9-7b57-46f6-a46a-35add79c8ec7` |
| A-exit5 | `31229113-e948-47b3-8bef-fb5d04d5828e` | | B-exit4 | `a8f79e34-e0b9-48ae-a2a6-fe373edb7198` |
| A-exit6 | `7785934a-1223-4df6-a16f-aef0076d6b85` | | B-exit5 | `89003cec-cd81-482f-840f-f6e3bbc3a65d` |
| A-exit7 | `8806d978-d12a-4617-bace-5c07aa91998d` | | B-exit6 | `66c3caa8-cd84-4cb9-b85f-3d54a9ef7314` |
| A-exit8 | `1cfa979b-9071-4e3b-8589-210d285cdf3c` | | B-exit7 | `ada28bf4-5fb5-4acb-a53e-a5402900618e` |
| A-exit9 | `c6e977b6-ec03-4b84-90f1-c6924f7bdf52` | | B-exit8 | `3ae83bdf-7753-4d01-8c84-b1ded85f3c32` |
| | | | B-exit9 | `b8043d6e-7ee1-4c63-a42a-e359468cc40e` |

## run 台账

| 名称 | 族 | 出场 | test id | run id | 建跑日期 | 状态 | sample_count | 耗时 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 0amv-anchor-A-exit1 | A | #1 trailing_lock mh=null | `b82a2710-40ce-4910-bae4-b8c96966d545` | `df0d1d0f-0f27-472d-9d20-9c73ad72da04` | 2026-06-11 02:43 | completed | 589623（filtered 10746，progress_total 600369=预检逐位对账✓） | 8m22s | kelly 0.0398 / win 28.58% / payoff 2.90 / hold 2.4d；排程基准→17 run 串行≈2.4h |

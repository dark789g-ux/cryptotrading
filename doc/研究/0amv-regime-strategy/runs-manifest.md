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

## run 台账（2026-06-11 全部完成；每行 n+filtered 均=预检值，逐位对账✓）

全周期（20220401–20260531）宽入场聚合指标，**仅作出场族横向预览，正式结论以 M2 train窗×象限切片为准**：

| 名称 | run id | n | filtered | win | payoff | kelly | hold | 耗时 |
|---|---|---|---|---|---|---|---|---|
| A-exit1 trailing mh∞ | `df0d1d0f-0f27-472d-9d20-9c73ad72da04` | 589623 | 10746 | 0.2858 | 2.90 | 0.0398 | 2.4 | 8m22 |
| A-exit2 trailing mh10 | `754e320c-25f4-4d99-8b13-c6b1dbc923cc` | 589668 | 10701 | 0.2859 | 2.89 | 0.0391 | 2.3 | 10m18 |
| A-exit3 trailing mh20 | `598a1390-e816-4106-bdca-b63d1a37b8fd` | 589638 | 10731 | 0.2858 | 2.91 | 0.0402 | 2.4 | 9m32 |
| A-exit4 fixed_n5 | `e70229d5-edce-434a-a369-48dc1f8042ae` | 587765 | 12604 | 0.4842 | 1.26 | 0.0749 | 5.0 | 8m17 |
| A-exit5 fixed_n10 | `6a24e657-17fb-4558-a299-1683516db8e0` | 585038 | 15331 | 0.4853 | 1.32 | 0.0944 | 10.0 | 8m03 |
| A-exit6 fixed_n20 | `5225febc-64d9-4a87-93bd-b51e1bf3d3ea` | 579453 | 20916 | 0.4864 | 1.45 | 0.1320 | 20.0 | 8m47 |
| A-exit7 KDJ>90 | `a13dd1b4-c828-42a8-83ef-626b6ced1ced` | 583212 | 17157 | 0.6272 | 0.71 | 0.0995 | 10.6 | 9m50 |
| A-exit8 跌破BBI | `d9bb387f-e6f7-4942-9ba3-7d295cb9883f` | 588938 | 11431 | 0.3792 | 1.97 | 0.0637 | 9.6 | 10m02 |
| A-exit9 大盘恶化 | `90e88e34-4b84-4f2d-a78e-c64e6a6f367b` | 579588 | 20781 | 0.4876 | 1.88 | **0.2144** | 6.7 | 9m26 |
| B-exit1 trailing mh∞ | `991d271d-1a9b-4084-98da-381eb91f598c` | 488444 | 12471 | 0.3164 | 2.59 | 0.0521 | 2.4 | 8m42 |
| B-exit2 trailing mh10 | `d08256cf-2287-447a-95da-b1b5f1d550b4` | 488466 | 12449 | 0.3164 | 2.55 | 0.0487 | 2.3 | 9m01 |
| B-exit3 trailing mh20 | `d3ecb4b8-f0f9-480b-bb97-e08a1d37f08b` | 488446 | 12469 | 0.3164 | 2.58 | 0.0516 | 2.4 | 8m00 |
| B-exit4 fixed_n5 | `4c46c171-28a5-4392-b8c3-04031608ab1f` | 484881 | 16034 | 0.5020 | 1.23 | 0.0980 | 5.0 | 9m23 |
| B-exit5 fixed_n10 | `102e7304-a498-48ba-bab2-b7d7c52e0432` | 478971 | 21944 | 0.4899 | 1.24 | 0.0795 | 10.0 | 8m29 |
| B-exit6 fixed_n20 | `a1df5d54-6c4d-4e90-a738-b09f56c0259c` | 473479 | 27436 | 0.4922 | 1.46 | 0.1439 | 20.0 | 8m28 |
| B-exit7 KDJ>90 | `89d71a21-bd62-44cb-bd4a-7c3152ef2d32` | 475699 | 25216 | 0.5750 | 0.90 | 0.1005 | 12.9 | 7m46 |
| B-exit8 跌破BBI | `ba29f8f8-ab01-4ee5-90a8-11afb86255b1` | 489315 | 11600 | 0.4543 | 1.50 | 0.0910 | 6.8 | 8m25 |
| B-exit9 大盘恶化 | `3ef59aea-3296-4dc4-bc5c-2bc91a76b82f` | 474595 | 26320 | 0.5244 | 1.76 | **0.2545** | 4.8 | 7m39 |

执行事故记录：02:56 起第一批在 A3 后因自动化 tab 被浏览导航卡死 ~6h（悬空 evaluate），
09:08 v2 接管恢复；10:49 B6 触发再次撞 tab 占用，v3 改专用 tab 后顺利收尾。
全程零数据损失、零重复触发。

# 01 · 范围边界与决策记录

← 返回 [index.md](./index.md)

## 用户拍板记录（brainstorming 三轮收敛）

| 决策项 | 结论 |
|--------|------|
| 分类口径 | **复用现有细分组**（均线/KDJ·MACD/风控·波动），不另设单一「技术指标」大组 |
| 指标范围 | 起初选「全量含 0AMV + ml 因子」，经证据复核后收敛为：**Tier-1 每股指标 + 个股 AMV**；因子推迟 P2 |
| 0AMV 列 | **只上个股 AMV（`stock_amv_daily`），市场级 0AMV 不进列**（实测每行同值=噪声） |
| 量化因子 | **本期不上，留 P2**（有 asof 滞后 + 需新建 CTE 桥） |
| 交付节奏 | 一次性大 spec 全量交付（指本 spec 约定的 Tier-1 + AMV + 抽象 + 回测表，一起做一起合） |
| brick/amv 分组 | 复用细分组承载主体；brick、amv 无现有归属，**各加 1 小组**「砖块图」「活跃市值」 |

## 范围内（IN）

1. A股 screener 后端补 Tier-1 每股指标列 + 个股 AMV 列（SELECT + JOIN + 排序映射）。
2. 前端 `AShareRow` 扩字段；A股 列定义经共享目录补指标列（默认全隐藏）。
3. 新建共享「指标列定义目录」`indicatorColumnDefs.ts`；自选股改为复用以去重。
4. `columnGroupMeta` 新增「砖块图」「活跃市值」两组并补 key 映射。
5. 回测「逐K 标的指标」表重构成 `SymbolColumnDef` + 接入 `ColumnSettingsDrawer`（localStorage 持久化）。

## 范围外（OUT）

- **量化因子列**（`factors.daily_factors`：rsi_14 / bollinger_position_20d / ma_ratio_20d / momentum_* / volatility_* …）→ P2。
- **市场级 0AMV 列**（`oamv_daily`）→ 不做（语义不适合每行列）。
- **筛选条件 UI**：本期只做「显示列 + 排序」，不动 screener 的 condition builder。`RAW_CONDITION_COL_MAP` 本就含 i.* 指标映射，AMV 不进 condition map（避免 scope 蔓延）。
- **加密货币表（`CryptoSymbolsPanel`）补指标列**：crypto 行无这些指标字段，不在本期。
- 自选股持久化机制（localStorage via Pinia store）保持不变，不与 server 端 prefs 收敛。

## 指标清单分层（本期只做前两层）

### Tier-1 · 每股指标（来自 `raw.daily_indicator i`，已 JOIN，加 SELECT 即可）

```text
均线(ma):      ma5  ma30  ma60  ma120  ma240  bbi
KDJ·MACD:      kdjJ  kdjK  kdjD   dif  dea  macd
风控·波动(risk): atr14  lossAtr14  low9  high9  riskRewardRatio  stopLossPct
行情(quote):    quoteVolume10
砖块图(brick,新组): brick  brickDelta  brickXg
```

DB 列名 → 前端 canonical key（SELECT 别名）：
`i.ma5→ma5`、`i.kdj_j→kdjJ`、`i.atr_14→atr14`、`i.loss_atr_14→lossAtr14`、`i.stop_loss_pct→stopLossPct`、`i.risk_reward_ratio→riskRewardRatio`、`i.low_9→low9`、`i.high_9→high9`、`i.quote_volume_10→quoteVolume10`、`i.brick→brick`、`i.brick_delta→brickDelta`、`i.brick_xg→brickXg`（其余同名）。

### Tier-2 · 个股 AMV（来自 `stock_amv_daily sa`，需新增 LEFT JOIN）

```text
活跃市值(amv,新组): amvDif  amvDea  amvMacd
```
`sa.amv_dif→amvDif`、`sa.amv_dea→amvDea`、`sa.amv_macd→amvMacd`。

### Tier-3 · 量化因子（推迟 P2）

`factors.daily_factors`：16 因子、单版本 `v1`、最新日覆盖 ~99%。**asof 滞后**（按 job 批量跑、非保证每日，最新因子日可能落后行情日）；**无现成 ts_code 取值接口**，需在 screener SQL 加 CTE 透视 JOIN，且需新增「量化因子」组。本期不做。

## 推迟项理由

- **市场级 0AMV**：`oamv-daily.entity.ts` 唯一键仅 `tradeDate`、无 `ts_code` → 一天一行的大盘单序列。挂成每股列会让 5500 行显示同一个值，是噪声。大盘 0AMV 已有 0AMV 面板 / 四象限大盘择时承载，不需重复成列。
- **量化因子**：见上 Tier-3。本期先把"零成本/满覆盖"的 Tier-1 + 个股 AMV 做扎实，因子作为独立后续（需求更重、需谨慎处理 asof 与建桥）。

## YAGNI 守门

- 指标列**一律 `defaultVisible: false`**（A股），不撑爆默认表宽；用户按需勾选。
- 不为 brick/amv 引入新的渲染体系，复用统一数值渲染器。
- 不顺手重构自选股的持久化（store/localStorage），只复用其列定义。

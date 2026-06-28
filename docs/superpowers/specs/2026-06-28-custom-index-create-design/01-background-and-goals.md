# 背景与目标

## 背景

当前 A 股指数 sub-tab 仅展示 Tushare 同步的**外部指数**（同花顺行业/概念/大盘、申万行业），catalog 与日线均为只读镜像。用户无法在本系统中定义自己的成分 basket 并合成可查询的指数序列。

指数构建的一般方法包含：

```text
成分选取 ──▶ 权重方案 ──▶ 基期/基点 ──▶ 点位合成 ──▶ 调仓版本 ──▶ 衍生指标
    │            │              │              │              │
    │            │              │              │              └─ MA/MACD/KDJ/资金流/AMV
    │            │              │              └─ 权重版本链 + 链式链接（chain link）
    │            │              └─ 价格指数 vs 全收益指数
    │            └─ 等权 / 流通市值 / 自定义
    └─ 手动选股 / 从指数导入 / 从自选导入
```

本功能通过 **5 步向导 Modal** 在每一步嵌入简短说明卡片，既完成配置又引导用户理解各参数含义。

## 目标

1. 在 `ASharesIndexPanel` 增加第三个 sub-tab **「我的指数」**，tab 行 `#suffix` 放置 **「创建指数」** 按钮（参考 `WatchlistsView.vue` 的 `#suffix` 模式）。
2. **CreateCustomIndexModal**：5 步向导（基本信息 → 成分 → 权重 → 基期口径 → 预览确认）；编辑模式复用同一 Modal。
3. 用户保存后创建 `custom_index_*` 记录并 enqueue **`custom_index_compute`** job，SSE 推送进度。
4. 计算完成后在「我的指数」行情表展示；支持 K 线 Modal、成分股跳转、列设置。
5. 完整计算口径：价格指数 + 全收益指数、除权除息（`adj_factor`）、权重版本链、MA/MACD/KDJ/BBI/砖图、等权 SUM 资金流、AMV 副图。

## 非目标

- **不**写入现有 `index_daily_quotes` / `ths_index_catalog`（避免与 Tushare 同步数据混淆）。
- **不**支持公开/共享指数（V1 仅创建者可见）。
- **不**做自动定期调仓 cron（调仓通过编辑 + 手动重算触发；Modal 中说明版本链概念即可）。
- **不**接入 Tushare 发布/备案真实指数代码。
- **不**在 V1 支持加密标的或美股成分（仅 A 股 `a_share_symbols`）。

## 设计决策

| # | 决策 | 选定 | 理由 |
|---|------|------|------|
| 1 | 架构 | 独立 `custom-index` 模块 | 与 Tushare 镜像解耦；私有 `user_id` 过滤清晰 |
| 2 | ts_code | `CUST.{8位hex}.U` | 不与 `.SH/.SZ/.TI/.SI` 冲突；`.U` = User custom |
| 3 | 读路径 | 统一 `CustomIndexLatestRow` DTO | 复用 K 线 Modal、列偏好模式；字段对齐 `IndexLatestRow` |
| 4 | 计算 | quant-pipeline worker | 历史回算耗时长，与现有 ml.jobs 基础设施一致 |
| 5 | 权重版本 | 镜像 `index_weight` PIT 模式 | 编辑/调仓产生新 `effective_date` 版本；旧版本 `expire_date` 封口 |
| 6 | 资金流 | 等权 SUM（不用 weight 列加权） | 与现有 `aggregateIndex` 宽基口径一致 |
| 7 | Modal | 5 步 wizard（`ref step` + `v-if`） | 项目无 wizard 先例，但「指导构建」需要分步；比单页 section 更清晰 |
| 8 | Job 鉴权 | 普通用户经 `/api/custom-indices` 间接创建 job | `POST /api/quant/jobs` 为 AdminOnly，不可直接暴露 |

## 与现有模块关系

```text
现有（只读）                    新增（读写，user 隔离）
─────────────                  ──────────────────────
ths_index_catalog              custom_index_definitions
sw_index_catalog               custom_index_weight_versions
index_daily_quotes             custom_index_members
index_weight (Tushare M)       custom_index_daily_quotes
money_flow_index               custom_index_daily_indicators
active-mv (ths/sw)             custom_index_money_flow
                               custom_index_amv
```

`custom_index_amv` 为**独立表**（见 `./02-data-model.md`），不复用 `active-mv` 模块存储。

## 入口 UI 线框

```text
ASharesIndexPanel
┌──────────────────────────────────────────────────────────────┐
│  同花顺指数  │  申万指数  │  我的指数          [创建指数]    │
├──────────────────────────────────────────────────────────────┤
│  [搜索]  [刷新]  [列设置]                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 名称 │ 最新 │ 涨跌幅 │ 成分数 │ 状态 │ 操作(编辑/删除) │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

「创建指数」按钮：`n-button type="primary" size="small"`，**始终**显示于 `#suffix`（点击后若不在 custom tab 则先 `subTab = 'custom'`）。

# 04 · 前端管理页面

## 4.1 入口

`/sync`（`SyncView.vue`）现有 n-tabs（A股/美股，`:7-24`）旁加 tab「大盘宽基范围」，或作为 A 股同步面板内的子区。新建视图组件 `apps/web/src/views/sync/MarketIndexScopePanel.vue`。

## 4.2 布局

```text
/sync · 大盘宽基范围管理
┌─ 大盘宽基拉取范围管理 ─────────────────────────────┐
│ [发现候选] [仅看未加入] [隐藏疑似噪声 ☑]   [刷新]  │
├─────────────────────────────────────────────────┤
│ ▌当前范围内（N 个）   ← MarketIndexSync 读这份    │
│   000001.SH 上证指数          [移除]              │
│   000300.SH 沪深300           [移除]              │
│   ...                                            │
├─────────────────────────────────────────────────┤
│ ▌候选清单（index_basic 发现，M 个）               │
│   ┌──┬────┬──────┬────────┬──────┐               │
│   │代码│名称│ 类型 │ 噪声标签│ 操作 │              │
│   ├──┼────┼──────┼────────┼──────┤               │
│   │000016.SH│上证50│规模指数│       │[加入范围]    │
│   │000894.CSI│中证A100USD│规模│⚠跨境/外币│[加入]   │
│   │399985.SZ│中证全指│综合  │⚠已退市 │[加入]      │
│   │000888.SH│上证收益│综合  │⚠收益版 │[加入]      │
│   └──┴────┴──────┴────────┴──────┘               │
└─────────────────────────────────────────────────┘
```

## 4.3 组件结构

```text
views/sync/
└── MarketIndexScopePanel.vue        ← 新：范围管理面板
components/sync/
├── MarketIndexScopeTable.vue        ← 新：当前范围表（n-data-table + 移除）
└── MarketIndexCandidateTable.vue    ← 新：候选清单表（n-data-table + noise_tag + 加入）
```

- 参考模式：`WatchlistsView.vue`（列表+持久化）、`ASharesIndexPanel.vue`（n-data-table remote）
- 候选表 noise_tag 列：`n-tag` 彩色（退市红/跨境黄/收益版灰/重复蓝）
- 「加入范围」调 `POST /api/market-index-scope/add`，「移除」调 `POST /api/market-index-scope/remove`，成功后刷新范围表

## 4.4 「隐藏疑似噪声」开关

- `n-switch` 默认开：隐藏 `noise_tag` 含 退市/跨境/收益版 的候选（这些几乎不该进大盘范围）
- 关闭后看全量 ~158（含噪声，用户可强制勾选）
- 中小盘类（上证小盘/国证等）**不隐藏**（属合法规模指数，仅提醒，用户可选）

## 4.5 前端大盘 Tab（组件零改动，但数据源需改造）

`ASharesIndexPanel.vue`（同花顺区）的 n-select「大盘」选项数据走 `IndexCatalogQueryService.findAll('market')` → `queryMarket()`（现读常量）。**组件代码零改动**，但 `queryMarket()` 必须先改造（[02 §2.3](./02-backend.md) 改读 catalog），否则管理页面增删对前端大盘 Tab 不生效。

**时序澄清**（避免误以为「加入范围 = 立即可见」）：
- **目录清单**（n-select 大盘选项 + 表格 tsCode/name）：`queryMarket` 改造后，管理页面增删 `type='M'` → **即时生效**（下次刷新）
- **行情行**（OHLC/涨跌/量）：来自 `index_daily_quotes category='market'`，需**触发同步**（one-click `market-index-daily` step 或 `GET /api/ths-index-daily/sync/market`）才有数据——新加入的指数，同步前行情表无行

## 4.6 真机 e2e 注意

e2e 若测了「加入/移除」范围（改了 catalog `type='M'`），**验完恢复初始 8 个**（`prompts/improve-market-index-sync.md` 列的 8 个 tsCode），不在用户 DB 留脚印。

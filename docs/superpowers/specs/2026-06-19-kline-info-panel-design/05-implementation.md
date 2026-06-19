# 05 · 改动清单、测试与验证

## 5.1 新增文件

```text
apps/web/src/components/symbols/KlineWithInfoPanel.vue
apps/web/src/components/symbols/InfoRow.vue
apps/web/src/components/symbols/a-shares/AStockInfoFields.vue
apps/web/src/components/symbols/us-stocks/UsStockInfoFields.vue
apps/web/src/components/symbols/crypto/CryptoInfoFields.vue
apps/web/src/components/symbols/KlineWithInfoPanel.spec.ts
apps/web/src/components/symbols/InfoRow.spec.ts
apps/web/src/components/symbols/a-shares/AStockInfoFields.spec.ts
apps/web/src/components/symbols/us-stocks/UsStockInfoFields.spec.ts
apps/web/src/components/symbols/crypto/CryptoInfoFields.spec.ts
```

## 5.2 改动文件

| 文件 | 改动 |
|---|---|
| `apps/server/src/catalog/symbols/symbols.service.ts` | `querySymbols` SQL 补 SELECT `k.pct_chg AS "pctChg"`、`k.volume`、`k.amount` 三列（从 klines 表取，对齐 latest join） |
| `apps/web/src/api/modules/market/symbols.ts` | `SymbolRow` 类型补 `close`、`pctChg`、`volume`、`amount` 四个字段（均为 `string \| null`） |
| `apps/web/src/components/kline/KlineChartToolbar.vue` | 新增 `actions` 具名插槽，在 `.kline-toolbar__actions` 区域（齿轮按钮旁）渲染该插槽 |
| `apps/web/src/components/kline/KlineChart.vue` | 透传 `actions` 具名插槽给 `KlineChartToolbar` |
| `apps/web/src/components/symbols/a-shares/AShareDetailPanel.vue` | 用 `<KlineWithInfoPanel>` 包裹 `<kline-chart>`；caption（AMV 文案）留原位不进包装组件 |
| `apps/web/src/components/symbols/us-stocks/UsStockDetailPanel.vue` | 同上 |
| `apps/web/src/components/symbols/crypto/CryptoSymbolDetailPanel.vue` | 同上 |
| `apps/web/src/components/symbols/a-shares/aSharesFormatters.ts` | 追加 `formatVolumeRatio` 函数 |

## 5.3 不改动

- 后端 A 股 / 美股：无任何改动（字段前端已可得）
- `ResizableSplitPane`：不改（保持两栏）
- 加密 `symbols/query`：不补 base/quote asset 字段（仅补 pctChg/volume/amount）
- 现有格式化函数：不改，仅复用

## 5.4 测试策略（vitest）

沿用项目现有单测约定（`pnpm --filter @cryptotrading/web test`）。

### 5.4.1 KlineWithInfoPanel.spec.ts

```text
- 默认折叠（首次，localStorage 无值）
- 点击触发按钮展开/折叠切换
- 展开状态写入 localStorage(storageKey)
- 重渲染从 localStorage 恢复展开态
- 不同 storageKey 互不干扰（A股/美股/加密各存各的）
- 容器宽度 < 620px 时自动折叠 + 按钮禁用（mock ResizeObserver）
- 容器宽度恢复 ≥ 620px 时按钮重新可用（不自动展开）
- info slot 内容正确渲染
- kline slot 内容正确渲染
```

### 5.4.2 InfoRow.spec.ts

```text
- 渲染 label + value
- trend='up' 时 value 有 trend-up class
- trend='down' 时 value 有 trend-down class
```

### 5.4.3 AStockInfoFields.spec.ts

```text
- 渲染全部 9 字段（分类2 + 市值/估值7）
- label 含单位（如 "流通市值(亿)"）
- 市值走 formatMarketCap、PE 走 formatNumber、量比走 formatVolumeRatio
- row null → 字段列表不渲染，显示 <n-empty description="未选择标的"> 空状态
- 单字段 null → 显示 '-'
- totalMv/circMv 为 undefined 时 → 显示 '-'（验证 ?? null 规整）
```

### 5.4.4 UsStockInfoFields.spec.ts / CryptoInfoFields.spec.ts

```text
- 渲染分类（美股）+ 行情字段
- 成交量走 fmtCompact、成交额走 formatAmount
- 涨跌幅走 formatPercent + trendClass 着色
- row null → 字段列表不渲染，显示 <n-empty description="未选择标的"> 空状态
```

### 5.4.5 集成（各 DetailPanel.spec.ts 增补）

```text
- KlineWithInfoPanel 正确包裹 kline-chart
- info slot 注入对应类型的 InfoFields 组件
- caption（A 股）留原位
```

## 5.5 验证标准

- [ ] 后端 `symbols/query` 补 SELECT pctChg/volume/amount 三列，`SymbolRow` 类型补字段
- [ ] 三种标的详情面板均有 K 线右侧信息侧栏
- [ ] A 股显示 9 字段（市场板块/行业/流通市值/总市值/PE-TTM/PE/PB/换手率/量比），单位在 label
- [ ] 美股显示 6 字段（主题/类型/现价/涨跌幅/成交量/成交额）
- [ ] 加密显示 4 字段（现价/涨跌幅/成交量/成交额），且数字正确（非全 '-'，验证后端 SELECT 生效）
- [ ] 折叠后侧栏完全隐藏，仅 K 线 toolbar 留触发按钮
- [ ] 展开状态持久化到 localStorage，按标的类型区分 key
- [ ] 首次进入默认折叠
- [ ] 容器宽度 < 620px 自动折叠 + 禁用按钮
- [ ] 无过渡动画（瞬时切换）
- [ ] 字段空值显示 '-'
- [ ] 涨跌幅正绿负红着色
- [ ] A 股 AMV caption 保留原位
- [ ] 所有单测通过
- [ ] `pnpm --filter @cryptotrading/web type-check` 通过
- [ ] `pnpm --filter @cryptotrading/web lint:quant-lines` 通过（新增 Vue 单文件 ≤500 行）

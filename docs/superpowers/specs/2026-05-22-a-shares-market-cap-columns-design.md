# ASharesPanel 新增总市值 / 流通市值列

## 背景

ASharesPanel.vue 表格目前未展示个股市值数据，但：
- 后端 SQL 查询已返回 `totalMv`（总市值）和 `circMv`（流通市值）。
- 前端 `AShareRow` 接口已包含这两个字段。
- 市值数据在量化因子（市值中性化）和策略条件筛选中已被广泛使用。

因此需要在表格中暴露这两个字段，并支持通过 `ColumnSettingsDrawer` 进行显隐配置。

## 目标

1. 在 `ASharesPanel` 表格中新增"总市值"、"流通市值"两列。
2. 支持通过 `ColumnSettingsDrawer` 开启/关闭显示。
3. 默认不显示，避免表格过宽。
4. 支持点击表头按市值排序（与现有列行为一致）。

## 方案

采用**展示 + 排序**方案（方案 B）：
- 前端新增列定义。
- 后端同步新增排序字段映射。

## 改动清单

### 前端：`apps/web/src/components/symbols/a-shares/aSharesColumns.ts`

在 `createASharesColumnDefs` 返回数组中，于 `pb` 列之后、`tradeDate` 列之前插入：

```ts
{
  title: '总市值',
  key: 'totalMv',
  width: 120,
  sorter: true,
  defaultVisible: false,
  render: (row) => formatMarketCap(row.totalMv),
},
{
  title: '流通市值',
  key: 'circMv',
  width: 120,
  sorter: true,
  defaultVisible: false,
  render: (row) => formatMarketCap(row.circMv),
},
```

说明：
- 使用**新增 `formatMarketCap`** 处理 `null` → `'-'`，输入单位为"万元"，输出 `X.XX 万亿` / `X.XX 亿` / `X.XX 万`，与 daily_basic 落库口径一致。
  - **注意**：不能复用 `formatAmount`（该函数假设输入为"千元"，用于 `amount` 成交额；市值单位为"万元"，直接复用会差 10 倍）。
- `defaultVisible: false` 对应用户选择的"默认不显示，手动开启"。
- `sorter: true` 触发 Naive UI 远程排序事件，与现有列行为一致。

### 后端：`apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts`

在 `RAW_SORT_COL_MAP` 和 `QFQ_SORT_COL_MAP` 中各新增两项：

```ts
const RAW_SORT_COL_MAP: Record<string, string> = {
  // ... existing entries ...
  pb: 'm.pb',
  totalMv: 'm.total_mv',
  circMv: 'm.circ_mv',
  tradeDate: 'q.trade_date',
};

const QFQ_SORT_COL_MAP: Record<string, string> = {
  ...RAW_SORT_COL_MAP,
  close: 'q.qfq_close',
  // ... existing entries ...
};
```

说明：
- `totalMv` / `circMv` 来自 `raw.daily_basic` 表（别名 `m`），排序列直接使用 `m.total_mv` / `m.circ_mv`。
- QFQ 映射继承 RAW 映射，市值字段不受价格模式影响，无需额外覆盖。

## 数据流

```text
用户点击 "Columns" 按钮
  └──> ColumnSettingsDrawer 打开
       └──> 用户勾选/取消勾选 "总市值" / "流通市值"
            └──> useSymbolColumnPreferences 保存到后端
                 └──> ASharesPanel 的 columns computed 重新过滤
                      └──> n-data-table 渲染对应列
```

## 兼容性

- **旧用户偏好**：`normalizeScopePreferences` 会自动把新列以 `defaultVisible: false` 注入已有偏好记录，无需迁移脚本。
- **API 类型**：`AShareRow` / `AShareKlineBar` 已含这两个字段，无需修改接口定义。
- **后端查询**：`buildASharesBaseQuery` 已在 SELECT 中返回 `totalMv` / `circMv`，无需改 SQL。

## 验证步骤

1. 打开 A 股数据面板，确认默认不显示"总市值"和"流通市值"列。
2. 点击 "Columns"，勾选两列，确认表格正常显示。
3. 检查数值格式：正常应显示为 `X.XX 亿`（大市值）或 `X.XX 万`（小市值），`null` 显示为 `-`。
4. 点击"总市值"表头，确认请求参数 `sort.field=totalMv`，且返回数据按市值排序。
5. 重复步骤 4 验证"流通市值"。

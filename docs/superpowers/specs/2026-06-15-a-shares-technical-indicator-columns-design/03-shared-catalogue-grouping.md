# 03 · 共享指标列定义目录 + 分组 + 默认可见 + 持久化

← 返回 [index.md](./index.md)

这是用户要的「通用模块」的真正落点：把指标列的**定义**抽成一份，A股 / 自选股（/ 回测表）共用。注意——**列选择器抽屉 `ColumnSettingsDrawer` 本身早已是泛型通用组件**（`generic="Row"`，`:223`），不需要再抽；要抽的是各 consumer 各自重复声明的「指标列定义」。

## 1. 新文件 `indicatorColumnDefs.ts`（建议置于 `apps/web/src/components/symbols/`）

descriptor 驱动 + 一个泛型 builder。指标列绝大多数就是"格式化数字"，用统一 descriptor + 数值渲染器最干净。

### 1.1 descriptor 表（单一事实源）

```ts
interface IndicatorDescriptor {
  key: string                      // canonical key，必须与 AShareRow 字段 / SELECT 别名一致
  title: string                    // 列头与选择器显示名
  kind?: 'number' | 'signal'       // 默认 'number'；'signal' 为布尔（brickXg）按 tag(真/假) 渲染
  decimals: number                 // 小数位（kind='signal' 时忽略）
  suffix?: string                  // 如 '%'（stopLossPct）
  descKey?: string                 // FieldHelpTip conceptId（缺则无 ? tooltip）
}
```

来源全部取自 `watchlistColumnDefs.ts:237-263` 的现有定义，逐列对齐（保证去重零行为漂移）：

```text
key             title         decimals  suffix  descKey
ma5/ma30/ma60/ma120/ma240   MA5..MA240   4       -      -
bbi             BBI           4        -      bbi
kdjJ            KDJ.J         2        -      kdj_j
kdjK            KDJ.K         2        -      kdj_k
kdjD            KDJ.D         2        -      kdj_d
dif             DIF           4        -      macd_dif
dea             DEA           4        -      macd_dea
macd            MACD          4        -      macd_hist
quoteVolume10   10日成交额    2        -      -
atr14           ATR14         4        -      atr14
lossAtr14       Loss ATR14    4        -      loss_atr14
low9            Low9          4        -      -
high9           High9         4        -      -
riskRewardRatio RR            2        -      profit_loss_ratio
stopLossPct     Stop %        2        %      stop_loss_pct
-- 本期新增（自选股原本没有）：
brick           砖块          4        -      brick       ← kind=number
brickDelta      砖块Δ         4        -      brick_delta ← kind=number
brickXg         砖块信号      —        -      brick_xg    ← kind='signal'(布尔), tag 真/假, decimals 忽略
amvDif          AMV.DIF       4        -      amv_dif
amvDea          AMV.DEA       4        -      amv_dea
amvMacd         AMV.MACD      4        -      amv_macd
```

> descKey 已在 `fieldDescriptions.ts` 存在条目（brick/brick_delta/brick_xg `:41-43`、amv_dif/amv_dea/amv_macd `:61-63`），直接挂上即有 `?` 说明，**无需新增条目**。`brickXg` 为布尔信号（已核 entity `type:'boolean'`），用 `kind:'signal'` 渲染 tag（真/假），不走 `toFixed`。brick/brickDelta 小数位为提案，实现时按 `raw` 列实际量纲微调。

### 1.2 builder 签名

```ts
function buildIndicatorColumns<Row>(
  descriptors: IndicatorDescriptor[],
  opts: {
    accessor?: (row: Row, key: string) => unknown   // 默认 (row,key)=>(row as any)[key]
    blankWhen?: (row: Row) => boolean                // 命中则该单元渲染 '-'（回测表 dataStatus 守卫用）
    defaultVisible?: boolean | ((key: string) => boolean)  // 各 consumer 自定；A股=false，自选股=保留原可见集
    sortable?: boolean                                // 默认 true
    width?: number                                    // 默认 100/110
  },
): SymbolColumnDef<Row>[]
```

### 1.3 渲染器契约

统一数值渲染（与 `watchlistColumnDefs.ts` 的 `formatFixed` 等价，保证零漂移）：

```text
render(row) =
  blankWhen?.(row)                         → '-'
  v = accessor(row,key)
  kind === 'signal':                       v == null → '-'; 否则 tag(v ? '真' : '假')
  kind === 'number'(默认):
    n = Number(v); v == null || !isFinite(n) → '-'
    else                                     → n.toFixed(decimals) + (suffix ?? '')
```

- number 分支接受 `string | number | null | undefined`（A股 数值是 string、回测是 number）；signal 分支接受 `boolean | null`（brickXg）。
- `group` 不进 descriptor——分组由 `columnGroupMeta.COLUMN_KEY_GROUP` 按 key 统一解析（见 §2），单一事实源，避免两处声明分组打架。

## 2. 分组 `columnGroupMeta.ts` 改动

现有 `COLUMN_KEY_GROUP`（`:15-70`）**已映射** ma5..ma240→`ma`、bbi→`ma`、kdjJ/K/D→`kdjMacd`、dif/dea/macd→`kdjMacd`、atr14/lossAtr14/low9/high9/riskRewardRatio/stopLossPct→`risk`、quoteVolume10→`quote`。Tier-1 主体**零改**。

仅需新增两组 + 两组的 key 映射：

```ts
// COLUMN_GROUPS（:2-10）插入(位置在 'risk' 之后、'signal' 之前)：
{ key: 'amv',   label: '活跃市值' },
{ key: 'brick', label: '砖块图' },

// COLUMN_KEY_GROUP（:15-70）追加：
amvDif: 'amv', amvDea: 'amv', amvMacd: 'amv',
brick: 'brick', brickDelta: 'brick', brickXg: 'brick',
```

- `ColumnGroupKey` 联合类型由 `COLUMN_GROUPS` 推导，自动含新组。
- `DEFAULT_EXPANDED_GROUPS`（`:72`）保持 `['basic','quote']`——新指标组默认折叠，不打扰首屏。
- 抽屉按 `resolveColumnGroup(key)` 分桶、空组自动隐藏（`ColumnSettingsDrawer.vue:288-300`），所以仅声明了列的 consumer 才显示对应组。

## 3. 默认可见策略

- **A股**：全部指标列 `defaultVisible: false`（builder 传 `defaultVisible: false`）。
- **自选股**：保留现状（ma5/ma30/kdjJ/riskRewardRatio = true，其余 false），builder 传
  `defaultVisible: (k) => new Set(['ma5','ma30','kdjJ','riskRewardRatio']).has(k)`。
  → 自选股**零行为漂移**（与 `watchlistColumnDefs.ts:237-254` 现值逐列一致）。
- **回测表**：见 [05](./05-backtest-table.md)。

## 4. 持久化（零改动，已验证）

- 列偏好按 **列 key** 存：A股/crypto 走 server JSONB（`useSymbolColumnPreferences` → `PUT /preferences/symbols-view`），自选股走 localStorage（Pinia store）。
- 新增列 key 经 `normalizeScopePreferences`（`useSymbolColumnPreferences.ts:28-62`）自动并入旧偏好（未知 key 补默认、缺失 key 追加），**无迁移、旧用户偏好不丢**。
- A股 偏好旧记录里没有新 key → 按 `defaultVisible:false` 补为隐藏，用户首次打开列设置即可勾选。

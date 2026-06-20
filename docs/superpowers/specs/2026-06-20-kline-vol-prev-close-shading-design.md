# K 线副图成交量"相对前收"明暗着色设计

- **日期**：2026-06-20
- **状态**：待实现
- **作者**：brainstorming 会话
- **范围**：前端 K 线组件成交量副图（VOL）着色增强

---

## 1. 背景与目标

### 1.1 现状

K 线副图成交量柱的着色基准是**本根 K 线实体方向**（`close >= open` → 绿，否则红）：

```ts
// apps/web/src/composables/kline/klineChartOptions.ts:166-171
const volumeData = data.map((row) => ({
  value: row.volume,
  itemStyle: {
    color: row.close >= row.open ? CANDLE_COLORS.up : CANDLE_COLORS.down,
  },
}))
```

这只能反映"本根 K 线涨跌"，无法表达"今日收盘相对上一交易日收盘"的背离信息。

### 1.2 目标

在保留"实体涨跌"颜色维度的基础上，**叠加一个明暗维度**，编码"实体方向"与"相对前收方向"是否一致：

- 实色（alpha = 1.0）：实体方向与 `close vs prevClose` 方向**一致**（含首根、平盘）
- 浅色（alpha = 0.35）：二者**背离**

视觉示例（绿涨红跌，币安国际惯例）：

```text
close vs open    close vs prevClose    关系      量柱
─────────────    ──────────────────    ────      ────────────
 ≥ (涨/平)        > (涨)              一致      绿 · 实色
 ≥ (涨/平)        < (跌)              背离      绿 · 浅色
 <  (跌)          > (涨)              背离      红 · 浅色
 <  (跌)          < (跌)              一致      红 · 实色
```

### 1.3 非目标（YAGNI）

- ❌ 不做"着色模式可切换"偏好开关——全局生效，不给 VOL 加 `SubplotPrefs.params`
- ❌ 不改 FLOW 副图（按 `moneyFlow` 正负着色，与本次无关）
- ❌ 不改后端 / DTO / 数据库 schema
- ❌ 不引入第三视觉态（如描边、第三种颜色）

---

## 2. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 展示方案 | **B1 双维度明暗叠加** | 保留实体涨跌颜色，前收信息用明暗叠加，不丢失既有维度 |
| 生效范围 | **全局**（所有 9 个 KlineChart 调用点） | 不加偏好开关，简化实现 |
| "前收"语义 | **① 统一为"前一根 bar 收盘"** | `data[idx-1].close` 对所有调用点零特判；日 K 即前一日，小时 K 即前一小时（语义随 interval 自然变化，与 tooltip 现有算法一致） |
| 平盘处理 | **方案甲 · 实色** | `close === prevClose`（含容差）时前收维度无信号，静默退回单维度（实色），不引入第三态 |
| 首根处理 | **方案甲 · 实色** | 无 prevClose，同平盘处理 |
| 浅色透明度 | **0.35** | 与现有 `TRADE_COLORS.entryDim/exitDim`（0.45）拉开差距，背离柱一眼可辨 |
| 平盘容差 | **`|diff| / |prevClose| <= 1e-9`** | 避免 crypto 浮点 close 抖动把平盘误判为背离 |

---

## 3. 核心判定逻辑

对每根 K 线 `bar[idx]`，`prevClose = idx > 0 ? data[idx-1].close : null`：

```text
baseHex = (close >= open) ? CANDLE_COLORS.up : CANDLE_COLORS.down
alpha   = isConfirmed ? 1.0 : 0.35
fill    = hexToRgba(baseHex, alpha)

isConfirmed 判定（含首根/平盘）：
  prevClose == null                                    → true   (首根)
  |close - prevClose| <= |prevClose| * 1e-9            → true   (平盘)
  (close >= open) 且 close > prevClose                  → true   (同向)
  (close <  open) 且 close < prevClose                  → true   (同向)
  其余                                                  → false  (背离)
```

**两个"平"语义的区分**（避免混淆）：
- "实体涨/平"用 `close >= open`（`>=`，沿用现有口径，平开平收归涨侧）
- "平盘"特指 `close === prevClose`（精确相等 + 容差，相对前收维度）

---

## 4. 实现改动

### 4.1 新增纯函数（`klineChartUtils.ts`）

与现有 `arrow()` 同居此文件（风格一致）。新增：

```ts
import { CANDLE_COLORS } from './chartColors'
import type { KlineChartBar } from '@/api'

const VOL_BIAS_ALPHA = 0.35
const VOL_FLAT_TOLERANCE = 1e-9

/**
 * 成交量柱着色：实体涨跌决定基色，相对前收方向决定明暗。
 * - 基色：close >= open → up（绿），否则 down（红），沿用现有口径
 * - 明暗：实体方向 与 close vs prevClose 方向一致（含首根/平盘）→ 实色 (alpha=1)，
 *         背离 → 浅色 (alpha=VOL_BIAS_ALPHA)
 */
export function resolveVolumeColor(
  row: KlineChartBar,
  prevClose: number | null,
): string {
  const up = row.close >= row.open
  const baseHex = up ? CANDLE_COLORS.up : CANDLE_COLORS.down
  const alpha = isVolumeConfirmed(row, prevClose) ? 1 : VOL_BIAS_ALPHA
  return hexToRgba(baseHex, alpha)
}

function isVolumeConfirmed(row: KlineChartBar, prevClose: number | null): boolean {
  if (prevClose == null) return true
  const diff = row.close - prevClose
  if (Math.abs(diff) <= Math.abs(prevClose) * VOL_FLAT_TOLERANCE) return true
  const up = row.close >= row.open
  return up ? diff > 0 : diff < 0
}

/** '#0ECB81' → 'rgba(14,203,129,alpha)'
 *  约定：基色必须为 6 位 hex（CANDLE_COLORS.up/down 当前即此格式）。
 *  非预期格式原样返回（不带 alpha）——这会让背离柱静默退化为实色，
 *  因此若未来调整基色格式，须同步更新此正则或基色配置。 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex // 容错：非预期格式原样返回
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r},${g},${b},${alpha})`
}
```

> `hexToRgba` 独立、无外部依赖，放 `klineChartUtils.ts` 即可。**不复用** `TRADE_COLORS.entryDim/exitDim`——它们 alpha 是写死的 0.45，与本次 0.35 不同，动态算更干净。

### 4.2 消费点 1：`volumeData`（`klineChartOptions.ts:166-171`）

```ts
const volumeData: BarSeriesOption['data'] = data.map((row, idx) => ({
  value: row.volume,
  itemStyle: {
    color: resolveVolumeColor(row, idx > 0 ? data[idx - 1].close : null),
  },
}))
```

### 4.3 消费点 2：`buildVolumeText`（`klineChartOverlay.ts:68-79`）

VOL 浮动文本颜色必须与柱子同步，否则柱浅色、文字实色会割裂：

```ts
const buildVolumeText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  if (!row) return { text: '', rich: {}, ...GRAPHIC_BG }
  const prevClose = idx > 0 ? data[idx - 1].close : null
  const color = resolveVolumeColor(row, prevClose)
  return {
    text: `VOL: {vol|${fmtCompact(row.volume)}}`,
    rich: { vol: { fill: color, fontSize: 12, fontWeight: 'bold' } },
    ...GRAPHIC_BG,
  }
}
```

### 4.4 不改动的部分

- `volumeSeries`（`klineChartOptions.ts:321-328`）——只消费 `volumeData`，无需改
- FLOW 副图着色（`klineChartOptions.ts:394-414`）——按 `moneyFlow` 正负着色，与本次无关
- `SubplotPrefs` schema / `useKlineChartPrefs.ts`——不加 VOL 偏好
- 后端 / DTO / 数据库——前端 `data[idx-1].close` 统一可用

---

## 5. 影响面

全部 9 个 KlineChart 调用点统一生效，零特判、零后端改动：

```text
调用点（文件）                           粒度         "前收"语义           生效
──────────────────────────────────────────────────────────────────────────────
A 股个股详情（AShareDetailPanel）          日 K         前一交易日收盘        ✅
美股个股详情（UsStockDetailPanel）         日 K         前一交易日收盘        ✅
crypto 详情（CryptoSymbolDetailPanel）     日/时/分     前一根 bar 收盘       ✅
自选表抽屉（WatchlistTable）              日/时        同上                  ✅
美股指数（UsIndexPanel）                  日 K         前一交易日收盘        ✅
0AMV 活跃市值（ActiveMarketValuePanel）   日 K         前一交易日收盘        ✅
回测 K 线弹窗（KlineChartModal）          日 K         前一根 bar 收盘       ✅
信号单笔交易 K 线（SignalTradeKlineModal） 日 K         前一交易日收盘        ✅
资金流趋势弹窗（FlowTrendModal）          日/时        前一根 bar 收盘       ✅
```

**回测/复盘数据缺口**：停牌、跨段拼接等场景下 `data[idx-1]` 不一定是真正的"上一交易日"。

**处理**：退化为"上一根可见 bar 的收盘"，与 tooltip 现有算法（`klineChartTooltip.ts:125-129`）完全一致。

**结论**：副图量柱的"前收"基准与 tooltip 显示的涨跌幅基准始终同步，不会出现"柱子说背离、tooltip 说一致"的矛盾。可接受。

---

## 6. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| 回测/复盘数据缺口 | `data[idx-1]` 可能跨缺口 | 退化为上一根可见 bar，与 tooltip 同步（见 §5） |
| 浮点平盘容差 | crypto 浮点 close 抖动 | `VOL_FLAT_TOLERANCE = 1e-9` 相对容差，测试覆盖 |
| 视觉歧义（浅色=量小？） | 浅色柱可能被误读为"成交量小" | 0.35 是明暗差异非面积差异；验收时肉眼确认 |
| alpha 渲染性能 | 每根柱 rgba 字符串 | FLOW 已是同样模式，无性能问题 |

---

## 7. 测试

### 7.1 单测（`klineChartOptions.spec.ts`，仿 FLOW 染色用例 `:165-179`）

新增 VOL 染色用例矩阵：

```text
用例（close, open, prevClose）→ 期望 fill
─────────────────────────────────────────────────────────
首根（无 prevClose）                     → 实色（绿或红，按实体）
实体涨 且 close > prevClose（一致）       → 实色绿
实体涨 且 close < prevClose（背离）       → 浅色绿 (alpha 0.35)
实体跌 且 close < prevClose（一致）       → 实色红
实体跌 且 close > prevClose（背离）       → 浅色红 (alpha 0.35)
平盘 close === prevClose                 → 实色（不判背离）
浮点抖动 |diff| < tolerance               → 实色（验证容差生效）
```

断言辅助：`expectRgba(hex, alpha)` 工具函数，比较解析后的 r/g/b/alpha，避免把"实色 alpha=1 写成 rgba"的格式细节硬编码。

### 7.2 手动验收

1. `pnpm --filter @cryptotrading/web type-check` 全绿
2. `pnpm --filter @cryptotrading/web test` 全绿
3. A 股个股详情：肉眼确认"实体涨但相对前收跌 → 浅色绿柱"
4. crypto 小时线：确认前一根 bar 收盘作为 prevClose 生效
5. 资金流趋势弹窗（FlowTrendModal，受影响站点之一）：浅色/实色柱正常渲染
6. 深色/浅色主题下，实色 vs 浅色柱都清晰可辨（额外项）

---

## 8. 回滚

改动收敛在 3 个文件、纯前端、无 schema 迁移：

- `git revert` 单 commit 完整回滚
- localStorage 偏好不受影响（不动 `SubplotPrefs`）

---

## 9. 交付清单

```text
改动文件（3 个）：
  ├─ apps/web/src/composables/kline/klineChartUtils.ts   新增 resolveVolumeColor + hexToRgba + 常量
  ├─ apps/web/src/composables/kline/klineChartOptions.ts volumeData 消费 resolveVolumeColor
  └─ apps/web/src/composables/kline/klineChartOverlay.ts buildVolumeText 消费 resolveVolumeColor

测试（1 个文件，新增用例组）：
  └─ apps/web/src/composables/kline/klineChartOptions.spec.ts  VOL 染色矩阵（6 类 + 边界）

验收（手动）：
  ├─ 前端 type-check + vitest 全绿
  ├─ A 股个股详情：实体涨但相对前收跌 → 浅色绿柱
  ├─ crypto 小时线：前一根 bar 收盘作为 prevClose 生效
  ├─ FlowTrendModal：浅色/实色柱正常渲染
  └─ 深/浅主题下实色 vs 浅色柱清晰可辨
```

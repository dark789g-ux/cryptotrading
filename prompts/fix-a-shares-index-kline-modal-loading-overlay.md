# 修复 A股指数 K线 Modal：loading 遮罩盖住已渲染图表（T8 视觉层）

## 目标
修复 **ASharesIndexKlineModal** 真机现象：DOM 层 `canvas=1` / `[_echarts_instance_]` 已有值，但用户肉眼仍见 **黄色 loading 转圈**（`.modal-pane-overlay` 盖住 K 线），截图无法看到主图+副图。

**验收**：点 A 股指数表行 → Modal 开 → **截图可见** K 线+MA 与 VOL/KDJ/MACD 副图；`canvas`>0；选日期区间仍能 B 类服务端重查。

## 现状（2026-06-23 webbridge 截图复验）

### 已解决（勿回退）— T8 数据/DOM 层
上一会话已修 LazyTeleport + echarts init 路径，**勿**再改回 `v-if` 等 bars 满才 mount KlineChart（会 `klineMounted=false`）。

| 层 | 状态 | 关键文件 |
|---|---|---|
| mount | ✅ `klineMounted=true`，`.kline-chart-wrapper` 在 DOM | `ASharesIndexKlineModal.vue:25-41`（`div.kline-pane-body` 包裹 + KlineChart 常驻） |
| echarts init | ✅ `canvasCount=1`，`ecAttr` 有值，`chartSize` 1032×468 | `KlineChart.vue:161-204`（rAF 50ms fallback、chartRef 重试、renderGeneration） |
| 父级补 render | ✅ `refreshChartAfterData` + 150ms 延迟 | `ASharesIndexKlineModal.vue:94-137` |

### 当前阻塞 — 视觉层（本会话新发现）
**路径**：`/symbols` → A 股数据 → A 股指数 → 点首行（实测 `700468.TI`）

| 检查 | 结果 |
|---|---|
| Vue `setupState` | `barsLen=242`，`loading=false` |
| DOM canvas | `document.querySelectorAll('.n-modal canvas').length === 1` |
| 遮罩 | `.modal-pane-overlay` 仍存在且 `display:flex`；`.modal-pane-overlay .n-spin` 存在 |
| **截图** | 全页 + `.kline-chart-wrapper` 区域均只见 **黄色 spinner**，无 K 线 |

截图路径（本机 webbridge 默认 temp，可复跑生成）：
`C:\Users\Lucifer\AppData\Local\Temp\kimi-webbridge-screenshots\screenshot_20260623_203824.949.png`（全页）
`...\screenshot_20260623_203925.690.png`（chart wrapper 区域）

**结论**：echarts 已 init，但 **loading overlay 叠在图表上方**；仅数 `canvas` 不足以宣称 T8 完成。

## 待排查（优先级降序）

### 1. `loadKline` 二次触发导致 `loading=true` 盖住已渲染 chart（高）
当前模板（`ASharesIndexKlineModal.vue:37-40`）：
```vue
<KlineChart ... />   <!-- 始终常驻 -->
<n-spin v-if="loading" class="modal-pane-overlay modal-spin" />
<div v-else-if="!bars.length" class="modal-pane-overlay empty-state">...</div>
```
与 **FlowTrendModal**（`FlowTrendModal.vue:20-29`）不同：后者 **`n-spin v-if="loading"` 与 `KlineChart v-else` 互斥**，loading 时根本不渲染 KlineChart，故不会「chart 已画 + spinner 再盖上」。

**打开 Modal 时的调用链**（`ASharesIndexKlineModal.vue:173-181`）：
1. `show=true` → `bars=[]`，`range=null`
2. `initDefaultRange()` → `onRangeUpdate([now-365d, now])`（`useKlineRangePicker` 写 `range` + 调 `onApply`）
3. `onApply` → `loadKline(start,end)`（`loading=true`）

**二次 load 候选**：
- `watch(klineRef)` / 组合 `watch`（`:141-154`）与 `refreshChartAfterData` 是否间接引起 `range` 变化再触发 `loadKline`？
- `KlineChartToolbar` 的 `actualRange`（`KlineChartToolbar.vue:212-218`）在 **有 data 时**覆盖显示为 `[first.open_time, last.open_time]` 的 ms；指数 `open_time` 为 **`YYYYMMDD` 无连字符**（`index-daily.service.ts:183`，types 注释 `open_time=YYYYMMDD`）。`openTimeToMs`（`:201-209`）只处理含 `T` 或 `YYYY-MM-DD`，对 `20250618` 会得到 **`NaN`** → date-picker 绑定 `[NaN,NaN]` 是否触发 `@update:value` → 父级 `onRangeUpdate` → **又一次 `loadKline`**？**必须实测**（network 或 evaluate 计数 `loadKline` 调用次数）。

### 2. `loading` 与 DOM 不一致（中）
截图时刻曾出现：`setupState.loading=false` 但 DOM 仍有 `.modal-pane-overlay .n-spin`（`overlayDisplay:flex`）。可能原因：
- 上述 **并发 loadKline**（evaluate 读 setupState 与 DOM 非同一渲染帧）
- Teleport/HMR stale（见下「webbridge 踩坑」）

**验证**：Modal 打开后稳定 5s，同步 evaluate 一次读 `{ loading: setupState.loading, hasOverlay: !!document.querySelector('.n-modal .modal-pane-overlay'), canvas }`，三者应一致。

### 3. overlay 方案本身（中 — 设计取舍）
overlay 是为 LazyTeleport「KlineChart 首次 patch 常驻」引入的。若根因是并发 load，可 **dedupe loadKline**（同 ts_code+区间 in-flight 合并 / 递增 requestId 丢弃旧响应）而非回退 mount 方案。

**参照**：FlowTrendModal 互斥分支；若改互斥，须保留 `div` 包裹 + 数据就绪后 mount 的 LazyTeleport 约束（见 `prompts/finish-a-shares-index-t8-render-and-t9-e2e.md` 真机结论：v-else 晚 mount 会 `klineMounted=false`）。

## 建议修复方向（待新会话拍板）

| 方案 | 做法 | 风险 |
|---|---|---|
| A. 修 toolbar 日期 | 指数入口 `open_time=YYYYMMDD` 在 toolbar/`actualRange` 路径解析对齐（或指数 Modal 禁用 `actualRange` 覆盖、仅用父级 `range`） | 需确认是否消除二次 load；可能影响其它 YYYY-MM-DD 消费者 |
| B. dedupe loadKline | in-flight token / AbortController / 忽略过期响应 | 改动小，不碰 mount 方案 |
| C. 互斥 UI | loading 时 `v-if` 隐藏 KlineChart（仅显示 spin），loaded 后显示 chart（FlowTrendModal 式） | 须验证 LazyTeleport 下晚 mount 是否再断；可能需 `:key`+div 包裹组合 |
| D. 去掉 overlay | loading 时只 disable toolbar，不盖绝对定位层 | 可能看到空 chart 闪一下 |

**推荐排查顺序**：先 **network / 计数证实 loadKline 调用次数** → 若为 2+，优先 A+B → 截图复验 → 仍盖再考虑 C。

## 硬约束
- **KlineChart 是共享组件**（`UsIndexPanel` / `FlowTrendModal` / 详情 drawer 等）：改 `KlineChart.vue` 须跑 `KlineChart.spec.ts`；优先在 Modal 内修。
- **LazyTeleport mount 约束保留**：`div.kline-pane-body` + 勿在 n-tab-pane slot 顶层直接放 KlineChart（`ASharesIndexKlineModal.vue:19-24` 注释）。
- **B 类服务端重查**：指数 `open_time=YYYYMMDD`；`useKlineRangePicker` + `indexDailyApi.queryKline`（`ASharesIndexKlineModal.vue:162-165`）。
- **AppModal 规范**：复用 `AppModal`，Modal 内禁自带保存/取消。
- **后端 dev 无 watch**：改 server 后重启；e2e 前确认 :3000 最新代码。
- **重启 dev/DB 前先问用户**。
- **webbridge**：验 **截图 + canvas 计数**；`evaluate` 内长 `await renderChart()` 易挂，用分步 evaluate + `sleep`；找活跃实例用父 `subTree findComp`，别从 teleport DOM 链读（`browser-driving/references/lessons-learned.md`）。

## 验证标准
1. **视觉（必须）**：webbridge `screenshot`（不传 path，用返回的 Windows 路径 Read 看图）— Modal 内可见 K 线蜡烛/MA 线与至少一个副图，**不是** spinner。
2. **DOM**：`.n-modal canvas` 数量 > 0；`loading=false` 时 **无** `.modal-pane-overlay`（或 `display:none`）。
3. **数据**：`barsLen>0`（活跃实例 `setupState`，findComp 读）。
4. **区间重查**：工具栏改日期 → 请求带新 `start_date/end_date`（YYYYMMDD）。
5. **单测**：`pnpm --filter @cryptotrading/web exec vitest run src/components/symbols/a-shares-index/ASharesIndexKlineModal.spec.ts src/components/kline/KlineChart.spec.ts` 绿。
6. **类型检查**：`pnpm --filter @cryptotrading/web type-check` 绿。

## 相关文件
| 文件 | 说明 |
|---|---|
| `apps/web/src/components/symbols/a-shares-index/ASharesIndexKlineModal.vue` | **主改** — overlay 模板、loadKline、watch |
| `apps/web/src/components/kline/KlineChartToolbar.vue:201-218` | `actualRange` / `openTimeToMs` — YYYYMMDD 嫌疑 |
| `apps/web/src/components/kline/KlineChart.vue:159-204` | renderChart（已修 init；慎动） |
| `apps/web/src/components/money-flow/FlowTrendModal.vue:20-29` | 互斥 loading/chart 参照 |
| `apps/web/src/composables/kline/useKlineRangePicker.ts` | range + onApply |
| `apps/server/src/market-data/index-daily/index-daily.service.ts:183` | `open_time` 权威：YYYYMMDD |
| `apps/web/src/components/symbols/a-shares-index/ASharesIndexKlineModal.spec.ts` | 单测（无 overlay 视觉断言，可补） |

## 前序进度
- T8 DOM 层 ✅（上一会话）：mount + echarts init + `refreshChartAfterData`；见 `prompts/finish-a-shares-index-t8-render-and-t9-e2e.md`（该文档 **T8 视觉未过**，以本文为准）。
- T9 剩余（未做）：列偏好 e2e、旧 ths 路径回归、industry-amv 同步 — 仍挂在 `finish-a-shares-index-t8-render-and-t9-e2e.md`。

## webbridge 复现脚本（PowerShell）
```powershell
# 1. 健康检查
~/.kimi-webbridge/bin/kimi-webbridge status

# 2. 请求 JSON 放 .tmp/（勿 inline JSON 转义）
# navigate → /symbols → 点 A股数据 → A股指数 → tbody 首行
# 3. 稳定 5s 后 evaluate（示例）：
#   canvas: document.querySelectorAll('.n-modal canvas').length
#   overlay: document.querySelector('.n-modal .modal-pane-overlay')
#   loading: findComp(..., 'ASharesIndexKlineModal').setupState.loading
# 4. screenshot（不传 path）→ Read 返回的 .path
# 5. close_session
```

## 姊妹交接
- `prompts/finish-a-shares-index-t8-render-and-t9-e2e.md` — T8 DOM ✅ / T9 待办；**视觉层转本文**
- spec：`docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md`

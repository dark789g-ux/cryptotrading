# 02 · 组件架构

## 2.1 新增组件清单

```text
apps/web/src/components/symbols/
├─ KlineWithInfoPanel.vue          # 共享布局：K线+侧栏+折叠+持久化+响应式守卫
├─ InfoRow.vue                     # 单行 label/value，三种标的共用
├─ a-shares/AStockInfoFields.vue   # A股字段渲染
├─ us-stocks/UsStockInfoFields.vue # 美股字段渲染
└─ crypto/CryptoInfoFields.vue     # 加密字段渲染
```

## 2.2 KlineWithInfoPanel.vue

**职责**：布局容器 + 折叠/展开状态管理 + localStorage 持久化 + 窄屏自动折叠守卫 + 触发按钮渲染。

**Props**：

```ts
{
  storageKey: string   // localStorage key，按标的类型区分，如 'kline_info_panel_expanded_a_shares'
  infoTitle?: string   // 侧栏标题，默认 '标的信息'
}
```

**Slots**：

| slot | 必需 | 说明 |
|---|---|---|
| `kline` | 是 | 注入 `<kline-chart>` 及其周边（caption 除外） |
| `info` | 是 | 注入字段列表（`AStockInfoFields` / `UsStockInfoFields` / `CryptoInfoFields`） |

**内部状态**：

```ts
const expanded = ref<boolean>(readFromStorage(props.storageKey) ?? false)  // 首次默认折叠
```

**触发按钮注入方式**：

`KlineChartToolbar.vue` 新增 `actions` 具名插槽，在 `.kline-toolbar__actions` 区域（现有"副图设置"齿轮按钮旁）渲染该插槽。`KlineChart.vue` 透传一个 `actions` 具名插槽给 `KlineChartToolbar`。`KlineWithInfoPanel` 在 `kline` slot 内用 `<kline-chart><template #actions>...</template></kline-chart>` 把触发按钮注入到 K 线 toolbar，与"副图设置"齿轮并列。按钮点击切换 `expanded`。

> 关键：`KlineChart` / `KlineChartToolbar` 保持中立，不知道"信息面板"的存在，只提供插槽承载点。按钮的状态与回调由 `KlineWithInfoPanel` 控制。
> 改动需触及两个文件：`KlineChartToolbar.vue`（新增并渲染 `actions` 插槽）+ `KlineChart.vue`（透传插槽）。

**布局**：

```text
<div class="kline-with-info-panel">            <!-- flex row, 宽高 100% -->
  <div class="kline-with-info-panel__kline">   <!-- flex:1, min-width:360px -->
    <slot name="kline" />                       <!-- <kline-chart #actions=触发按钮 /> -->
  </div>
  <aside v-show="expanded" class="kline-with-info-panel__aside">  <!-- 固定宽 260px -->
    <div class="info-aside__header">{{ infoTitle }}</div>
    <div class="info-aside__body"><slot name="info" /></div>
  </aside>
</div>
```

触发按钮（在 kline slot 内、注入到 KlineChart toolbar）：

```text
<n-button quaternary size="small" aria-label="标的信息"
          :aria-expanded="expanded" aria-controls="<aside-id>"
          :disabled="!canExpand" @click="toggle">
  <n-icon><info-circle-icon v-if="!expanded" /><chevron-collapse-icon v-else /></n-icon>
</n-button>
```

## 2.3 响应式守卫

- 用 `ResizeObserver` 监听 `__kline` 区可用宽度
- 阈值：K 线最小 360px + 侧栏 260px = **620px**
- 当容器可用宽度 < 620px：`canExpand = false`，按钮 disabled（tooltip 提示"空间不足"）；若 `expanded` 为 true 则**自动折叠**
- 宽度恢复 ≥ 620px：`canExpand = true`，按钮重新可用；**不自动展开**（避免抖动，需用户主动点）
- 窄屏（≤960px，split 退化为上下堆叠）此时详情面板横向占满，宽度足够，无需特殊处理

**过渡动画**：无。瞬时切换 `v-show`，不做 width/opacity transition（用户偏好，避免重排开销）。

## 2.4 InfoRow.vue

最底层单行展示组件，三种标的共用。

```ts
{
  label: string        // 标签文本（含单位，如 "流通市值(亿)"）
  value: string        // 已格式化的值（formatter 处理后的字符串，空值已转 '-'）
  trend?: 'up' | 'down' | ''  // 可选，涨跌幅着色，驱动 trend-up/trend-down class
}
```

渲染：`<div class="info-row"><span class="info-row__label">{{label}}</span><span class="info-row__value" :class="trendClass">{{value}}</span></div>`

## 2.5 *InfoFields 组件

三个纯展示组件，接收各自标的的 `row`，内部按字段表渲染一列 `<InfoRow>`。

**row 为 null 时的行为（统一约定）**：`*InfoFields` 内部用 `v-if="row"` 守卫字段列表；row 为 null 时字段列表不渲染，组件渲染一个 `<n-empty description="未选择标的" size="small" />` 占位。即侧栏框架始终存在，body 区在无选中标的时显示空状态文案"未选择标的"，有选中标的时显示字段列表。

字段表见 `./03-fields.md`。

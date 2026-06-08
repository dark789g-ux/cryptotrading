# 03 · 前端设计

[← 返回 index](./index.md) · [← 02-backend](./02-backend.md)

## 改动总览

```text
新增:
  components/sync/useBaseDataSync.ts          仿 useThsIndexDailySync 标准 exports
  components/sync/DataSourceCardHeader.vue     ★抽 6 卡统一卡头(瘦身 SyncView)
  api/modules/market/baseDataSync.ts           syncRunUrl(params) + rangeUrl()
改:
  views/sync/SyncView.vue                      6 卡卡头改用 DataSourceCardHeader + 新增基础数据卡 + 1 行解构 + modal 绑定
  (一键同步接入见 04)
```

## useBaseDataSync composable（仿 `useThsIndexDailySync.ts`）

标准 exports 集合（与现有 6 个 composable 一致，便于 SyncView 解构 + 一键同步复用）：

```text
useBaseDataSync(message) → {
  show,                 // Ref<boolean>          modal 可见
  syncing,              // Ref<boolean>
  syncMode,             // Ref<'incremental'|'overwrite'>
  syncDateRange,        // Ref<[number,number]|null>   时间戳对(DatePicker)
  dateRangeLabel,       // Ref<string>           库存范围文字(来自 /base-data/range)
  dateRangeLoading,     // Ref<boolean>
  canConfirm,           // ComputedRef<boolean>
  syncProgressVisible,  // ComputedRef<boolean>  sse.status!=='idle' || finished!==null
  sse,                  // useSSE() 返回对象(status/percent/phase/message/current/total)
  finished,             // Ref<{result}|null>
  openModal,            // () => void   打开时拉 range 算增量默认
  confirmSync,          // () => Promise<void>
}
```

### 核心流程

```text
openModal():
  show = true
  dateRangeLoading = true
  range = await GET /api/base-data/range
  dateRangeLabel = `stk_limit ${range.stkLimit.min}~${range.stkLimit.max}`   // 库存标签
  // 增量默认: [stk_limit.max + 1 交易日, 今日]; overwrite 默认全范围由用户选
  syncDateRange = 默认据 range 算
  dateRangeLoading = false

confirmSync():
  syncing = true
  const qs = new URLSearchParams({
    start_date: toYYYYMMDD(syncDateRange[0]),
    end_date:   toYYYYMMDD(syncDateRange[1]),
    syncMode:   syncMode.value,
  })
  await sse.start(`${API_BASE}/base-data/sync/run?${qs}`, {
    method:'GET',
    onDone: data => { if (data?.result) finished.value = { result: data.result }; syncing.value = false },
    onError: msg => { message.error(msg); syncing.value = false },
  })
```

> `useSSE()` 无参、纯 GET、`credentials:'same-origin'`（cookie 认证，**不带 token**）、`onScopeDispose` 自动 abort。SSE 事件 `data:{"type":"progress"|"done"|"error",...}`，字段映射 percent/phase/message/current/total。

> `syncMode` 两种都走后端 upsert（幂等），差别仅在 `openModal` 提议的默认日期范围：incremental = 水位+1 起；overwrite = 用户全选。保留 `syncMode` 是为复用 DataSyncModal（其 props 需要它）。

## API client（`api/modules/market/baseDataSync.ts`，仿 `moneyFlow.ts`）

```text
import { API_BASE } from '../../client'   // API_BASE = '/api'

export const baseDataSyncApi = {
  syncRunUrl: (p:{start_date,end_date,syncMode}) => {
    const qs = new URLSearchParams({ start_date:p.start_date, end_date:p.end_date, syncMode:p.syncMode })
    return `${API_BASE}/base-data/sync/run?${qs}`
  },
  rangeUrl: () => `${API_BASE}/base-data/range`,
}
```

## SyncView 瘦身（决策 6：抽 DataSourceCardHeader + 逻辑进 composable）

**现状**：`SyncView.vue` 509 行（template 1-382 + script 384-507），已超 500 通用指南。直接加卡会到 ~535。

**方案**：6 张卡的卡头结构高度一致 —— `<div class="data-source-header">` 内含 icon / eyebrow / title / desc（每卡约 12 行模板）。抽成纯展示子组件：

```text
components/sync/DataSourceCardHeader.vue
  props: { eyebrow:string; title:string; description:string; icon:Component }
  template:
    <div class="data-source-header">
      <div class="data-source-icon"><n-icon><component :is="icon"/></n-icon></div>
      <div class="data-source-heading">
        <span class="data-source-eyebrow">{{ eyebrow }}</span>
        <h3 class="data-source-title">{{ title }}</h3>
        <p class="data-source-desc">{{ description }}</p>
      </div>
    </div>
```

SyncView 中 6 张卡的 header 块各自替换为一行：

```text
<data-source-card-header :icon="TrendingUpOutline" eyebrow="THS Index Daily"
  title="指数日线 (ths_daily)" description="..." />
```

**净效果**：6 卡 ×(~12 行 → 1 行) ≈ 省 60+ 行模板；新增基础数据卡（卡头 1 行 + body/action ~15 行）+ 1 行 composable 解构后，SyncView 回落到 **< 480 行**。卡的 `body`/`actions`（各卡相异，卡 4 index-catalog 无 modal 直调）保留在 SyncView，不动其逻辑，**低风险**。

### 新增「基础数据」卡（模板，仿卡 5）

```text
<section class="data-source-card data-source-card--base-data">
  <data-source-card-header :icon="CalendarOutline" eyebrow="Base Data"
    title="基础数据 (日历/涨跌停/停牌)"
    description="trade_cal / stk_limit / suspend_d，按依赖顺序串行同步" />
  <div class="data-source-body"><div class="source-note">...</div></div>
  <div class="data-source-actions">
    <n-button block secondary type="primary"
      :loading="baseDataSyncing" :disabled="baseDataSyncing || oneClickRunning"
      @click="openBaseDataModal">
      <template #icon><n-icon><calendar-outline/></n-icon></template>
      配置并同步
    </n-button>
  </div>
</section>
```

### script 解构（仿 ths，488-502）

```text
const {
  show: baseDataShow, syncing: baseDataSyncing, syncMode: baseDataSyncMode,
  syncDateRange: baseDataSyncDateRange, dateRangeLabel: baseDataDateRangeLabel,
  dateRangeLoading: baseDataDateRangeLoading, canConfirm: baseDataCanConfirm,
  syncProgressVisible: baseDataProgressVisible, sse: baseDataSse,
  finished: baseDataFinished, openModal: openBaseDataModal, confirmSync: confirmBaseDataSync,
} = useBaseDataSync(message)
```

### DataSyncModal 复用（`DataSyncModal.vue`，无需改）

直接复用：props（show/title/description/icon/syncing/syncMode/syncDateRange/dataDateRangeLabel/dataDateRangeLoading/canConfirm/finished）、emits（update:show/update:syncMode/update:syncDateRange/confirm）、`#extra` slot 注进度条。基础数据卡的 modal 绑定一份即可。

## 行数守门

- `DataSourceCardHeader.vue`、`useBaseDataSync.ts`、`baseDataSync.ts` 均为小文件，远 < 500。
- 改完 `SyncView.vue` 后实测行数应 < 500（`(Get-Content ... | Measure-Object -Line).Lines`），写进验证清单（见 04）。
- 注：`views/sync/**` 不在 `lint:quant-lines` CI 强制范围（该 lint 仅管 `views/quant/**` 与 `components/quant/**`），但本设计仍以 < 500 为交付门槛。

[下一篇：04-one-click-and-testing →](./04-one-click-and-testing.md)

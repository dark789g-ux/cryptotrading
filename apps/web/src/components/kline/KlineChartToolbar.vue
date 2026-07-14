<template>
  <div class="kline-toolbar">
    <!-- 左侧：标的 + 时间范围选择器 -->
    <div class="kline-toolbar__left">
      <div v-if="symbolCode || showSuspend" class="kline-toolbar__symbol-block">
        <span v-if="symbolCode" class="kline-toolbar__symbol">
          <span class="kline-toolbar__symbol-code">{{ symbolCode }}</span>
          <span v-if="symbolName" class="kline-toolbar__symbol-name">{{ symbolName }}</span>
          <suspend-status-tag
            v-if="showSuspend"
            class="kline-toolbar__suspend-tag"
            :status="suspend?.status"
            :since-date="suspend?.sinceDate"
            :timing="suspend?.timing"
            variant="toolbar"
          />
        </span>
        <span v-if="suspendCaption" class="kline-toolbar__suspend-caption">{{ suspendCaption }}</span>
      </div>
      <div class="kline-toolbar__range">
      <n-date-picker
        v-if="granularity === 'date'"
        type="daterange"
        size="small"
        clearable
        :value="actualRange ?? range"
        :disabled="disabledRange"
        @update:value="onRangeUpdate"
      />
      <n-date-picker
        v-else-if="granularity === 'hour'"
        type="datetimerange"
        size="small"
        clearable
        format="yyyy-MM-dd HH:mm"
        :value="actualRange ?? range"
        :disabled="disabledRange"
        @update:value="onRangeUpdate"
      />
      <n-date-picker
        v-else
        type="datetimerange"
        size="small"
        clearable
        format="yyyy-MM-dd HH:mm:ss"
        :value="actualRange ?? range"
        :disabled="disabledRange"
        @update:value="onRangeUpdate"
      />
      </div>
    </div>

    <!-- 右侧：副图设置齿轮 -->
    <div class="kline-toolbar__actions">
      <n-popover trigger="click" placement="bottom-end" :width="360">
        <template #trigger>
          <n-button text size="small" aria-label="副图设置">
            <template #icon>
              <n-icon :size="18">
                <SettingsOutline />
              </n-icon>
            </template>
          </n-button>
        </template>

        <div class="subplot-panel">
          <div class="subplot-panel__title">图表设置</div>

          <!-- 主图指标分区 -->
          <div class="main-indicator-section">
            <div class="subplot-panel__subtitle">主图指标</div>
            <div class="main-indicator-grid">
              <n-checkbox
                v-for="key in ALL_MAIN_INDICATOR_KEYS"
                :key="key"
                :checked="mainIndicatorVisible(key)"
                class="main-indicator-grid__item"
                @update:checked="(v: boolean) => onMainIndicatorChange(key, v)"
              >
                {{ key }}
              </n-checkbox>
            </div>
          </div>

          <div class="subplot-panel__subtitle">副图设置</div>

          <div class="subplot-panel__list">
            <div
              v-for="(key, idx) in props.prefs.order"
              :key="key"
              class="subplot-row"
            >
              <div class="subplot-row__left">
                <n-checkbox
                  :checked="props.prefs.visibility[key]"
                  @update:checked="(v: boolean) => onVisibilityChange(key, v)"
                >
                  {{ key === 'KDJ' ? kdjDisplayName : key }}
                </n-checkbox>
              </div>

              <div class="subplot-row__mid">
                <n-input-number
                  :value="props.prefs.heightPct[key]"
                  :min="4"
                  :max="20"
                  :step="1"
                  size="small"
                  style="width: 80px"
                  @update:value="(v: number | null) => onHeightChange(key, v)"
                />
                <span class="subplot-row__unit">%</span>
              </div>

              <div class="subplot-row__right">
                <n-popover
                  v-if="key === 'KDJ'"
                  v-model:show="showKdjPopover"
                  trigger="click"
                  placement="right"
                  :width="200"
                  :show-arrow="false"
                >
                  <template #trigger>
                    <n-button
                      text
                      size="tiny"
                      aria-label="KDJ 参数"
                    >
                      <template #icon>
                        <n-icon :size="14">
                          <CogOutline />
                        </n-icon>
                      </template>
                    </n-button>
                  </template>

                  <kdj-params-editor
                    :params="props.prefs.params?.KDJ"
                    :default-params="DEFAULT_KDJ_PARAMS"
                    :ranges="KDJ_PARAM_RANGES"
                    @confirm="onKdjConfirm"
                    @cancel="showKdjPopover = false"
                  />
                </n-popover>

                <n-button
                  text
                  size="tiny"
                  :disabled="idx === 0"
                  aria-label="上移"
                  @click="moveUp(idx)"
                >
                  <template #icon>
                    <n-icon :size="14">
                      <ChevronUpOutline />
                    </n-icon>
                  </template>
                </n-button>
                <n-button
                  text
                  size="tiny"
                  :disabled="idx === props.prefs.order.length - 1"
                  aria-label="下移"
                  @click="moveDown(idx)"
                >
                  <template #icon>
                    <n-icon :size="14">
                      <ChevronDownOutline />
                    </n-icon>
                  </template>
                </n-button>
              </div>
            </div>
          </div>

          <div class="subplot-panel__footer">
            <n-button text size="small" @click="onReset">重置默认</n-button>
          </div>
        </div>
      </n-popover>
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NButton,
  NCheckbox,
  NDatePicker,
  NIcon,
  NInputNumber,
  NPopover,
} from 'naive-ui'
import {
  ChevronDownOutline,
  ChevronUpOutline,
  CogOutline,
  SettingsOutline,
} from '@vicons/ionicons5'
import {
  ALL_MAIN_INDICATOR_KEYS,
  DEFAULT_KDJ_PARAMS,
  KDJ_PARAM_RANGES,
  isDefaultKdjParams,
  type KdjSubplotParams,
  type MainIndicatorKey,
  type RawSubplotPrefs,
  type SubplotKey,
  type SubplotPrefs,
} from '@/composables/kline/subplotConfig'
import KdjParamsEditor from './KdjParamsEditor.vue'
import SuspendStatusTag from '../symbols/a-shares/SuspendStatusTag.vue'
import { buildSuspendToolbarCaption, isSuspended as checkSuspended } from '../symbols/a-shares/suspendDisplay'
import type { AShareKlineSuspend, KlineChartBar } from '@/api'

type Granularity = 'date' | 'hour' | 'minute'

const props = withDefaults(
  defineProps<{
    granularity: Granularity
    range: [number, number] | null
    data: KlineChartBar[]
    disabledRange?: boolean
    prefs: SubplotPrefs
    update: (partial: RawSubplotPrefs) => void
    reset: () => void
    symbolCode?: string
    symbolName?: string
    suspend?: AShareKlineSuspend | null
  }>(),
  {
    disabledRange: false,
    symbolCode: '',
    symbolName: '',
    suspend: null,
  },
)

const showSuspend = computed(() => checkSuspended(props.suspend?.status))

const suspendCaption = computed(() => {
  if (!showSuspend.value || !props.suspend) return ''
  return buildSuspendToolbarCaption(props.suspend)
})

const emit = defineEmits<{
  (e: 'update:range', value: [number, number] | null): void
}>()

function openTimeToMs(openTime: string): number {
  // Crypto: ISO 时间戳
  if (openTime.includes('T')) {
    return new Date(openTime).getTime()
  }
  // A 股指数 index-daily：YYYYMMDD（无连字符）
  if (/^\d{8}$/.test(openTime)) {
    const y = Number(openTime.slice(0, 4))
    const m = Number(openTime.slice(4, 6))
    const d = Number(openTime.slice(6, 8))
    return new Date(y, m - 1, d).getTime()
  }
  // A 股/美股/0AMV: YYYY-MM-DD，按本地午夜处理
  const [y, m, d] = openTime.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getTime()
}

const actualRange = computed<[number, number] | null>(() => {
  if (props.data.length === 0) return null

  const first = props.data[0].open_time
  const last = props.data[props.data.length - 1].open_time

  const start = openTimeToMs(first)
  const end = openTimeToMs(last)
  if (Number.isNaN(start) || Number.isNaN(end)) return null

  return [start, end]
})

const showKdjPopover = ref(false)

function onKdjConfirm(params: KdjSubplotParams): void {
  props.update({ params: { KDJ: params } })
  showKdjPopover.value = false
}

const kdjDisplayName = computed(() => {
  const kdj = props.prefs.params?.KDJ
  if (kdj && !isDefaultKdjParams(kdj)) {
    return `KDJ(${kdj.n},${kdj.m1},${kdj.m2})`
  }
  return 'KDJ'
})

function onRangeUpdate(value: [number, number] | null): void {
  emit('update:range', value)
}

function onVisibilityChange(key: SubplotKey, visible: boolean): void {
  props.update({ visibility: { ...props.prefs.visibility, [key]: visible } })
}

function onHeightChange(key: SubplotKey, value: number | null): void {
  if (value == null || !Number.isFinite(value)) return
  props.update({ heightPct: { ...props.prefs.heightPct, [key]: value } })
}

function moveUp(idx: number): void {
  if (idx <= 0) return
  const next = [...props.prefs.order]
  const tmp = next[idx - 1]
  next[idx - 1] = next[idx]
  next[idx] = tmp
  props.update({ order: next })
}

function moveDown(idx: number): void {
  const next = [...props.prefs.order]
  if (idx >= next.length - 1) return
  const tmp = next[idx + 1]
  next[idx + 1] = next[idx]
  next[idx] = tmp
  props.update({ order: next })
}

function mainIndicatorVisible(key: MainIndicatorKey): boolean {
  // prefs.mainIndicators 由 normalize 保证存在(全 key 补全),但防御性用 !== false
  return props.prefs.mainIndicators?.[key] !== false
}

function onMainIndicatorChange(key: MainIndicatorKey, visible: boolean): void {
  props.update({ mainIndicators: { ...props.prefs.mainIndicators, [key]: visible } })
}

function onReset(): void {
  props.reset()
}
</script>

<style scoped>
.kline-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 8px 12px;
  background: #2b2f36; /* colors.surface.elevated */
  border: 1px solid #3a3f48; /* colors.border.DEFAULT */
  border-radius: 4px;
  color: #d0d4dc; /* colors.text.DEFAULT */
  box-sizing: border-box;
}

.kline-toolbar__left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
}

.kline-toolbar__symbol-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  min-width: 0;
}

.kline-toolbar__range {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 auto;
  min-width: 0;
}

.kline-toolbar__symbol {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  font-size: 13px;
  flex-wrap: wrap;
}

.kline-toolbar__suspend-caption {
  color: #848e9c;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
}

.kline-toolbar__symbol-code {
  color: #d0d4dc;
  font-weight: 500;
  white-space: nowrap;
}

.kline-toolbar__symbol-name {
  color: #848e9c;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kline-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.subplot-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 320px;
}

.subplot-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: #d0d4dc;
  padding-bottom: 4px;
  border-bottom: 1px solid #3a3f48;
}

.subplot-panel__subtitle {
  font-size: 12px;
  font-weight: 500;
  color: #848e9c;
  padding: 2px 0;
}

.main-indicator-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.main-indicator-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px 8px;
}

.main-indicator-grid__item {
  white-space: nowrap;
}

.subplot-panel__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.subplot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}

.subplot-row__left {
  flex: 1 1 auto;
  min-width: 60px;
}

.subplot-row__mid {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.subplot-row__unit {
  color: #848e9c; /* colors.text.secondary */
  font-size: 12px;
}

.subplot-row__right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.subplot-panel__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px solid #3a3f48;
}
</style>

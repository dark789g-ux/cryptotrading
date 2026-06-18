<template>
  <div class="kline-toolbar">
    <!-- 左侧：时间范围选择器 -->
    <div class="kline-toolbar__range">
      <n-date-picker
        v-if="granularity === 'date'"
        type="daterange"
        size="small"
        clearable
        :value="range"
        :disabled="disabledRange"
        @update:value="onRangeUpdate"
      />
      <n-date-picker
        v-else-if="granularity === 'hour'"
        type="datetimerange"
        size="small"
        clearable
        format="yyyy-MM-dd HH:mm"
        :value="range"
        :disabled="disabledRange"
        @update:value="onRangeUpdate"
      />
      <n-date-picker
        v-else
        type="datetimerange"
        size="small"
        clearable
        format="yyyy-MM-dd HH:mm:ss"
        :value="range"
        :disabled="disabledRange"
        @update:value="onRangeUpdate"
      />
    </div>

    <!-- 右侧：副图设置齿轮 -->
    <div class="kline-toolbar__actions">
      <n-popover trigger="click" placement="bottom-end" :width="320">
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
          <div class="subplot-panel__title">副图设置</div>

          <div class="subplot-panel__list">
            <div
              v-for="(key, idx) in prefs.order"
              :key="key"
              class="subplot-row"
            >
              <div class="subplot-row__left">
                <n-checkbox
                  :checked="prefs.visibility[key]"
                  @update:checked="(v: boolean) => onVisibilityChange(key, v)"
                >
                  {{ key === 'KDJ' ? kdjDisplayName : key }}
                </n-checkbox>
              </div>

              <div class="subplot-row__mid">
                <n-input-number
                  :value="prefs.heightPct[key]"
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
                    :params="prefs.params?.KDJ"
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
                  :disabled="idx === prefs.order.length - 1"
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
  ALL_SUBPLOT_KEYS,
  DEFAULT_KDJ_PARAMS,
  KDJ_PARAM_RANGES,
  isDefaultKdjParams,
  type KdjSubplotParams,
  type SubplotKey,
  type SubplotPrefs,
} from '@/composables/kline/subplotConfig'
import { useKlineChartPrefs } from '@/composables/kline/useKlineChartPrefs'
import KdjParamsEditor from './KdjParamsEditor.vue'

type Granularity = 'date' | 'hour' | 'minute'

const props = withDefaults(
  defineProps<{
    granularity: Granularity
    range: [number, number] | null
    disabledRange?: boolean
    prefsKey: string
    availableSubplots?: SubplotKey[]
  }>(),
  {
    disabledRange: false,
    availableSubplots: () => [...ALL_SUBPLOT_KEYS],
  },
)

const emit = defineEmits<{
  (e: 'update:range', value: [number, number] | null): void
  (e: 'update:prefs', value: SubplotPrefs): void
}>()

const showKdjPopover = ref(false)

// availableSubplots 仅在挂载期决定 hook 行为；在组件生命周期中视为稳定
const { prefs, update, reset } = useKlineChartPrefs(
  props.prefsKey,
  props.availableSubplots,
)

function onKdjConfirm(params: KdjSubplotParams): void {
  update({ params: { KDJ: params } })
  showKdjPopover.value = false
}

const kdjDisplayName = computed(() => {
  const kdj = prefs.value.params?.KDJ
  if (kdj && !isDefaultKdjParams(kdj)) {
    return `KDJ(${kdj.n},${kdj.m1},${kdj.m2})`
  }
  return 'KDJ'
})

function onRangeUpdate(value: [number, number] | null): void {
  emit('update:range', value)
}

function onVisibilityChange(key: SubplotKey, visible: boolean): void {
  update({ visibility: { ...prefs.value.visibility, [key]: visible } })
}

function onHeightChange(key: SubplotKey, value: number | null): void {
  if (value == null || !Number.isFinite(value)) return
  update({ heightPct: { ...prefs.value.heightPct, [key]: value } })
}

function moveUp(idx: number): void {
  if (idx <= 0) return
  const next = [...prefs.value.order]
  const tmp = next[idx - 1]
  next[idx - 1] = next[idx]
  next[idx] = tmp
  update({ order: next })
}

function moveDown(idx: number): void {
  const next = [...prefs.value.order]
  if (idx >= next.length - 1) return
  const tmp = next[idx + 1]
  next[idx + 1] = next[idx]
  next[idx] = tmp
  update({ order: next })
}

function onReset(): void {
  reset()
}

// prefs 任何变化（含 update / reset）→ 立刻 emit，不等 popover 关闭
watch(
  prefs,
  (val) => {
    emit('update:prefs', val)
  },
  { deep: true },
)

// 组件挂载时把持久化值告诉父组件（让父组件依此初始化图表）
onMounted(() => {
  emit('update:prefs', prefs.value)
})
</script>

<style scoped>
.kline-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 8px 12px;
  background: #2b2f36; /* colors.surface.elevated */
  border: 1px solid #3a3f48; /* colors.border.DEFAULT */
  border-radius: 4px;
  color: #d0d4dc; /* colors.text.DEFAULT */
  box-sizing: border-box;
}

.kline-toolbar__range {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 auto;
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
  min-width: 280px;
}

.subplot-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: #d0d4dc;
  padding-bottom: 4px;
  border-bottom: 1px solid #3a3f48;
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

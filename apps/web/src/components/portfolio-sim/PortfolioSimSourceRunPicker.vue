<template>
  <div class="rp">
    <!-- 来源方式三选一 -->
    <div class="rp__field">
      <div class="rp__label">来源方式</div>
      <n-radio-group
        :value="sourceMethod"
        size="small"
        :disabled="disabled"
        @update:value="onMethodChange"
      >
        <n-radio-button value="scheme">选已有方案</n-radio-button>
        <n-radio-button value="manual">手填 uuid</n-radio-button>
        <n-radio-button value="new">新建信号源</n-radio-button>
      </n-radio-group>
    </div>

    <!-- ① 选已有方案：方案下拉 + 历史 run 二级下拉 + 只读条件摘要 -->
    <template v-if="sourceMethod === 'scheme'">
      <div class="rp__field">
        <div class="rp__label">方案</div>
        <n-select
          :value="schemeId"
          :options="schemeOptions"
          placeholder="选择一个信号方案"
          size="small"
          filterable
          :disabled="disabled"
          @update:value="onSchemeChange"
        />
      </div>

      <div class="rp__field">
        <div class="rp__label">历史 run（仅已完成可选，默认最新）</div>
        <n-select
          :value="selectedRunId"
          :options="runOptions"
          placeholder="选择一次已完成的运行"
          size="small"
          :loading="runsLoading"
          :disabled="disabled || !schemeId"
          @update:value="onRunChange"
        />
        <div v-if="schemeId && !runsLoading && !hasCompletedRun" class="rp__warn">
          无可用 completed run，请新建信号源或换方案
        </div>
      </div>

      <div v-if="summaryText" class="rp__summary" :title="summaryText">
        ▸ 该源条件：{{ summaryText }}
      </div>
    </template>

    <!-- ② 手填 uuid（老路保留） -->
    <template v-else-if="sourceMethod === 'manual'">
      <div class="rp__field">
        <div class="rp__label">手填 run id</div>
        <n-input
          :value="runId"
          placeholder="粘贴 signal_test_run 的 uuid"
          size="small"
          :disabled="disabled"
          @update:value="(v: string) => emit('update', { runId: v.trim() })"
        />
      </div>
    </template>

    <!-- ③ 新建信号源 -->
    <template v-else>
      <div class="rp__field">
        <div class="rp__label">新建信号源</div>
        <n-button size="small" :disabled="disabled" @click="showNewModal = true">
          定义新信号源…
        </n-button>
        <div v-if="newRunState" class="rp__new-state">
          <template v-if="newRunState.status === 'running'">
            <span class="rp__running">运行中 {{ newRunPct }}%</span>
          </template>
          <template v-else-if="newRunState.status === 'completed'">
            <span class="rp__ok">
              ✓ 已完成 · 样本{{ newRunState.sampleCount ?? '-' }} ·
              胜{{ newRunState.winRate != null ? fmtRetPct(newRunState.winRate) : '-' }}
            </span>
          </template>
          <template v-else-if="newRunState.status === 'failed'">
            <span class="rp__err">✗ 失败：{{ newRunState.errorMessage ?? '未知错误' }}</span>
          </template>
        </div>
        <div v-if="newPollError" class="rp__warn">{{ newPollError }}</div>
      </div>
    </template>

    <PortfolioSimNewSourceModal
      v-model:show="showNewModal"
      @created="onNewSourceCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { NButton, NInput, NRadioButton, NRadioGroup, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type {
  SignalTestRun,
  SignalTestWithLatestRun,
} from '../../api/modules/strategy/signalStats'
import {
  exitModeSummary,
  fmtRetPct,
  fmtTradeDate,
} from '../strategy/signalStatsFormatters'
import { formatUTCDateTime } from '../symbols/a-shares/aSharesFormatters'
import { usePortfolioSimSourceRuns } from './composables/usePortfolioSimSourceRuns'
import PortfolioSimNewSourceModal from './PortfolioSimNewSourceModal.vue'

type SourceMethod = 'scheme' | 'manual' | 'new'

/** 历史 run 二级下拉选项（vue3 规范：自定义选项须 extends SelectOption）。 */
interface RunOption extends SelectOption {
  label: string
  value: string
  disabled: boolean
}

const props = defineProps<{
  runId: string
  schemes: SignalTestWithLatestRun[]
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update', payload: { runId: string }): void
}>()

const message = useMessage()
const { loadRuns, latestCompleted, startPolling, stopAll } = usePortfolioSimSourceRuns()

// ── 本组件局部状态（testId 等全程不出本组件） ──────────────────────────────────
const sourceMethod = ref<SourceMethod>('scheme')
const schemeId = ref<string | null>(null)
const testId = ref<string | null>(null) // 内部状态：查 listRuns / 轮询 / 摘要用，绝不 emit
const runs = ref<SignalTestRun[]>([])
const runsLoading = ref(false)
const selectedRunId = ref<string | null>(null)

// 路径 B：新建源的运行态与轮询异常
const showNewModal = ref(false)
const newRunState = ref<SignalTestRun | null>(null)
const newPollError = ref<string>('')

// ── 路径 A：方案 / 历史 run ─────────────────────────────────────────────────────
const schemeOptions = computed<SelectOption[]>(() =>
  // 不按 latest run 状态禁用——历史 run 在二级下拉处理
  props.schemes.map((s) => ({ label: s.name, value: s.id })),
)

/** 当前选中的 scheme 对象（用于条件摘要）。 */
const selectedScheme = computed<SignalTestWithLatestRun | null>(
  () => props.schemes.find((s) => s.id === schemeId.value) ?? null,
)

/** 当前选中的 run 对象（用于摘要追加样本/胜率）。 */
const selectedRun = computed<SignalTestRun | null>(
  () => runs.value.find((r) => r.id === selectedRunId.value) ?? null,
)

const runOptions = computed<RunOption[]>(() =>
  runs.value.map((r) => {
    const when = formatUTCDateTime(r.createdAt)
    if (r.status === 'completed') {
      const win = r.winRate != null ? fmtRetPct(r.winRate) : '-'
      return {
        label: `${when} · 样本${r.sampleCount ?? '-'} · 胜${win} · ✓`,
        value: r.id,
        disabled: false,
      }
    }
    // 非 completed：sampleCount/winRate 为 null，省略不渲染 'null'
    const stateText = r.status === 'running' ? '运行中' : '失败'
    return { label: `${when} · ${stateText}`, value: r.id, disabled: true }
  }),
)

/**
 * 该方案是否至少有一个可用（completed）run。
 * 用于「无可用 completed run」提示：只要选了方案且无 completed（哪怕有 running/failed
 * 被渲染成 disabled 项）就该提示，不能用 runOptions.length 判（非 completed 也会进 options）。
 */
const hasCompletedRun = computed<boolean>(() =>
  runs.value.some((r) => r.status === 'completed'),
)

/** 只读条件摘要：条件来自 scheme，统计来自选中 completed run。 */
const summaryText = computed<string>(() => {
  const s = selectedScheme.value
  if (!s) return ''
  const buy = `买入${s.buyConditions.length}条`
  const exit = exitModeSummary(s)
  const uni = s.universe.type === 'all' ? '全市场' : '指定标的'
  const range = `${fmtTradeDate(s.dateStart)}~${fmtTradeDate(s.dateEnd)}`
  let text = `${buy} · ${exit} · ${uni} · ${range}`
  const run = selectedRun.value
  if (run && run.status === 'completed') {
    const win = run.winRate != null ? fmtRetPct(run.winRate) : '-'
    text += ` · 样本${run.sampleCount ?? '-'} · 胜${win}`
  }
  return text
})

async function onSchemeChange(id: string) {
  schemeId.value = id
  testId.value = id // signal_test 的 id 即 testId（findAll 返回的 scheme 即 SignalTest）
  selectedRunId.value = null
  runs.value = []
  emit('update', { runId: '' }) // 切方案先清空契约字段，待选中默认 run 再回填
  runsLoading.value = true
  try {
    const loaded = await loadRuns(id)
    if (testId.value !== id) return // 已被切走，丢弃过期结果
    runs.value = loaded
    const def = latestCompleted(loaded)
    if (def) {
      selectedRunId.value = def.id
      emit('update', { runId: def.id })
    } else {
      // 无任何 completed run
      selectedRunId.value = null
      emit('update', { runId: '' })
    }
  } catch (e) {
    if (testId.value !== id) return
    message.error(e instanceof Error ? e.message : '加载运行历史失败')
  } finally {
    if (testId.value === id) runsLoading.value = false
  }
}

function onRunChange(id: string) {
  selectedRunId.value = id
  emit('update', { runId: id })
}

// ── 路径 B：新建信号源轮询 ──────────────────────────────────────────────────────
const newRunPct = computed<number>(() => {
  const r = newRunState.value
  if (!r || r.progressTotal <= 0) return 0 // 防除零
  return Math.min(100, Math.round((r.progressScanned / r.progressTotal) * 100))
})

function onNewSourceCreated({ runId, testId: newTestId }: { runId: string; testId: string }) {
  testId.value = newTestId // 收下 testId 自用，绝不 emit
  newRunState.value = null
  newPollError.value = ''
  emit('update', { runId }) // 只把契约字段吐给父
  startPolling(newTestId, {
    onUpdate: (run) => {
      newRunState.value = run
    },
    onError: (err) => {
      newPollError.value = `轮询进度异常：${err.message}`
    },
  })
}

// ── 来源方式切换 / 卸载：清态 + 停轮询，防脏 runId 与轮询泄漏 ─────────────────────
function resetSourceState() {
  stopAll()
  schemeId.value = null
  testId.value = null
  runs.value = []
  runsLoading.value = false
  selectedRunId.value = null
  newRunState.value = null
  newPollError.value = ''
  showNewModal.value = false
}

function onMethodChange(m: SourceMethod) {
  sourceMethod.value = m
  resetSourceState()
  emit('update', { runId: '' }) // 切换来源方式一律清空契约字段
}

onUnmounted(() => {
  stopAll()
})
</script>

<style scoped>
.rp {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rp__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rp__label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.rp__summary {
  font-size: 11px;
  color: var(--color-text-secondary, #888);
  line-height: 1.5;
  word-break: break-all;
}

.rp__warn {
  font-size: 11px;
  color: #d03050;
}

.rp__new-state {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.rp__running {
  color: var(--color-primary, #2080f0);
}

.rp__ok {
  color: #18a058;
}

.rp__err {
  color: #d03050;
}
</style>

<template>
  <div class="phase-lock-editor">
    <!-- lookback：可增删正整数多值 -->
    <div class="dim-row">
      <span class="dim-label">回看根数 lookback</span>
      <div class="chips">
        <span v-for="(lb, i) in model.lookback_list" :key="`lb-${i}`" class="chip">
          {{ lb }}
          <button class="chip-x" type="button" title="删除" @click="removeLookback(i)">×</button>
        </span>
        <n-input-number
          v-model:value="newLookback"
          size="tiny"
          :min="LOOKBACK_MIN"
          :max="LOOKBACK_MAX"
          :precision="0"
          :show-button="false"
          :placeholder="`${LOOKBACK_MIN}~${LOOKBACK_MAX}`"
          style="width: 92px"
          @keyup.enter="addLookback"
        />
        <n-button size="tiny" :disabled="newLookback === null" @click="addLookback">+ 增</n-button>
      </div>
    </div>

    <!-- init_factor：可增删数值多值 -->
    <div class="dim-row">
      <span class="dim-label">初始止损系数 init_factor</span>
      <div class="chips">
        <span v-for="(f, i) in model.init_factor_list" :key="`if-${i}`" class="chip">
          {{ fmt3(f) }}
          <button class="chip-x" type="button" title="删除" @click="removeFactor('init_factor_list', i)">×</button>
        </span>
        <n-input-number
          v-model:value="newInitFactor"
          size="tiny"
          :min="FACTOR_MIN"
          :max="FACTOR_MAX"
          :precision="3"
          :show-button="false"
          :placeholder="`${FACTOR_MIN}~${FACTOR_MAX}`"
          style="width: 92px"
          @keyup.enter="addFactor('init_factor_list', 'newInitFactor')"
        />
        <n-button size="tiny" :disabled="newInitFactor === null" @click="addFactor('init_factor_list', 'newInitFactor')">+ 增</n-button>
      </div>
    </div>

    <!-- lock_factor：可增删数值多值 -->
    <div class="dim-row">
      <span class="dim-label">锁定止损系数 lock_factor</span>
      <div class="chips">
        <span v-for="(f, i) in model.lock_factor_list" :key="`lf-${i}`" class="chip">
          {{ fmt3(f) }}
          <button class="chip-x" type="button" title="删除" @click="removeFactor('lock_factor_list', i)">×</button>
        </span>
        <n-input-number
          v-model:value="newLockFactor"
          size="tiny"
          :min="FACTOR_MIN"
          :max="FACTOR_MAX"
          :precision="3"
          :show-button="false"
          :placeholder="`${FACTOR_MIN}~${FACTOR_MAX}`"
          style="width: 92px"
          @keyup.enter="addFactor('lock_factor_list', 'newLockFactor')"
        />
        <n-button size="tiny" :disabled="newLockFactor === null" @click="addFactor('lock_factor_list', 'newLockFactor')">+ 增</n-button>
      </div>
    </div>

    <!-- 实时网格规模预估 -->
    <div class="grid-estimate" :class="{ warn: gridCount > GRID_WARN_THRESHOLD, err: gridCount === 0 }">
      <template v-if="gridCount === 0">
        <span class="est-icon">⚠</span>
        每个维度至少保留 1 个候选值
      </template>
      <template v-else>
        <span v-if="gridCount > GRID_WARN_THRESHOLD" class="est-icon">⚠</span>
        将生成 <strong>{{ gridCount }}</strong> 个 phase_lock 出场配置
        <span v-if="gridCount > GRID_WARN_THRESHOLD" class="warn-hint">（数量较大，扫描耗时显著增加）</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PhaseLockGridEditor —— kelly_sweep phase_lock 出场族候选集编辑器（spec 02§kelly 默认网格 / 04§D5）。
 *
 * 3 维度编辑：lookback（正整数多值）、init_factor / lock_factor（数值多值）。各维度默认多值。
 *
 * 实时预估 = stores/kellySweep.ts 的 estimatePhaseLockGridSize（纯 TS 复刻后端 build_phase_lock_grid
 * 的笛卡尔积 + 量化去重），与 KellySweepConfigForm 顶部组合数预估共用同一函数（单一源、同口径）。
 * 输入归一同样复用 store 的 quantizePhaseLockFactor。
 *
 * 父组件用 defineModel 注入完整 PhaseLockGrid；本组件只读改其内容，不负责传/不传决策
 * （由父 KellySweepConfigForm 据 phase_lock 勾选决定是否把本对象拼进 phase_lock_grid job param）。
 *
 * 约束（.claude/rules/vue3-frontend.md）：默认候选集工厂 makeDefaultPhaseLockGrid() 在 store，
 * 由父组件初始化时调用（本组件无 withDefaults）。
 */
import { computed, ref } from 'vue'
import { NButton, NInputNumber } from 'naive-ui'
import type { PhaseLockGrid } from '@/api/modules/quant/kellySweep'
import { estimatePhaseLockGridSize, quantizePhaseLockFactor } from '@/stores/kellySweep'

// ── 范围约束（spec 02 §参数范围）+ 量化网格 + 护栏阈值 ─────────────────────────
/** lookback ∈ [1,250]（正整数，上界 ≈ 一年交易日，防误填巨值） */
const LOOKBACK_MIN = 1
const LOOKBACK_MAX = 250
/** init_factor / lock_factor ∈ (0,2.0]（千分位，允许 >1 锁盈，极少用但不禁止） */
const FACTOR_MIN = 0.001
const FACTOR_MAX = 2.0
/** phase_lock 族 cfg 软阈值（spec 02 §网格爆炸护栏「软阈值 200」，对齐 band_lock 现状）。
 *  注：后端硬护栏 200 仅 warn 不拒绝；前端取更早的 100 提醒。 */
const GRID_WARN_THRESHOLD = 100

// ── defineModel（父组件保证非空，已初始化为 makeDefaultPhaseLockGrid 深拷贝）──────
const model = defineModel<PhaseLockGrid>({ required: true })

// ── 新增值输入框 ─────────────────────────────────────────────────────────────
const newLookback = ref<number | null>(null)
const newInitFactor = ref<number | null>(null)
const newLockFactor = ref<number | null>(null)

function fmt3(r: number): string {
  return r.toFixed(3)
}

// ── lookback 增删（正整数去重） ──────────────────────────────────────────────
function addLookback() {
  const v = newLookback.value
  if (v === null || !Number.isInteger(v) || v < LOOKBACK_MIN || v > LOOKBACK_MAX) return
  if (!model.value.lookback_list.includes(v)) {
    model.value = { ...model.value, lookback_list: [...model.value.lookback_list, v] }
  }
  newLookback.value = null
}

function removeLookback(i: number) {
  model.value = {
    ...model.value,
    lookback_list: model.value.lookback_list.filter((_, idx) => idx !== i),
  }
}

// ── factor 维度增删（init_factor_list / lock_factor_list） ────────────────────
type FactorKey = 'init_factor_list' | 'lock_factor_list'
type NewFactorRef = 'newInitFactor' | 'newLockFactor'

const newFactorRefs = { newInitFactor, newLockFactor }

function addFactor(key: FactorKey, refName: NewFactorRef) {
  const refObj = newFactorRefs[refName]
  const v = refObj.value
  if (v === null) return
  // 量化后去重：用户输入 0.9991 / 0.9992 都量化到 0.999，避免视觉重复（与后端去重同口径）
  const q = quantizePhaseLockFactor(v)
  const quantizedExisting = model.value[key].map(quantizePhaseLockFactor)
  if (!quantizedExisting.includes(q)) {
    model.value = { ...model.value, [key]: [...model.value[key], q] }
  }
  refObj.value = null
}

function removeFactor(key: FactorKey, i: number) {
  model.value = { ...model.value, [key]: model.value[key].filter((_, idx) => idx !== i) }
}

// ── 实时网格规模预估（委托 store 共享纯函数，与组合数预估同口径） ───────────────
const gridCount = computed(() => estimatePhaseLockGridSize(model.value))
</script>

<style scoped>
.phase-lock-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dim-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.dim-label {
  font-size: 12px;
  color: var(--color-text-muted);
  min-width: 168px;
  flex-shrink: 0;
  padding-top: 4px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  padding: 1px 4px 1px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-primary, #2080f0) 14%, transparent);
  color: var(--color-text-secondary);
}
.chip-x {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--color-text-muted);
  padding: 0 2px;
}
.chip-x:hover {
  color: var(--color-error, #d03050);
}

.grid-estimate {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.grid-estimate.warn {
  color: #d97706;
}
.grid-estimate.err {
  color: var(--color-error, #d03050);
}
.est-icon {
  font-size: 13px;
}
.warn-hint {
  color: #d97706;
}
</style>

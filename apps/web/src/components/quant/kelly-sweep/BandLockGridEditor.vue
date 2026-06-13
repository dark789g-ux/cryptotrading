<template>
  <div class="band-lock-editor">
    <!-- max_hold：可增删多值（含「不封顶」=null） -->
    <div class="dim-row">
      <span class="dim-label">最长持有 max_hold</span>
      <div class="chips">
        <span
          v-for="(mh, i) in model.max_hold_list"
          :key="`mh-${i}`"
          class="chip"
        >
          {{ mh === null ? '不封顶' : mh }}
          <button class="chip-x" type="button" title="删除" @click="removeMaxHold(i)">×</button>
        </span>
        <n-input-number
          v-model:value="newMaxHold"
          size="tiny"
          :min="1"
          :precision="0"
          :show-button="false"
          placeholder="正整数"
          style="width: 92px"
          @keyup.enter="addMaxHold(false)"
        />
        <n-button size="tiny" :disabled="newMaxHold === null" @click="addMaxHold(false)">+ 增</n-button>
        <n-button size="tiny" tertiary @click="addMaxHold(true)">+ 不封顶</n-button>
      </div>
    </div>

    <!-- stop_ratio：可增删数值多值 -->
    <div class="dim-row">
      <span class="dim-label">止损缓冲系数</span>
      <div class="chips">
        <span v-for="(sr, i) in model.stop_ratio_list" :key="`sr-${i}`" class="chip">
          {{ fmt3(sr) }}
          <button class="chip-x" type="button" title="删除" @click="removeRatio('stop_ratio_list', i)">×</button>
        </span>
        <n-input-number
          v-model:value="newStopRatio"
          size="tiny"
          :min="STOP_MIN"
          :max="STOP_MAX"
          :precision="3"
          :show-button="false"
          :placeholder="`${STOP_MIN}~${STOP_MAX}`"
          style="width: 92px"
          @keyup.enter="addRatio('stop_ratio_list', 'newStopRatio')"
        />
        <n-button size="tiny" :disabled="newStopRatio === null" @click="addRatio('stop_ratio_list', 'newStopRatio')">+ 增</n-button>
      </div>
    </div>

    <!-- floor_ratio：可增删数值多值（floor_enabled 含 false 时不影响 false 分支） -->
    <div class="dim-row">
      <span class="dim-label">成本地板系数</span>
      <div class="chips">
        <span v-for="(fr, i) in model.floor_ratio_list" :key="`fr-${i}`" class="chip">
          {{ fmt3(fr) }}
          <button class="chip-x" type="button" title="删除" @click="removeRatio('floor_ratio_list', i)">×</button>
        </span>
        <n-input-number
          v-model:value="newFloorRatio"
          size="tiny"
          :min="FLOOR_MIN"
          :max="FLOOR_MAX"
          :precision="3"
          :show-button="false"
          :placeholder="`${FLOOR_MIN}~${FLOOR_MAX}`"
          style="width: 92px"
          @keyup.enter="addRatio('floor_ratio_list', 'newFloorRatio')"
        />
        <n-button size="tiny" :disabled="newFloorRatio === null" @click="addRatio('floor_ratio_list', 'newFloorRatio')">+ 增</n-button>
      </div>
    </div>

    <!-- floor_enabled：true/false 多选 -->
    <div class="dim-row">
      <span class="dim-label">启用成本地板</span>
      <div class="bool-group">
        <n-checkbox
          v-for="b in BOOL_OPTIONS"
          :key="`fe-${String(b.value)}`"
          :checked="model.floor_enabled_list.includes(b.value)"
          size="small"
          @update:checked="(v) => toggleBool('floor_enabled_list', b.value, v)"
        >
          {{ b.label }}
        </n-checkbox>
      </div>
    </div>

    <!-- ma5_require_down：true/false 多选 -->
    <div class="dim-row">
      <span class="dim-label">MA5 需下行才离场</span>
      <div class="bool-group">
        <n-checkbox
          v-for="b in BOOL_OPTIONS"
          :key="`md-${String(b.value)}`"
          :checked="model.ma5_require_down_list.includes(b.value)"
          size="small"
          @update:checked="(v) => toggleBool('ma5_require_down_list', b.value, v)"
        >
          {{ b.label }}
        </n-checkbox>
      </div>
    </div>

    <!-- 实时网格规模预估 -->
    <div class="grid-estimate" :class="{ warn: gridCount > GRID_WARN_THRESHOLD, err: gridCount === 0 }">
      <template v-if="gridCount === 0">
        <span class="est-icon">⚠</span>
        每个数值/布尔维度至少保留 1 个候选值
      </template>
      <template v-else>
        <span v-if="gridCount > GRID_WARN_THRESHOLD" class="est-icon">⚠</span>
        将生成 <strong>{{ gridCount }}</strong> 个 band_lock 出场配置
        <span v-if="gridCount > GRID_WARN_THRESHOLD" class="warn-hint">（数量较大，扫描耗时显著增加）</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * BandLockGridEditor —— kelly_sweep band_lock 出场族候选集编辑器（spec 05§五）。
 *
 * 5 维度编辑：max_hold（含「不封顶」=null）、stop_ratio / floor_ratio（数值多值）、
 * floor_enabled / ma5_require_down（bool 多选）。各维度默认单值 = 退化成现状。
 *
 * 实时预估纯 TS 复刻后端 build_band_lock_grid（sweep.py:173-）的笛卡尔积 + 坍缩去重：
 *   1. 各候选集先量化去重（ratio: NNNN=Math.round(r*1000)；与 Python round-half-up 逐位一致，
 *      ratio 恒正；band_lock_scheme.py:_round_half_up_nnnn）。
 *   2. 笛卡尔积 max_hold × stop_ratio × floor_enabled × ma5_require_down，每组合再展开 floor_ratio。
 *   3. 坍缩去重：floor_enabled=false 时 floor_ratio 不展开（占位默认），
 *      指纹 = (mh, sr, fe, md, fe ? fr : null)（band_lock_scheme + sweep.py:231-249）。
 *
 * 父组件用 defineModel 注入完整 BandLockGrid；本组件只读改其内容，不负责传/不传决策
 * （由父 KellySweepConfigForm 据 band_lock 勾选决定是否把本对象拼进 band_lock_grid job param）。
 *
 * 约束（.claude/rules/vue3-frontend.md）：watch 默认懒执行；withDefaults 默认值禁引用局部变量
 * （本组件无 withDefaults；默认候选集工厂 makeDefaultBandLockGrid() 在 store，由父组件初始化时调用）。
 */
import { computed, ref } from 'vue'
import { NButton, NCheckbox, NInputNumber } from 'naive-ui'
import type { BandLockGrid } from '@/api/modules/quant/kellySweep'

// ── 范围约束（spec 01 §一）+ 量化网格 + 护栏阈值 ─────────────────────────────
/** stop_ratio ∈ [0.001, 1.0]（band_lock_scheme.py STOP_RATIO_NNNN_MIN/MAX，千分位） */
const STOP_MIN = 0.001
const STOP_MAX = 1.0
/** floor_ratio ∈ [0.001, 9.999]（允许 >1 锁盈；FLOOR_RATIO_NNNN_MIN/MAX） */
const FLOOR_MIN = 0.001
const FLOOR_MAX = 9.999
/** 量化千分位网格（NNNN = Math.round(ratio*1000)，band_lock_scheme.py RATIO_GRID=1000） */
const RATIO_GRID = 1000
/** band_lock 族 cfg 软阈值（spec 05§五「超软阈值（如 100）黄字提醒」）。
 *  注：后端硬护栏 _BAND_LOCK_GRID_WARN_THRESHOLD=200 仅 warn 不拒绝；前端取更早的 100 提醒。 */
const GRID_WARN_THRESHOLD = 100

const BOOL_OPTIONS: { label: string; value: boolean }[] = [
  { label: 'true', value: true },
  { label: 'false', value: false },
]

// ── defineModel（父组件保证非空，已初始化为 DEFAULT_BAND_LOCK_GRID 深拷贝）──────
const model = defineModel<BandLockGrid>({ required: true })

// ── 新增值输入框 ─────────────────────────────────────────────────────────────
const newMaxHold = ref<number | null>(null)
const newStopRatio = ref<number | null>(null)
const newFloorRatio = ref<number | null>(null)

/** 量化：ratio → NNNN/1000（round-half-up，ratio 恒正 → Math.round 与 Python floor(x+0.5) 一致） */
function quantizeRatio(r: number): number {
  return Math.round(r * RATIO_GRID) / RATIO_GRID
}

function fmt3(r: number): string {
  return r.toFixed(3)
}

// ── max_hold 增删 ────────────────────────────────────────────────────────────
function addMaxHold(asNull: boolean) {
  if (asNull) {
    if (!model.value.max_hold_list.includes(null)) {
      model.value = { ...model.value, max_hold_list: [...model.value.max_hold_list, null] }
    }
    return
  }
  const v = newMaxHold.value
  if (v === null || !Number.isInteger(v) || v < 1) return
  if (!model.value.max_hold_list.includes(v)) {
    model.value = { ...model.value, max_hold_list: [...model.value.max_hold_list, v] }
  }
  newMaxHold.value = null
}

function removeMaxHold(i: number) {
  model.value = {
    ...model.value,
    max_hold_list: model.value.max_hold_list.filter((_, idx) => idx !== i),
  }
}

// ── ratio 维度增删（stop_ratio_list / floor_ratio_list） ─────────────────────
type RatioKey = 'stop_ratio_list' | 'floor_ratio_list'
type NewRatioRef = 'newStopRatio' | 'newFloorRatio'

const newRatioRefs = { newStopRatio, newFloorRatio }

function addRatio(key: RatioKey, refName: NewRatioRef) {
  const refObj = newRatioRefs[refName]
  const v = refObj.value
  if (v === null) return
  // 量化后去重：用户输入 0.9991 / 0.9992 都量化到 0.999，避免视觉重复（与后端 _dedup_keep_order 同口径）
  const q = quantizeRatio(v)
  const quantizedExisting = model.value[key].map(quantizeRatio)
  if (!quantizedExisting.includes(q)) {
    model.value = { ...model.value, [key]: [...model.value[key], q] }
  }
  refObj.value = null
}

function removeRatio(key: RatioKey, i: number) {
  model.value = { ...model.value, [key]: model.value[key].filter((_, idx) => idx !== i) }
}

// ── bool 维度多选（floor_enabled_list / ma5_require_down_list） ───────────────
type BoolKey = 'floor_enabled_list' | 'ma5_require_down_list'

function toggleBool(key: BoolKey, value: boolean, checked: boolean) {
  const cur = model.value[key]
  if (checked) {
    if (!cur.includes(value)) {
      model.value = { ...model.value, [key]: [...cur, value] }
    }
  } else {
    model.value = { ...model.value, [key]: cur.filter((x) => x !== value) }
  }
}

// ── 实时网格规模预估（纯 TS 复刻 build_band_lock_grid 笛卡尔积 + 坍缩去重） ────
/** 量化去重保序：ratio 维度按量化值去重，与 Python _dedup_keep_order 同口径 */
function dedupQuantizedRatios(list: number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const r of list) {
    const q = quantizeRatio(r)
    if (!seen.has(q)) {
      seen.add(q)
      out.push(q)
    }
  }
  return out
}

function dedup<T>(list: T[]): T[] {
  return Array.from(new Set(list))
}

const gridCount = computed(() => {
  const maxHolds = dedup(model.value.max_hold_list)
  const stops = dedupQuantizedRatios(model.value.stop_ratio_list)
  const floors = dedupQuantizedRatios(model.value.floor_ratio_list)
  const floorEnableds = dedup(model.value.floor_enabled_list)
  const ma5s = dedup(model.value.ma5_require_down_list)

  // 任一维度空 → 后端会因笛卡尔积为空 / build_exit_grid 校验失败而无配置；前端按 0 提示
  if (
    maxHolds.length === 0 || stops.length === 0 || floorEnableds.length === 0 ||
    ma5s.length === 0 || floors.length === 0
  ) {
    return 0
  }

  // 笛卡尔积 + 坍缩去重：指纹 (mh, sr, fe, md, fe ? fr : null)
  const seen = new Set<string>()
  for (const mh of maxHolds) {
    for (const sr of stops) {
      for (const fe of floorEnableds) {
        for (const md of ma5s) {
          const frCandidates = fe ? floors : [null]
          for (const fr of frCandidates) {
            const fingerprint = JSON.stringify([mh, sr, fe, md, fe ? fr : null])
            seen.add(fingerprint)
          }
        }
      }
    }
  }
  return seen.size
})
</script>

<style scoped>
.band-lock-editor {
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
  min-width: 132px;
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

.bool-group {
  display: flex;
  gap: 16px;
  align-items: center;
  padding-top: 2px;
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

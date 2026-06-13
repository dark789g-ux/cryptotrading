/**
 * usePhaseLockGrid
 *
 * 管理 KellySweepConfigForm 中 phase_lock 出场族的「独立开关 + v-model 桥接」逻辑。
 *
 * presence-driven（完全镜像 band_lock）：phase_lock 不属 NestJS DTO 合法 exit_families
 * {fixed_n,tp_sl,trailing,atr_stop}（KELLY_SWEEP_EXIT_FAMILIES 不放行），故不写入
 * config.exit_families；phase_lock 段是否生效**仅由 config.phase_lock_grid 是否存在驱动**
 * （Python kelly_sweep_runner._build_exit_grid_from_params：phase_lock_grid 提供 → 生成段）。
 *
 * 抽成 composable：让 KellySweepConfigForm 维持 lint:quant-lines 单文件 ≤500 行红线
 * （band_lock 同款逻辑暂留 view 内联，不在本次改动范围重构）。
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import type { SweepParams, PhaseLockGrid } from '@/api/modules/quant/kellySweep'
import { makeDefaultPhaseLockGrid } from '@/stores/kellySweep'

export function usePhaseLockGrid(config: Ref<SweepParams>) {
  /** 勾选态：config.phase_lock_grid 存在即开启 */
  const phaseLockEnabled = computed(() => config.value.phase_lock_grid !== undefined)

  /** 勾选 → 写默认候选集；取消 → 解构删除该 key（恢复现状，不扫 phase_lock） */
  function togglePhaseLock(checked: boolean) {
    if (checked) {
      config.value = { ...config.value, phase_lock_grid: makeDefaultPhaseLockGrid() }
    } else {
      const { phase_lock_grid, ...rest } = config.value
      void phase_lock_grid
      config.value = rest as SweepParams
    }
  }

  /** 候选集 v-model 桥接：getter 兜底默认（v-if 保证仅 enabled 时渲染），setter 写回 config */
  const phaseLockGridModel = computed<PhaseLockGrid>({
    get: () => config.value.phase_lock_grid ?? makeDefaultPhaseLockGrid(),
    set: (v) => {
      config.value = { ...config.value, phase_lock_grid: v }
    },
  })

  return { phaseLockEnabled, togglePhaseLock, phaseLockGridModel }
}

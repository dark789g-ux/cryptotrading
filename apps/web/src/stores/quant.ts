/**
 * 量化模块共享状态
 *
 * - currentModelVersion / availableModelVersions：Overview / Scores / Runs 共用
 * - URL 同步由各 view 自行 push（store 只持有状态，不直接耦合 router，便于多 view 独立 URL schema）
 * - fetchAvailableVersions 带 in-flight 去重，多 view 同时 mount 不会重复请求
 *
 * 设计约束（CLAUDE.md）：
 * - 仅暴露 ref + 函数；不在 store 内 watch URL（路由变化由组件决策）
 * - 切换 version 不在此触发数据加载，view 自行 onActivated 拉数据
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { quantApi, type ModelVersionInfo } from '@/api/modules/quant'

export const useQuantStore = defineStore('quant', () => {
  /** 当前选中的 model_version；null 表示尚未选择 */
  const currentModelVersion = ref<string | null>(null)
  /** 后端已知的全部 model_version 列表（按 created_at 倒序由后端给出） */
  const availableModelVersions = ref<ModelVersionInfo[]>([])
  const loadingVersions = ref(false)
  const versionsLoadedAt = ref<number | null>(null)
  const lastError = ref<string | null>(null)

  let inflight: Promise<void> | null = null

  /** 派生：仅版本名数组，供下拉等场景使用 */
  const versionNames = computed(() => availableModelVersions.value.map(v => v.model_version))

  /**
   * 拉取版本列表。
   * - 5 分钟内复用上次结果；force=true 跳过缓存。
   * - 在 5 秒内的并发调用复用同一 Promise。
   */
  async function fetchAvailableVersions(force = false): Promise<void> {
    const now = Date.now()
    if (!force && versionsLoadedAt.value && now - versionsLoadedAt.value < 5 * 60_000) {
      return
    }
    if (inflight) return inflight
    loadingVersions.value = true
    lastError.value = null
    inflight = (async () => {
      try {
        const res = await quantApi.getModelVersions()
        availableModelVersions.value = res.items ?? []
        versionsLoadedAt.value = Date.now()
        // 若未选中且后端返回非空：默认选第一个（最新）
        if (!currentModelVersion.value && availableModelVersions.value.length > 0) {
          currentModelVersion.value = availableModelVersions.value[0].model_version
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        lastError.value = `加载模型版本列表失败：${msg}`
        // 不清空已有 availableModelVersions，保留上一次成功的结果
      } finally {
        loadingVersions.value = false
        inflight = null
      }
    })()
    return inflight
  }

  /** 显式设置当前版本（一般由 view 在解析 URL query 时调用） */
  function setCurrentModelVersion(v: string | null): void {
    currentModelVersion.value = v && v.length > 0 ? v : null
  }

  /**
   * 校验某 model_version 是否在可用列表中。
   * 在 URL 中带过来的 model_version 可能已被删除/重命名，view 切换时用以判断是否回退到默认。
   */
  function isKnownVersion(v: string | null | undefined): boolean {
    if (!v) return false
    return availableModelVersions.value.some(x => x.model_version === v)
  }

  return {
    currentModelVersion,
    availableModelVersions,
    versionNames,
    loadingVersions,
    versionsLoadedAt,
    lastError,
    fetchAvailableVersions,
    setCurrentModelVersion,
    isKnownVersion,
  }
})

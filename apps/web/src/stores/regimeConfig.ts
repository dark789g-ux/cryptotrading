import { defineStore } from 'pinia'
import { ref } from 'vue'
import { regimeEngineApi } from '../api/modules/strategy/regimeEngine'
import type {
  RegimeStrategyConfig,
  CreateRegimeConfigDto,
  UpdateRegimeConfigDto,
} from '../api/modules/strategy/regimeEngine'

export const useRegimeConfigStore = defineStore('regimeConfig', () => {
  const configs = ref<RegimeStrategyConfig[]>([])
  const loading = ref(false)

  async function fetchConfigs() {
    loading.value = true
    try {
      configs.value = await regimeEngineApi.listConfigs()
    } finally {
      loading.value = false
    }
  }

  async function createConfig(dto: CreateRegimeConfigDto) {
    await regimeEngineApi.createConfig(dto)
    await fetchConfigs()
  }

  async function updateConfig(id: string, dto: UpdateRegimeConfigDto) {
    await regimeEngineApi.updateConfig(id, dto)
    await fetchConfigs()
  }

  async function activateConfig(id: string) {
    await regimeEngineApi.activateConfig(id)
    await fetchConfigs()
  }

  async function duplicateConfig(sourceId: string) {
    const source = configs.value.find(c => c.id === sourceId)
    if (!source) throw new Error('源配置不存在')
    await createConfig({ config: source.config, note: source.note })
  }

  return {
    configs,
    loading,
    fetchConfigs,
    createConfig,
    updateConfig,
    activateConfig,
    duplicateConfig,
  }
})

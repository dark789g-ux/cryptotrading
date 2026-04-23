import { ref, watch } from 'vue'
import { useMessage } from 'naive-ui'

export const useEditableNumber = (
  getValue: () => number,
  setValue: (v: number) => void,
  opts: { min: number; max: number; decimals: number; scale?: number }
) => {
  const message = useMessage()
  const display = ref('')

  const updateDisplay = () => {
    const v = getValue()
    display.value = opts.scale ? (v * opts.scale).toFixed(opts.decimals) : v.toFixed(opts.decimals)
  }

  watch(getValue, updateDisplay, { immediate: true })

  const commit = () => {
    const raw = display.value.trim().replace('%', '')
    const num = Number(raw)
    if (!Number.isFinite(num) || raw === '') {
      message.warning('请输入有效数字')
      updateDisplay()
      return
    }
    const val = opts.scale ? num / opts.scale : num
    const clamped = Math.min(opts.max, Math.max(opts.min, val))
    const rounded = Math.round(clamped * 10 ** opts.decimals) / 10 ** opts.decimals
    if (Math.abs(rounded - val) > 1e-9) {
      message.info(`已调整为 ${opts.scale ? (rounded * opts.scale).toFixed(opts.decimals) : rounded.toFixed(opts.decimals)}${opts.scale ? '%' : ''}`)
    }
    setValue(rounded)
    display.value = opts.scale ? (rounded * opts.scale).toFixed(opts.decimals) : rounded.toFixed(opts.decimals)
  }

  return { display, commit, updateDisplay }
}

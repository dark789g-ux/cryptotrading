import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { NButton, NConfigProvider, NInputNumber } from 'naive-ui'

import KdjParamsEditor from './KdjParamsEditor.vue'
import { DEFAULT_KDJ_PARAMS, KDJ_PARAM_RANGES } from '@/composables/kline/subplotConfig'

function mountEditor(props: {
  params?: { n: number; m1: number; m2: number }
  defaultParams?: { n: number; m1: number; m2: number }
}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(
          NConfigProvider,
          null,
          {
            default: () =>
              h(KdjParamsEditor, {
                params: props.params,
                defaultParams: props.defaultParams ?? DEFAULT_KDJ_PARAMS,
                ranges: KDJ_PARAM_RANGES,
                onConfirm,
                onCancel,
              }),
          },
        )
    },
  })
  const wrapper = mount(Wrapper, { attachTo: document.body })
  return { wrapper, onConfirm, onCancel }
}

function inputComponents(wrapper: ReturnType<typeof mountEditor>['wrapper']) {
  return wrapper.findAllComponents(NInputNumber)
}

describe('KdjParamsEditor', () => {
  it('无 params 时以 defaultParams 初始化输入框', async () => {
    const { wrapper } = mountEditor({})
    await nextTick()
    const [nInput, m1Input, m2Input] = inputComponents(wrapper)
    expect(nInput.props('value')).toBe(DEFAULT_KDJ_PARAMS.n)
    expect(m1Input.props('value')).toBe(DEFAULT_KDJ_PARAMS.m1)
    expect(m2Input.props('value')).toBe(DEFAULT_KDJ_PARAMS.m2)
  })

  it('有 params 时以传入值初始化输入框', async () => {
    const { wrapper } = mountEditor({ params: { n: 14, m1: 5, m2: 3 } })
    await nextTick()
    const [nInput, m1Input, m2Input] = inputComponents(wrapper)
    expect(nInput.props('value')).toBe(14)
    expect(m1Input.props('value')).toBe(5)
    expect(m2Input.props('value')).toBe(3)
  })

  it('修改参数 → 点确定 emit confirm', async () => {
    const { wrapper, onConfirm, onCancel } = mountEditor({})
    await nextTick()
    const [nInput, m1Input, m2Input] = inputComponents(wrapper)

    nInput.vm.$emit('update:value', 14)
    m1Input.vm.$emit('update:value', 5)
    m2Input.vm.$emit('update:value', 3)
    await nextTick()

    const confirmBtn = wrapper.findAllComponents(NButton).find((b) => b.text() === '确定')
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ n: 14, m1: 5, m2: 3 })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('点取消 emit cancel 且不 emit confirm', async () => {
    const { wrapper, onConfirm, onCancel } = mountEditor({})
    await nextTick()
    const [nInput] = inputComponents(wrapper)
    nInput.vm.$emit('update:value', 14)
    await nextTick()

    const cancelBtn = wrapper.findAllComponents(NButton).find((b) => b.text() === '取消')
    expect(cancelBtn).toBeTruthy()
    await cancelBtn!.trigger('click')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('n=99 是合法输入，点确定 emit confirm', async () => {
    const { wrapper, onConfirm } = mountEditor({})
    await nextTick()
    const [nInput] = inputComponents(wrapper)

    nInput.vm.$emit('update:value', 99)
    await nextTick()

    const confirmBtn = wrapper.findAllComponents(NButton).find((b) => b.text() === '确定')
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ n: 99, m1: DEFAULT_KDJ_PARAMS.m1, m2: DEFAULT_KDJ_PARAMS.m2 })
  })

  it('n=100 超出范围时 confirm 不触发', async () => {
    const { wrapper, onConfirm } = mountEditor({})
    await nextTick()
    const [nInput] = inputComponents(wrapper)

    nInput.vm.$emit('update:value', 100)
    await nextTick()

    const confirmBtn = wrapper.findAllComponents(NButton).find((b) => b.text() === '确定')
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')

    expect(onConfirm).not.toHaveBeenCalled()
  })
})

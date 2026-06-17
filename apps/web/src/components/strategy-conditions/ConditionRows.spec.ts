/**
 * ConditionRows 单测：KDJ 行内三参数框（N/M1/M2）+ compareField 约束（T2）。
 *
 * 覆盖：
 *  - a-share 选 KDJ 字段 → 出现 3 个参数输入框；选非 KDJ 字段 → 无参数框。
 *  - crypto 选 KDJ 字段 → 无参数框（v1 gate：加密走固定 9/3/3，不显示以免误导）。
 *  - field 从 KDJ 切到非 KDJ → item.kdjParams 被清除。
 *  - 参数填 6/2/2 → item.kdjParams === {n:6,m1:2,m2:2}；填回 9/3/3 → kdjParams 被清除。
 *  - 自定义 KDJ + compareMode='field' → 可选 compareField 仅 KDJ 字段。
 *
 * 走真实 DOM：通过 naive-ui 子组件的 `update:value` 事件驱动（不调内部函数，<script setup>
 * 默认不暴露），断言落在受控 conditions（update:conditions emit）与渲染出的 :options。
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { NConfigProvider, NSelect, NInputNumber } from 'naive-ui';

import ConditionRows from './ConditionRows.vue';
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions';

function mountRows(
  initial: StrategyConditionItem[],
  targetType: 'a-share' | 'crypto',
  enableKdjParams = false,
) {
  const conditions = ref<StrategyConditionItem[]>(initial.map((c) => ({ ...c })));
  const Wrapper = defineComponent({
    components: { NConfigProvider, ConditionRows },
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(ConditionRows, {
              conditions: conditions.value,
              targetType,
              enableKdjParams,
              'onUpdate:conditions': (next: StrategyConditionItem[]) => {
                conditions.value = next;
              },
            }),
        });
    },
  });
  const wrapper = mount(Wrapper, { attachTo: document.body });
  return { wrapper, conditions };
}

type Wrapper = ReturnType<typeof mountRows>['wrapper'];

/** KDJ 参数输入框数量（带 .kdj-param-input class 的 n-input-number） */
function countKdjParamInputs(wrapper: Wrapper): number {
  return wrapper.findAll('.kdj-param-input').length;
}

/** 三个 KDJ 参数 n-input-number 组件（顺序 = N/M1/M2） */
function kdjParamComponents(wrapper: Wrapper) {
  return wrapper
    .findAllComponents(NInputNumber)
    .filter((c) => (c.classes?.() ?? []).includes('kdj-param-input'));
}

/** 字段选择器（第一个 .field-select n-select 即左侧字段） */
function fieldSelect(wrapper: Wrapper) {
  return wrapper.findAllComponents(NSelect)[0];
}

describe('ConditionRows KDJ 行内参数（a-share）', () => {
  it('a-share 选 KDJ 字段 → 出现 3 个参数输入框', async () => {
    const { wrapper } = mountRows(
      [{ field: 'kdj_j', operator: 'gt', value: undefined, compareMode: 'value' }],
      'a-share',
      true,
    );
    await nextTick();
    expect(countKdjParamInputs(wrapper)).toBe(3);
  });

  it('a-share 选非 KDJ 字段 → 无参数框', async () => {
    const { wrapper } = mountRows(
      [{ field: 'ma5', operator: 'gt', value: undefined, compareMode: 'value' }],
      'a-share',
      true,
    );
    await nextTick();
    expect(countKdjParamInputs(wrapper)).toBe(0);
  });

  it('crypto 选 KDJ 字段 → 无参数框（v1 gate）', async () => {
    const { wrapper } = mountRows(
      [{ field: 'kdj_j', operator: 'gt', value: undefined, compareMode: 'value' }],
      'crypto',
      true,
    );
    await nextTick();
    expect(countKdjParamInputs(wrapper)).toBe(0);
  });

  it('enableKdjParams 缺省（默认 false）→ a-share 选 KDJ 字段无参数框（守门：非 StrategyConditionBuilder 消费方）', async () => {
    const { wrapper } = mountRows(
      [{ field: 'kdj_j', operator: 'gt', value: undefined, compareMode: 'value' }],
      'a-share',
      // 不传 enableKdjParams → 默认 false
    );
    await nextTick();
    expect(countKdjParamInputs(wrapper)).toBe(0);
  });
});

describe('ConditionRows KDJ 参数存储口径', () => {
  it('field 从 KDJ 切到非 KDJ → item.kdjParams 被清除', async () => {
    const { wrapper, conditions } = mountRows(
      [
        {
          field: 'kdj_j',
          operator: 'gt',
          value: undefined,
          compareMode: 'value',
          kdjParams: { n: 6, m1: 2, m2: 2 },
        },
      ],
      'a-share',
      true,
    );
    await nextTick();
    fieldSelect(wrapper).vm.$emit('update:value', 'ma5');
    await nextTick();
    expect(conditions.value[0].field).toBe('ma5');
    expect(conditions.value[0].kdjParams).toBeUndefined();
  });

  it('参数填 6/2/2 → kdjParams === {n:6,m1:2,m2:2}', async () => {
    const { wrapper, conditions } = mountRows(
      [{ field: 'kdj_j', operator: 'gt', value: undefined, compareMode: 'value' }],
      'a-share',
      true,
    );
    await nextTick();
    const [nInput, m1Input, m2Input] = kdjParamComponents(wrapper);
    nInput.vm.$emit('update:value', 6);
    await nextTick();
    m1Input.vm.$emit('update:value', 2);
    await nextTick();
    m2Input.vm.$emit('update:value', 2);
    await nextTick();
    expect(conditions.value[0].kdjParams).toEqual({ n: 6, m1: 2, m2: 2 });
  });

  it('参数从 6/2/2 改回 9/3/3 → kdjParams 被清除', async () => {
    const { wrapper, conditions } = mountRows(
      [
        {
          field: 'kdj_j',
          operator: 'gt',
          value: undefined,
          compareMode: 'value',
          kdjParams: { n: 6, m1: 2, m2: 2 },
        },
      ],
      'a-share',
      true,
    );
    await nextTick();
    const [nInput, m1Input, m2Input] = kdjParamComponents(wrapper);
    nInput.vm.$emit('update:value', 9);
    await nextTick();
    m1Input.vm.$emit('update:value', 3);
    await nextTick();
    m2Input.vm.$emit('update:value', 3);
    await nextTick();
    expect(conditions.value[0].kdjParams).toBeUndefined();
  });

  it('清空（null）某参数 → 回落默认值，其余非默认则 kdjParams 保留', async () => {
    const { wrapper, conditions } = mountRows(
      [
        {
          field: 'kdj_j',
          operator: 'gt',
          value: undefined,
          compareMode: 'value',
          kdjParams: { n: 6, m1: 2, m2: 2 },
        },
      ],
      'a-share',
      true,
    );
    await nextTick();
    const [nInput] = kdjParamComponents(wrapper);
    nInput.vm.$emit('update:value', null);
    await nextTick();
    expect(conditions.value[0].kdjParams).toEqual({ n: 9, m1: 2, m2: 2 });
  });
});

describe('ConditionRows 自定义 KDJ 比较约束', () => {
  /** 比较指标选择器（compareMode=field 时第二个 .field-select n-select） */
  function compareSelect(wrapper: Wrapper) {
    const selects = wrapper.findAllComponents(NSelect);
    // [0]=左侧字段, [1]=操作符, [2]=比较指标
    return selects.find((s, i) => i > 0 && (s.props('placeholder') === '比较指标'));
  }

  it('自定义 KDJ + compareMode=field → 可选 compareField 仅 KDJ 字段', async () => {
    const { wrapper } = mountRows(
      [
        {
          field: 'kdj_j',
          operator: 'gt',
          value: undefined,
          compareMode: 'field',
          compareField: undefined,
          kdjParams: { n: 6, m1: 2, m2: 2 },
        },
      ],
      'a-share',
      true,
    );
    await nextTick();
    const sel = compareSelect(wrapper);
    expect(sel).toBeTruthy();
    const opts = (sel!.props('options') ?? []) as Array<{ value: string }>;
    const values = opts.map((o) => o.value).sort();
    expect(values).toEqual(['kdj_d', 'kdj_j', 'kdj_k']);
  });

  it('默认参数 KDJ（非自定义）+ compareMode=field → compareField 不被收紧', async () => {
    const { wrapper } = mountRows(
      [{ field: 'kdj_j', operator: 'gt', value: undefined, compareMode: 'field' }],
      'a-share',
      true,
    );
    await nextTick();
    const sel = compareSelect(wrapper);
    expect(sel).toBeTruthy();
    const opts = (sel!.props('options') ?? []) as Array<{ value: string }>;
    const values = opts.map((o) => o.value);
    // 未自定义参数时维持 normal 组全集，含 ma5 等普通字段
    expect(values).toContain('ma5');
    expect(values).toContain('kdj_k');
  });

  it('enableKdjParams 缺省（默认 false）+ 带 kdjParams + compareMode=field → compareField 不被收窄（守门：不泄漏到非重算消费方）', async () => {
    const { wrapper } = mountRows(
      [
        {
          field: 'kdj_j',
          operator: 'gt',
          value: undefined,
          compareMode: 'field',
          compareField: undefined,
          kdjParams: { n: 6, m1: 2, m2: 2 },
        },
      ],
      'a-share',
      // 不传 enableKdjParams → 默认 false：即便条目带非默认 kdjParams 也不应触发 KDJ 收窄
    );
    await nextTick();
    const sel = compareSelect(wrapper);
    expect(sel).toBeTruthy();
    const opts = (sel!.props('options') ?? []) as Array<{ value: string }>;
    const values = opts.map((o) => o.value);
    // 未启用参数时维持 normal 组全集，含 ma5 等普通字段（未被收窄到仅 KDJ）
    expect(values).toContain('ma5');
    expect(values).toContain('kdj_k');
  });
});

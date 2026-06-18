# 3. 前端 Toolbar UI 改造

## 3.1 Toolbar 行内布局

**文件**：`apps/web/src/components/kline/KlineChartToolbar.vue`

```text
┌────────────────────────────────────────────────────┐
│ 副图设置                                            │
├────────────────────────────────────────────────────┤
│ [✓] KDJ(9,3,3)        [高度 8 %]   [⚙] [▲] [▼]    │
│ [✓] MACD              [高度 8 %]        [▲] [▼]    │
│ [✓] VOL               [高度 8 %]        [▲] [▼]    │
│ ...                                                │
└────────────────────────────────────────────────────┘
```

改动点：
- 仅当 `key === 'KDJ'` 时在该行右侧显示齿轮按钮；
- 指标名显示规则：存在自定义参数时显示 `KDJ(n,m1,m2)`，否则显示 `KDJ`。

齿轮点击后弹出 `NPopover`：

```text
┌───────────────────────┐
│ KDJ 参数               │
│ N    [      9       ] │
│ M1   [      3       ] │
│ M2   [      3       ] │
│           [取消][确定] │
└───────────────────────┘
```

## 3.2 新增子组件 KdjParamsEditor

为保持 Toolbar 文件不过大，把齿轮 + Popover 拆成独立子组件。

**新文件**：`apps/web/src/components/kline/KdjParamsEditor.vue`

Props：

```ts
params?: KdjSubplotParams
defaultParams: KdjSubplotParams
ranges: {
  n: [number, number]
  m1: [number, number]
  m2: [number, number]
}
```

Emits：

```ts
confirm(params: KdjSubplotParams)
cancel()
```

内部行为：
- 打开 Popover 时从 props 克隆一份 `draft`（字段均为 number，浅拷贝 `{ ...params ?? defaultParams }` 即可）：
  - 若 `params` 已传入，以 `params` 初始化；
  - 若 `params` 未传入，以 `defaultParams` 初始化；
- 三个 `NInputNumber`，绑定 `draft.n / draft.m1 / draft.m2`：
  - `precision: 0`；
  - 分别绑定 `min/max`；
- 点“确定”时做最终校验：
  - 三个字段均为整数；
  - 落在 `ranges` 内；
  - 校验通过后 `emit('confirm', draft)`；
- 点“取消”时仅 `emit('cancel')`。

## 3.3 Toolbar 内的使用方式

Toolbar 在 KDJ 行直接引用：

```text
<KdjParamsEditor
  :params="prefs.params?.KDJ"
  :default-params="DEFAULT_KDJ_PARAMS"
  :ranges="KDJ_PARAM_RANGES"
  @confirm="(p) => update({ params: { KDJ: p } })"
/>
```

注意：`update({ params: ... })` 由 `useKlineChartPrefs` 提供，会触发 `watch(prefs, ...)` 并向上 emit `update:prefs`。

## 3.4 视觉与交互细节

- 齿轮按钮使用 `CogOutline` 图标，尺寸与现有上移/下移按钮一致；
- Popover 宽度约 `220px`，避免遮挡相邻行；
- 确定按钮在非法输入时禁用；输入框在失焦或值越界时给出明确校验提示；
- 弹出层面板打开时，再次点击齿轮或点击外部区域关闭。

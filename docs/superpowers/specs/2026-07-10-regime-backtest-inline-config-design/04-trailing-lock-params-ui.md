# 04 · trailing_lock 参数 UI

## 目标

在象限「出场设置」中，选中 `trailing_lock` 时可配置全部引擎参数；字段旁「？」说明；高级项默认折叠。

引擎语义不变，见既有规范：  
[../2026-06-09-trailing-lock-exit-design/01-rule-semantics.md](../2026-06-09-trailing-lock-exit-design/01-rule-semantics.md)。

「方案二」= 买入日收盘 ≤ 开盘（定义见上述语义文档）。

## 布局（分层 A）

```text
┌─ 出场设置 ─────────────────────────────────────────────┐
│  出场模式  [ trailing_lock（尾部锁定） ▼ ]              │
│                                                         │
│  maxHold ?     [ 空=不限 ]     可清空                   │
│  止损系数 ?    [ 0.999   ]     直接填比例系数           │
│  保本地板 ?    [开关 开 ]                               │
│                                                         │
│  ▸ 高级参数                                             │
│    （默认折叠；非默认时标题旁「已自定义」，不强制展开）   │
└─────────────────────────────────────────────────────────┘

展开后：

│  ▾ 高级参数 · 已自定义（条件满足时）                    │
│    地板系数 ?   [ 0.999 ]  保本地板关时禁用             │
│    MA5 需下行 ? [开关 开]                               │
│    [恢复默认]   ← 仅重置高级区两项为默认                │
```

## 字段映射

| UI | exitParams | 类型 | 默认 |
|----|------------|------|------|
| maxHold | `maxHold` | `number \| null` | `null` |
| 止损系数 | `stopRatio` | `number` | `0.999` |
| 保本地板 | `floorEnabled` | `boolean` | `true` |
| 地板系数 | `floorRatio` | `number` | `0.999` |
| MA5 需下行 | `ma5RequireDown` | `boolean` | `true` |

输入方式：**直接填比例系数**（如 0.999），不做 % 换算。

## 「？」文案

| 字段 | 文案 |
|------|------|
| maxHold | 可交易持有日上限（停牌不计）。留空表示不设硬上限，仅靠止损/锁定后 MA5 出场。 |
| 止损系数 | 次日生效止损价 ≈ 基准价 × 该系数（默认 0.999）。越小止损越宽。未锁定时随日低点更新；锁定后冻结。 |
| 保本地板 | 仅方案二（买入日收盘≤开盘）有意义：曾收盘站上成本后，止损不低于约「成本 × 地板系数」。 |
| 地板系数 | 保本地板开启时，地板价 ≈ 成本 × 该系数。关闭保本地板时本项不生效。 |
| MA5 需下行 | 锁定后：除「收盘 < MA5」外，是否还要求当日 MA5 低于前一交易日 MA5，才触发离场。 |

## 交互规则

- 「？」：`n-tooltip` + 问号图标，挂在 label 旁  
- `floorEnabled=false` → 地板系数控件禁用；存盘可保留原 `floorRatio`  
- 「已自定义」：`floorRatio !== 0.999` 或 `ma5RequireDown !== true`  
- 「恢复默认」：仅 `floorRatio=0.999`、`ma5RequireDown=true`  
- 缺字段的旧配置：打开表单时用默认值做**展示层 hydrate**；用户未改动的高级项，保存时**显式写入默认值**（保证快照自描述）  
- 「？」文案中的「方案二」见上文定义

## 校验

```text
maxHold: null | 正整数
stopRatio ∈ (0, 1]
floorRatio ∈ (0, 1]
floorEnabled, ma5RequireDown: boolean
```

前端保存前校验；后端 `validateRegimeConfig` 对齐（今日仅严校验 maxHold，需扩展）。

## 落点

`RegimeConfigEditor.vue`（回测内嵌后同一组件）。`buildExitConfig` 已透传，无需改引擎。

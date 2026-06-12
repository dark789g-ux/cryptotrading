# Regime 配置管理前端页面设计

## 背景

Regime Engine 模块已有完整后端 API（createConfig / activateConfig / listConfigs），但前端缺少配置管理页面。目前只能通过 API 工具手动调用，无法可视化管理四象限策略配置。

## 目标

为 Regime Engine 添加前端配置管理页面，支持：
- 查看所有配置版本列表
- 新建配置（四象限可视化编辑）
- 基于现有配置复制新建
- 激活指定配置
- 归档（仅状态变更，不物理删除）

## 文件结构

```
apps/web/src/
├── views/strategy/
│   └── RegimeConfigView.vue          # 配置管理页面（列表 + 弹窗）
├── components/regime/
│   └── RegimeConfigEditor.vue        # 四象限配置表单组件
├── stores/
│   └── regimeConfig.ts               # Pinia store
└── api/modules/strategy/
    └── regimeEngine.ts               # 扩展 API
```

## 路由

```typescript
// router/index.ts
{
  path: '/regime-config',
  name: 'regime-config',
  component: () => import('../views/strategy/RegimeConfigView.vue'),
  meta: { title: 'Regime 配置管理', adminOnly: true },
}
```

侧边栏菜单：在 `strategy` 分组下添加「Regime 配置」入口。

## API 层

### 扩展 regimeEngine.ts

**已有方法**（无需改动）：`getToday()`、`getPicks(tradeDate)`、`listConfigs()`、`runDaily(tradeDate?)`

**新增方法**：

```typescript
export interface CreateRegimeConfigDto {
  version?: number
  note?: string | null
  config: Record<RegimeKey, RegimeConfigEntry>
}

export const regimeEngineApi = {
  // 已有方法：getToday, getPicks, listConfigs, runDaily

  createConfig(dto: CreateRegimeConfigDto): Promise<RegimeStrategyConfig> {
    return post<RegimeStrategyConfig>(`${API_BASE}/regime-engine/configs`, dto)
  },

  activateConfig(id: string): Promise<RegimeStrategyConfig> {
    return post<RegimeStrategyConfig>(`${API_BASE}/regime-engine/configs/${id}/activate`)
  },
}
```

## Store 设计

### stores/regimeConfig.ts

```typescript
export const useRegimeConfigStore = defineStore('regimeConfig', () => {
  const configs = ref<RegimeStrategyConfig[]>([])
  const loading = ref(false)

  async function fetchConfigs() { ... }
  async function createConfig(dto: CreateRegimeConfigDto) { ... }
  async function activateConfig(id: string) { ... }
  async function duplicateConfig(sourceId: string) { ... }

  return { configs, loading, fetchConfigs, createConfig, activateConfig, duplicateConfig }
})
```

`duplicateConfig` 逻辑：从源配置复制 `config` 字段，调 `createConfig`（version 自动递增）。

## 列表页设计

### RegimeConfigView.vue

**页面布局**：

```text
┌───────────────────────────────────────────────────────────────┐
│  Regime 配置管理                                               │
│  管理不同市场象限下的选股策略配置                    [新建配置]  │
├───────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 版本 │ 状态 │ 备注 │ 创建时间 │ 操作                   │  │
│  ├──────┼──────┼──────┼──────────┼────────────────────────┤  │
│  │ v3   │ draft│ v3测试│ 06-12   │ [编辑] [复制] [激活]   │  │
│  │ v2   │ active│ 正式 │ 06-10   │ [复制]                 │  │
│  │ v1   │ archived│ - │ 06-08   │ [复制]                 │  │
│  └──────┴──────┴──────┴──────────┴────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

**表格列定义**：

| 列 | 宽度 | 说明 |
|---|---|---|
| 版本 | 80px | `v${version}` |
| 状态 | 100px | NTag：draft=default, active=success, archived=warning |
| 备注 | flex | 截断显示 |
| 创建时间 | 160px | 格式化日期 |
| 操作 | auto | 按钮组，根据状态显示不同操作 |

**操作按钮逻辑**：
- **draft**：编辑 | 复制 | 激活
- **active**：复制（不可编辑/激活，已是当前生效配置）
- **archived**：复制（只读历史）

## 编辑弹窗设计

### RegimeConfigEditor.vue

**弹窗结构**：

```text
┌─────────────────────────────────────────────────────┐
│  新建配置 v4                              [×]       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  版本：[4    ] (自动递增，可修改)                     │
│  备注：[________________________________]            │
│                                                     │
│  ┌────────┬────────┬────────┬────────┐              │
│  │  Q1    │  Q2    │  Q3    │  Q4    │  ← NTabs     │
│  ├────────┴────────┴────────┴────────┤              │
│  │                                    │              │
│  │  动作：[ trade ▼ ]                 │              │
│  │  标签：[________________________]  │              │
│  │                                    │              │
│  │  ── 入场条件 ──                    │              │
│  │  ┌──────────────────────────────┐ │              │
│  │  │ ConditionRows 组件           │ │              │
│  │  │ [字段▼] [运算符▼] [值] [删除]│ │              │
│  │  │ + 添加条件                   │ │              │
│  │  └──────────────────────────────┘ │              │
│  │                                    │              │
│  │  ── 出场设置 ──                    │              │
│  │  出场模式：[ trailing_lock ▼ ]     │              │
│  │  ┌──────────────────────────────┐ │              │
│  │  │ trailing_lock: 最大持有天数  │ │              │
│  │  │   [null ▼] 或 [____] 天     │ │              │
│  │  │                              │ │              │
│  │  │ fixed_n: 持有天数            │ │              │
│  │  │   [____] 天                  │ │              │
│  │  │                              │ │              │
│  │  │ strategy: 退出条件 + 最大持有│ │              │
│  │  │   [ConditionRows] + [____]天 │ │              │
│  │  └──────────────────────────────┘ │              │
│  │                                    │              │
│  └────────────────────────────────────┘              │
│                                                     │
│                              [取消]  [保存]         │
└─────────────────────────────────────────────────────┘
```

**关键交互**：
1. **动作切换**：`trade` 显示入场条件 + 出场设置；`flat` 隐藏这些区域，仅显示 `label` 输入框（非必填，用于记录空仓理由）
2. **出场模式联动**：根据 `exitMode` 动态渲染对应表单
3. **编辑模式**：点击「编辑」时弹窗预填充当前配置数据（仅 draft 状态可编辑）
4. **复制新建**：预填充源配置的 config 字段，版本号自动递增（用户可修改，后端校验唯一性，重复时返回 409）
5. **校验**：前端预校验（非空条件、合法字段），后端 fail-fast 校验兜底

## 错误处理

- API 调用失败 → `message.error()` 提示，不中断页面状态
- 后端校验失败（400）→ 提取错误消息显示
- 激活冲突（409）→ 提示具体原因
- 无配置时：表格显示空状态，提示「暂无配置，点击新建」
- 加载中：表格显示 loading 状态
- 重复激活同一配置：后端幂等处理，前端直接刷新列表
- 激活操作：后端事务内自动将旧 active 配置 → archived，前端只需刷新列表，无需额外处理

## 权限控制

- 页面路由 `meta.adminOnly: true`
- 新建/编辑/激活按钮仅 admin 可见（`useAuth().isAdmin`）

## 数据流

```text
用户操作          Store (Pinia)         API 层            后端
───────────────────────────────────────────────────────────────
点击新建    →    打开弹窗（空表单）
填写表单    →    校验本地数据
点击保存    →    createConfig()    →  POST /configs  →  校验 + 落库
               ←  返回新配置      ←  响应             ←
               ←  刷新列表        ←  listConfigs()   ←
点击激活    →    activateConfig() →  POST /activate  →  事务换防
               ←  刷新列表        ←  listConfigs()   ←
点击复制    →    预填充弹窗        （复用 createConfig 流程）
```

## 实现要点

1. **复用现有组件**：
   - `AppModal`：弹窗容器
   - `ConditionRows`：条件行编辑器（入场条件 + strategy 出场条件）
   - `RegimeBadge`：象限状态展示

2. **表单状态管理**：
   - 弹窗状态（show/editingId/formData）由组件局部管理，不入 store
   - 四象限表单数据结构：`Record<RegimeKey, RegimeConfigEntry>`

3. **出场模式联动表单**：
   - `trailing_lock`：显示 maxHold 输入框（可为 null 或正整数）
   - `fixed_n`：显示 N 输入框（必填正整数）
   - `strategy`：显示 ConditionRows（退出条件）+ maxHold 输入框

## 验证标准

1. 列表页正确展示所有配置版本
2. 新建配置：四象限表单可正常填写并保存
3. 编辑配置：draft 状态可编辑，active/archived 不可编辑
4. 复制配置：预填充源配置，版本号自动递增
5. 激活配置：事务内换防，列表刷新
6. 错误场景：后端校验失败正确显示错误消息
7. 权限：非 admin 用户看不到管理操作按钮

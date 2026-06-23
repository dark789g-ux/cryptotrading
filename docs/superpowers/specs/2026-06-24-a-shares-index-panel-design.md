# A 股指数面板：新增“个股数”列与“跳转成分股”操作列

## 背景与目标

在 `A 股数据 → A 股指数` 面板中增强两个能力：

1. 表格列设置里新增字段 **“个股数”**，用户勾选后在列表展示该指数包含多少只成分股。
2. 表格新增 **“操作”** 列，点击图标按钮后跳转到 `A 股数据 → 股票` 页面，并自动筛选出该指数的成分股。

## 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 个股数覆盖范围 | 仅同花顺（`.TI`）与申万（`.SI`）指数显示；大盘宽基显示 `-` | 大盘宽基没有现成的成分股数量字段，且用户对宽基的“个股数”关注度低 |
| 跳转方式 | 当前页内子 tab 切换 | 与现有 `A 股数据` 页面的 `n-tabs` 架构一致，无需新增路由 |
| 操作列 UI | `n-button` 图标+文字按钮（`List` 图标 + “成分股” 文字） | 节省列宽，表意清晰 |
| 筛选区显示 | 在 `ASharesFilters.vue` 新增“所属指数”只读 tag + 清除按钮 | 用户能看到当前筛选条件并手动清除 |
| 跨 tab 通信 | 父组件 `ASharesTabsContainer` 通过 `ref` + `expose` 调用子面板方法 | 两个子 tab 是固定父子关系，直接通信最简洁 |

## 组件架构

```text
ASharesTabsContainer (父)
├── n-tabs v-model="subTab"
│   ├── pane "stocks"
│   │   └── ASharesPanel (ref: stocksPanelRef)
│   │       ├── ASharesFilters  ← 新增 "所属指数" tag + 清除
│   │       └── n-data-table
│   └── pane "index"
│       └── ASharesIndexPanel
│           ├── ASharesIndexThsPanel
│           │   └── n-data-table  ← 新增 "个股数" 列 + "操作" 列
│           └── ASharesIndexSwPanel
│               └── n-data-table  ← 新增 "个股数" 列 + "操作" 列
```

## 数据流

### 用户点击“操作”图标后的跳转流程

```text
用户点击某行 "操作" 图标
        │
        ▼
ASharesIndexThsPanel / ASharesIndexSwPanel
        │  emit("jump-to-members", { tsCode, name, category })
        ▼
ASharesIndexPanel
        │  emit("switch-to-stocks", { tsCode, name })
        ▼
ASharesTabsContainer
        │  subTab = "stocks"
        │  nextTick(() => stocksPanelRef.applyIndexFilter(tsCode, name))
        ▼
ASharesPanel.applyIndexFilter(tsCode, name)
        │  indexFilter = { tsCode, name }
        │  queryBody.indexTsCode = tsCode
        ▼
ASharesFilters
        │  显示 "所属指数: name" tag
        ▼
触发查询  indexTsCode = tsCode
```

### “个股数”数据流

```text
后端 IndexDailyService.getLatest()
        │  LEFT JOIN ths_index_catalog.count
        │  LEFT JOIN sw_index_catalog.member_count
        ▼
返回 IndexLatestRow.count
        ▼
前端 aSharesIndexColumns.ts 渲染
        count == null ? '-' : String(count)
```

## 接口与 SQL 改动

### 后端 `GET /api/indices/latest`

在 `IndexDailyService.getLatest()` 中新增 `count` 字段：

```ts
// 伪代码
LEFT JOIN ths_index_catalog ths ON ths.ts_code = q.ts_code
LEFT JOIN sw_index_catalog sw ON sw.ts_code = q.ts_code
SELECT ...,
  COALESCE(ths.count, sw.member_count) AS count  -- 大盘宽基两表均无匹配，返回 null
```

返回 DTO 新增 `count?: number | null`。

> 说明：`COALESCE` 对同花顺/申万返回实际数量，对大盘宽基返回 `null`，前端渲染为 `-`。

### 后端 A 股股票查询

`AShareQueryBody` 新增 `indexTsCode?: string`。

`a-shares-query.sql.ts` 中，当 `indexTsCode` 存在时，根据指数代码后缀决定 JOIN：

- 以 `.TI` 结尾 → JOIN `raw.ths_member_stocks` ON `con_code = raw.daily_quote.ts_code`
- 以 `.SI` 结尾 → 先去掉 `.SI` 后缀得到 `l3_code`（如 `000001.SI` → `000001`），再 JOIN `raw.index_member` ON `l3_code = ?` 且 `ts_code = raw.daily_quote.ts_code`，并叠加 PIT 条件 `in_date <= trade_date AND (out_date IS NULL OR out_date >= trade_date)`

> 说明：申万 `raw.index_member` 为 PIT 表，必须按 `trade_date` 过滤；同花顺 `raw.ths_member_stocks` 若为全量最新映射，则不需要 `trade_date` 过滤。

### 前端列定义

`aSharesIndexColumns.ts` 新增：

```ts
{
  title: '个股数',
  key: 'count',
  width: 90,
  sorter: true,
  defaultVisible: true,
  render: (row) => row.count == null ? '-' : String(row.count),
},
{
  title: '操作',
  key: 'action',
  width: 90,
  fixed: 'right',
  defaultVisible: true,
  locked: true,
  render: (row) => h(
    NButton,
    {
      text: true,
      type: 'primary',
      onClick: () => emit('jump-to-members', row),
    },
    {
      icon: () => h(ListIcon),
      default: () => '成分股',
    },
  ),
}
```

### 子 tab 通信

```ts
// ASharesTabsContainer
const stocksPanelRef = ref<{ applyIndexFilter: (tsCode: string, name: string) => void } | null>(null)

function handleSwitchToStocks(payload: { tsCode: string; name: string }) {
  subTab.value = 'stocks'
  nextTick(() => {
    stocksPanelRef.value?.applyIndexFilter(payload.tsCode, payload.name)
  })
}
```

`ASharesPanel` 通过 `defineExpose` 暴露 `applyIndexFilter` 方法。

## 错误处理

| 场景 | 处理 |
|------|------|
| 后端 `count` 为 `null` | 前端渲染为 `-`；排序时 `null` 排最后 |
| 指数无成分股数据 | A 股股票列表查询返回空，显示“暂无数据”，用户可清除筛选 tag |
| 用户清除“所属指数” | `indexTsCode` 置空，恢复全量股票查询 |
| 后端暂不支持某指数类型 | 接口返回 400 并附带清晰 message；前端拦截，不切换子 tab |
| 跳转时股票子面板未挂载 | `nextTick` 后 ref 仍不存在则降级为临时 query 参数 `?indexTsCode=xxx`（极少发生）；`ASharesPanel` 在 `onMounted` 中读取 query 参数并调用 `applyIndexFilter`，随后清空 query |

## 测试计划

| 测试项 | 方式 | 优先级 |
|--------|------|--------|
| 后端 `GET /api/indices/latest` 返回 `count` | 单元测试 + 真机 API 抽查 | P0 |
| A 股股票查询 `indexTsCode` 过滤 | 单元测试（校验 SQL 参数）+ 真机抽查 | P0 |
| 前端列定义包含 `count` / `action` | 新增 `aSharesIndexColumns.spec.ts` | P0 |
| 子 tab 切换 + 筛选注入 | 真机 e2e | P1 |
| 清除指数筛选后恢复全量 | 手动验证 | P1 |

## 待验证点

1. **阻塞**：同花顺 `raw.ths_member_stocks` 是否为 PIT 表，决定 SQL 是否需要 `trade_date` 过滤。实现前必须查表结构与样本数据确认。
2. **阻塞**：申万指数代码（如 `801010.SI`）与 `raw.index_member.l3_code` 的存储格式是否一致（是否含 `.SI` 后缀），实现前必须确认。
3. **实现缺口**：`count` 列与 `action` 列需要在所有用户已有列偏好下默认可见。回退方案：前端 `useSymbolColumnPreferences` 首次加载时，把 `definitions` 中 `defaultVisible: true` 但用户偏好里缺失的 key 自动补回用户偏好列表（保持用户原有顺序，缺失列追加到末尾）。
4. 大盘宽基（如 `000001.SH`）的操作列仍可点击，点击后会因无成分股数据而显示“暂无数据”，这是预期行为。

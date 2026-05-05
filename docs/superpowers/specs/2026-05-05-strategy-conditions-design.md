# 买入策略筛选功能设计

## 概述

在现有的 A 股/加密货币筛选面板中，新增"策略条件"模块，支持用户定义买入策略条件组合，运行后标记符合条件的标的，用户可选择性筛选。

## 功能定位

- **标的范围**：A 股 + 加密货币
- **策略定义**：独立的条件组合（不依赖回测策略）
- **条件复杂度**：AND 组合
- **实现方式**：扩展现有筛选面板，在表格中新增"买入信号"字段

## 交互流程

1. 用户定义策略条件 → 保存为条件组
2. 点击"运行" → 后端计算所有标的的命中情况 → 返回结果
3. 表格新增列"买入信号"，显示每个标的的命中状态（命中的策略条件组名称标签）
4. **不自动筛选**，只是标记
5. 用户在筛选栏中勾选感兴趣的买点（可多选）
6. 点击"应用"才进行筛选

## 数据模型

### 新增表：`strategy_conditions`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| name | VARCHAR | 条件组名称（如"KDJ 超卖 + MA 多头"） |
| userId | UUID | 用户 ID |
| targetType | VARCHAR | 目标类型：'crypto' / 'a-share' |
| conditions | JSONB | 条件定义数组 |
| createdAt | TIMESTAMPTZ | 创建时间 |
| updatedAt | TIMESTAMPTZ | 更新时间 |

### conditions JSONB 结构

```json
[
  {
    "field": "kdj_j",           // 指标字段名
    "operator": "lt",           // 比较操作符
    "value": 20                 // 固定值比较
  },
  {
    "field": "ma5",
    "operator": "gt",
    "compareField": "ma30"      // 与另一指标比较
  },
  {
    "field": "macd_dif",
    "operator": "cross_above",  // 上穿
    "compareField": "macd_dea"
  }
]
```

### 操作符说明

| 操作符 | 说明 | 比较目标 |
|--------|------|----------|
| gt | 大于 | 固定值 / 另一指标 |
| gte | 大于等于 | 固定值 / 另一指标 |
| lt | 小于 | 固定值 / 另一指标 |
| lte | 小于等于 | 固定值 / 另一指标 |
| eq | 等于 | 固定值 / 另一指标 |
| neq | 不等于 | 固定值 / 另一指标 |
| cross_above | 上穿（昨天 < 目标，今天 > 目标） | 另一指标 |
| cross_below | 下穿（昨天 > 目标，今天 < 目标） | 另一指标 |

### 可用的 field 值

**A 股**（`a_share_daily_indicators` + `a_share_daily_metrics` + `a_share_daily_quotes`）：
- 技术指标：kdj_j, kdj_k, kdj_d, macd_dif, macd_dea, macd_hist, bbi, ma5, ma10, ma20, ma30, ma60, ma120, ma240, atr14, profit_loss_ratio
- 基本面：turnover_rate, volume_ratio, pe, pe_ttm, pb, total_mv, circ_mv
- 行情：close, open, high, low, volume, amount, pct_chg
- 砖形图：brick, brick_delta, brick_xg

**加密货币**（`klines`）：
- 技术指标：kdj_j, kdj_k, kdj_d, macd_dif, macd_dea, macd_hist, bbi, ma5, ma10, ma20, ma30, ma60, ma120, ma240, atr14, profit_loss_ratio
- 行情：close, open, high, low, volume, amount

## 前端组件

### 新增页面

**`StrategyConditionsView.vue`** — 策略条件管理页面
- 位置：`apps/web/src/views/`
- 路由：`/strategy-conditions`
- 侧边栏菜单：新增"策略条件"菜单项
- 功能：
  - 列表展示用户的所有策略条件组
  - 创建新策略条件组
  - 编辑现有策略条件组
  - 删除策略条件组
- UI：
  - 左侧：策略条件组列表（名称 + 目标类型 + 条件数量）
  - 右侧：条件编辑器（`StrategyConditionBuilder.vue`）

### 新增组件

1. **`StrategyConditionBuilder.vue`** — 策略条件构建器
   - 位置：`apps/web/src/components/strategy-conditions/`
   - 功能：可视化构建条件组合
   - UI：每行一个条件，包含：指标选择（下拉）+ 操作符选择（下拉）+ 比较目标（固定值输入 / 另一指标下拉）
   - 支持添加/删除条件行
   - 支持保存条件组名称

2. **`StrategyConditionPicker.vue`** — 策略条件组选择器
   - 位置：`apps/web/src/components/symbols/common/`
   - 功能：选择已保存的条件组（只读，不支持在此编辑）
   - UI：下拉选择 + "运行"按钮（带 loading）
   - 数据来源：从策略条件管理页面创建的条件组
   - Props：`targetType: 'crypto' | 'a-share'`（用于筛选对应类型的条件组）

### 修改现有组件

1. **`ASharesPanel.vue`** — A 股主面板
   - 新增：策略条件选择器（放在筛选条件区域）
   - 新增：表格列"买入信号"（显示命中状态）
   - 新增：运行状态 loading

2. **`CryptoSymbolsPanel.vue`** — 加密货币主面板
   - 新增：策略条件选择器（放在筛选条件区域）
   - 新增：表格列"买入信号"（显示命中状态）
   - 新增：运行状态 loading
   - 新增：筛选栏"买入信号"筛选项（下拉多选，选项为已运行过的策略条件组名称）

3. **`ASharesFilters.vue`** — A 股筛选条件
   - 新增：筛选栏"买入信号"筛选项（下拉多选，选项为已运行过的策略条件组名称）

4. **路由配置** — 新增 `/strategy-conditions` 路由

5. **侧边栏菜单** — 新增"策略条件"菜单项

### 表格列"买入信号"显示逻辑

- 未运行策略：显示 "-"
- 运行中：显示 loading 动画
- 运行后命中：显示命中的策略条件组名称标签（如 "KDJ 超卖"）
- 多个策略都命中：显示多个标签（如 "KDJ 超卖, MA 多头"）
- 运行后未命中：显示空

### 筛选栏"买入信号"筛选逻辑

- 下拉多选，选项为已运行过的策略条件组名称
- 用户勾选策略 → 点击"应用" → 只显示命中所选策略的标的
- 未勾选任何策略 → 不筛选，显示所有标的

## 后端服务

### 新增模块

`apps/server/src/strategy-conditions/`

```
strategy-conditions/
├── strategy-conditions.module.ts
├── strategy-conditions.controller.ts
├── strategy-conditions.service.ts
└── dto/
    ├── create-strategy-condition.dto.ts
    └── run-strategy-condition.dto.ts
```

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /strategy-conditions | 创建策略条件组 |
| GET | /strategy-conditions | 获取用户的策略条件组列表 |
| PUT | /strategy-conditions/:id | 更新策略条件组 |
| DELETE | /strategy-conditions/:id | 删除策略条件组 |
| POST | /strategy-conditions/:id/run | 运行策略条件，返回命中结果 |

### 运行策略条件的响应格式

```json
{
  "hits": [
    {
      "tsCode": "000001.SZ",
      "name": "平安银行",
      "matchedConditions": ["kdj_j < 20", "ma5 > ma30"]
    }
  ],
  "totalHits": 2,
  "totalScanned": 5000
}
```

### 运行结果存储

- **临时存储**：运行结果存储在前端状态中（Vuex/Pinia），不持久化到数据库
- **生命周期**：页面刷新后清除，需要重新运行
- **多策略支持**：前端维护一个 Map，key 为策略条件组 ID，value 为该策略的命中结果
- **表格标记**：表格"买入信号"列根据当前运行的所有策略结果，显示命中的策略名称标签

### SQL 生成示例

条件：KDJ_J < 20 AND MA5 > MA30

```sql
SELECT s.ts_code, s.name, i.kdj_j, i.ma5, i.ma30
FROM a_share_symbols s
JOIN a_share_daily_indicators i ON s.ts_code = i.ts_code
WHERE i.trade_date = (SELECT MAX(trade_date) FROM a_share_daily_indicators)
  AND i.kdj_j < 20
  AND i.ma5 > i.ma30
```

## 错误处理与边界情况

### 错误处理

1. **条件验证**
   - 前端：每个条件必须包含指标（field）和操作符（operator），比较目标根据操作符类型填写（固定值或另一指标）
   - 后端：条件格式验证，拒绝非法字段名或操作符

2. **运行失败**
   - 数据库查询超时：显示"查询超时，请减少条件范围"
   - 无数据：显示"暂无数据，请先同步行情数据"

3. **删除策略**
   - 删除前二次确认
   - 删除后，表格中对应标签自动移除

### 边界情况

1. **指标数据缺失**
   - 某些标的历史数据不足（如新股没有 MA240）
   - 处理：跳过该标的，不计入命中结果

2. **时序比较（cross_above/cross_below）**
   - 需要查询昨天的数据
   - 如果昨天无数据（如停牌），跳过该标的

3. **大量标的运行性能**
   - A 股 5000+ 标的，加密货币 2000+ 标的
   - 处理：SQL 查询优化，添加必要索引
   - 前端：显示进度或 loading 状态

4. **并发运行**
   - 用户可能同时运行多个策略
   - 处理：后端支持并发查询，前端分别显示结果

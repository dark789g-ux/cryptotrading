# 活跃市值（0AMV）功能设计

## 概述

在 Symbols 页面新增"活跃市值" TAB，以 K 线图形式展示 0AMV 指标。0AMV 是基于中证A股指数（930903.CSI）计算的活跃市值指标，用于衡量 A 股市场活跃度。

## 需求背景

- **数据源**：中证A股指数 930903.CSI（Tushare index_daily）
- **计算公式**：通达信风格 SMA 递推计算
- **核心参数**：OAMVN=10, OAMVK=0.87
- **展示方式**：K 线图（OHLC），显示 1 年数据（约 250 个交易日）
- **同步方式**：手动触发同步

## 数据模型

### 数据库表 `0amv_daily`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键，默认 gen_random_uuid() |
| trade_date | varchar(8) | 交易日期 YYYYMMDD，唯一索引 |
| open | decimal(12,2) | 0AMV 开盘价 |
| high | decimal(12,2) | 0AMV 最高价 |
| low | decimal(12,2) | 0AMV 最低价 |
| close | decimal(12,2) | 0AMV 收盘价 |
| created_at | timestamptz | 创建时间，默认 now() |

### 索引

- `IDX_0amv_daily_trade_date`：trade_date 唯一索引

## 后端设计

### 模块结构

```
apps/server/src/market-data/0amv/
├── 0amv.entity.ts          # TypeORM Entity
├── 0amv.service.ts         # 业务逻辑
├── 0amv.controller.ts      # API 控制器
└── 0amv.module.ts          # NestJS 模块
```

### Entity (0amv.entity.ts)

```typescript
@Entity('0amv_daily')
export class OamvDaily {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 8 })
  tradeDate: string

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  open: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  high: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  low: number

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  close: number

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
```

### Service (0amv.service.ts)

**方法：**

1. `sync0amv(): Promise<{ synced: number }>`
   - 从 Tushare 拉取 930903.CSI 最近 60 天日线数据
   - 调用 `calc0amv()` 计算 0AMV 指标
   - 使用 `repo.upsert()` 存入数据库（按 trade_date 去重）
   - 返回同步条数

2. `get0amvData(days?: number): Promise<OamvDaily[]>`
   - 查询最近 N 天数据（默认 250 天）
   - 按 trade_date 升序排序

**核心计算函数 `calc0amv()`：**

将 Python 的 `0amv_formula.py` 翻译为 TypeScript，包含：
- `tdSma()`: 通达信风格 SMA 递推
- `calc0amv()`: 0AMV 核心计算

### Controller (0amv.controller.ts)

**接口：**

1. `POST /0amv/sync`
   - 手动触发同步
   - 返回 `{ success: boolean, synced: number }`

2. `GET /0amv/data`
   - 查询参数：`days`（可选，默认 250）
   - 返回 0AMV 数组

## 前端设计

### SymbolsView.vue 修改

- 新增第三个 TAB "活跃市值"
- `activeTab` 类型扩展为 `'crypto' | 'aShares' | 'activeMarketValue'`
- 使用 `<keep-alive>` 缓存所有面板

### ActiveMarketValuePanel.vue

**组件结构：**

```vue
<template>
  <div class="active-mv-panel">
    <div class="panel-header">
      <h2 class="panel-title">活跃市值（0AMV）</h2>
      <n-button @click="sync0amv">同步数据</n-button>
    </div>
    <kline-chart :data="chartData" height="600px" />
  </div>
</template>
```

**数据转换：**

将 0AMV 数据映射到 `KlineChartBar` 接口：
- `open_time`: trade_date（格式化为 YYYY-MM-DD）
- `open/high/low/close`: 直接映射
- `volume`: 设为 0（0AMV 无成交量概念）
- 其他字段（MA、KDJ、MACD 等）设为 null

### API 调用

```typescript
// 获取 0AMV 数据
const { data } = await api.get('/0amv/data', { params: { days: 250 } })

// 同步数据
await api.post('/0amv/sync')
```

## 数据同步页面集成

在"数据同步"页面的同步项列表中添加：

```typescript
{
  key: '0amv',
  name: '活跃市值（0AMV）',
  description: '中证A股指数 930903.CSI 的活跃市值指标',
  syncFn: () => api.post('/0amv/sync'),
}
```

## 验收标准

1. Symbols 页面显示"活跃市值" TAB
2. 点击 TAB 展示 0AMV K 线图
3. K 线图显示 1 年数据（约 250 个交易日）
4. 数据同步页面可手动触发 0AMV 同步
5. 同步完成后 K 线图自动刷新

## 实现阶段

### 阶段 1：后端基础
- 创建 Entity 和数据库表
- 实现 Service 和 Controller
- 注册到 MarketDataModule

### 阶段 2：数据同步
- 在数据同步页面添加 0AMV 同步按钮
- 实现手动触发同步功能

### 阶段 3：前端展示
- 修改 SymbolsView.vue 添加新 TAB
- 创建 ActiveMarketValuePanel.vue
- 实现数据获取和 K 线图展示

## 参考文件

- 计算公式：`timing/0amv_calc/0amv_formula.py`
- 执行脚本：`timing/0amv_calc/run_0amv.py`
- K 线图组件：`apps/web/src/components/kline/KlineChart.vue`
- K 线图配置：`apps/web/src/composables/kline/klineChartOptions.ts`

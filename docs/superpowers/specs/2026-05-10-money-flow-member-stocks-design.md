# Money Flow 行业/板块成分股列表设计

日期: 2026-05-10

## 背景

当前 Money Flow 模块中，点击行业或板块表格的"详情"按钮，打开的 `FlowTrendModal` 只展示该行业/板块的净流入趋势图。用户希望同时看到该行业/板块包含哪些个股。

## 需求

- 在行业/板块详情 Modal 中新增"成分股"Tab，展示该行业/板块的成分股列表（股票代码 + 名称）
- 成分股映射数据在同步资金流数据时一并从 Tushare 拉取，存入本地 DB
- 行业（同花顺行业）和板块（概念板块）都支持

## 设计方案

### 1. 数据库：新表 `ths_member_stocks`

```sql
CREATE TABLE ths_member_stocks (
  id        SERIAL PRIMARY KEY,
  ts_code   VARCHAR(20) NOT NULL,   -- 行业/板块 THS 指数代码（如 881101.TI）
  con_code  VARCHAR(20) NOT NULL,   -- 成分股代码（如 000001.SZ）
  con_name  VARCHAR(50),            -- 成分股名称
  is_new    VARCHAR(2),             -- 是否最新成分（Y/N）
  UNIQUE (ts_code, con_code)
);

CREATE INDEX idx_ths_member_stocks_ts_code ON ths_member_stocks (ts_code);
```

- 不存 `weight`、`in_date`、`out_date`（当前需求仅需代码+名称）
- 同步策略：按 ts_code 批次 DELETE + INSERT，保持数据最新

### 2. 后端：同步逻辑

在 `MoneyFlowSyncService` 中新增 `syncMembers()` 方法：

1. 从 `money_flow_industries` 取 DISTINCT ts_code 列表（行业）
2. 从 `money_flow_sectors` 取 DISTINCT ts_code 列表（板块）
3. 合并去重后，对每个 ts_code 调用 Tushare `ths_member(ts_code=...)`
4. 将返回的成分股数据存入 `ths_member_stocks` 表

Tushare `ths_member` 接口信息：
- 入参：`ts_code`（必填）、`con_code`（可选）
- 输出：`ts_code`、`con_code`、`con_name`、`weight`、`in_date`、`out_date`、`is_new`
- 每次最多返回 6000 行，用户 7000 积分可调用

集成方式：在行业/板块资金流同步完成后自动触发成分股同步。用户点击"同步行业数据"或"同步板块数据"时，资金流数据写入完成后自动调用 `syncMembers()` 同步对应维度的成分股映射。新增独立端点 `POST /money-flow/sync/members` 也可单独触发全量成分股同步。

错误处理：单个 ts_code 调用 `ths_member` 失败时，`logger.warn` 记录并跳过，继续处理其余 ts_code，不中断整体同步流程。

### 3. 后端：查询 API

新增端点 `GET /money-flow/members`：

- 入参 DTO：`QueryMemberDto`（仅 `ts_code: string`，必填）
- 返回：`MoneyFlowMemberRow[]`，按 `con_code` 升序
- Entity：`ThsMemberStockEntity`（TypeORM 实体映射 `ths_member_stocks` 表）

### 4. 共享类型

在 `packages/shared-types/src/money-flow.ts` 新增：

```ts
export interface MoneyFlowMemberRow {
  tsCode: string
  conCode: string
  conName: string
  isNew: string | null
}
```

### 5. 前端：FlowTrendModal 改造

将现有 Modal 改为 Tab 切换布局：

- **Tab 1「趋势」**：保留现有的 `FlowTrendChart` + `FlowDateControl`（不变）
- **Tab 2「成分股」**：新增成分股列表表格
  - 列：序号、股票代码（con_code）、股票名称（con_name）
  - 按 con_code 升序排列
  - 点击 Tab 时才请求数据（懒加载）
  - 加载中显示 loading 状态

新增可选 prop `showMembersTab`（boolean），控制是否显示成分股 Tab：
- 行业/板块面板传 `true`
- 股票面板传 `false`

### 6. 前端 API

在 `moneyFlowApi` 中新增 `getMembers(params: { ts_code: string })` 方法。

## 涉及文件

| 文件 | 变更 |
|------|------|
| `apps/server/src/entities/money-flow/` | 新增 `ths-member-stock.entity.ts` |
| `apps/server/src/market-data/money-flow/money-flow-sync.service.ts` | 新增 `syncMembers()` 方法 |
| `apps/server/src/market-data/money-flow/money-flow-sync.controller.ts` | 新增 `POST /money-flow/sync/members` 端点 |
| `apps/server/src/market-data/money-flow/money-flow.service.ts` | 新增 `queryMembers()` 方法 |
| `apps/server/src/market-data/money-flow/money-flow.controller.ts` | 新增查询端点 |
| `apps/server/src/market-data/money-flow/money-flow.module.ts` | 注册新 Entity |
| `packages/shared-types/src/money-flow.ts` | 新增 `MoneyFlowMemberRow` 类型 |
| `apps/web/src/api/modules/moneyFlow.ts` | 新增 `getMembers()` 方法 |
| `apps/web/src/components/money-flow/FlowTrendModal.vue` | 改造为 Tab 布局，新增成分股列表 |

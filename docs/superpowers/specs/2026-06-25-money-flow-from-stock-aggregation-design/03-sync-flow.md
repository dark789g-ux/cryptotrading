# 03 同步流程

## 3.1 一键同步 Step 2 改造

当前 Step 2「资金流向」直接拉 4 个维度。改造后内部流程：

```text
Step 2: 资金流向
  │
  ├── 2.1 同步指数成分股版本（按需）
  │     └── IndexWeightSyncService.syncIfNeeded(dateRange)
  │         ├── 检查 dateRange 覆盖的月份是否已有 index_weight 版本
  │         ├── 缺失的月份调用 Tushare index_weight
  │         └── 生成/更新版本链（effective_date / expire_date）
  │
  ├── 2.2 同步个股资金流
  │     └── Tushare moneyflow_ths
  │         └── 写入 money_flow_stocks
  │
  └── 2.3 聚合计算
        ├── 申万行业资金流
        ├── 同花顺行业资金流
        ├── 同花顺概念/板块资金流
        ├── 宽基指数资金流
        └── 全市场大盘资金流
        └── 写入对应聚合表
```

## 3.2 新增 `IndexWeightSyncService`

位置：`apps/server/src/market-data/index-weight/index-weight-sync.service.ts`

核心方法：

```typescript
class IndexWeightSyncService {
  // 同步指定月份
  async syncForMonth(indexCode: string, yearMonth: string): Promise<IndexWeightSyncResult>;

  // 检查 dateRange 覆盖月份是否已同步，缺失则补
  async syncIfNeeded(range: { startDate: string; endDate: string }): Promise<IndexWeightSyncResult>;
}
```

### 版本生成逻辑

```typescript
async syncForMonth(indexCode: string, yearMonth: string) {
  const [year, month] = parseYearMonth(yearMonth);
  const startDate = `${year}${month}01`;
  const endDate = lastDayOfMonth(year, month);

  // 拉取该月 index_weight
  const rows = await tushareClient.query('index_weight', {
    index_code: indexCode,
    start_date: startDate,
    end_date: endDate,
  }, 'con_code,trade_date,weight');

  // 取该月最新一批
  const latestDate = max(rows.map(r => r.trade_date));
  const latestRows = rows.filter(r => r.trade_date === latestDate);
  const newSet = new Set(latestRows.map(r => r.con_code));

  // 查询当前有效版本
  const currentActive = await repo.find({
    where: { indexCode, expireDate: IsNull() }
  });
  const oldSet = new Set(currentActive.map(r => r.conCode));

  // 无变化则跳过
  if (setsEqual(newSet, oldSet)) {
    return { skipped: true, success: 0, errors: [] };
  }

  // 有变化：关闭旧版本，插入新版本
  await transaction(async manager => {
    await manager.update(IndexWeightEntity,
      { indexCode, expireDate: IsNull() },
      { expireDate: yesterday(latestDate) }
    );
    for (const row of latestRows) {
      await manager.insert(IndexWeightEntity, {
        indexCode,
        conCode: row.con_code,
        effectiveDate: latestDate,
        expireDate: null,
        weight: row.weight,
      });
    }
  });
}
```

### 辅助函数定义

上段伪代码中的辅助函数含义如下，实现时按项目既有工具函数封装：

| 函数 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `parseYearMonth(yearMonth: string)` | `"202506"` | `[2025, 6]` | 字符串解析为 `[year, month]` 元组 |
| `lastDayOfMonth(year: number, month: number)` | `2025, 6` | `"20250630"` | 返回指定月末的 `YYYYMMDD` |
| `yesterday(tradeDate: string)` | `"20250615"` | `"20250614"` | 返回交易日的上一个自然日 `YYYYMMDD` |
| `setsEqual(a: Set<string>, b: Set<string>)` | 两个 `Set` | `boolean` | 比较两个集合元素是否完全一致 |
| `tushareClient.query(api, params, fields)` | 接口名、参数、字段 | 行数组 | 复用现有 Tushare 调用封装，返回 `{ con_code, trade_date, weight }[]` |
| `max(dates: string[])` | `YYYYMMDD` 数组 | `YYYYMMDD` | 取字典序最大日期 |

> 注：`expireDate` 设为 `yesterday(latestDate)`，保证新版本 `effective_date` 起生效，旧版本在新版本生效前一天失效。

### 同步入口

1. **自动（主入口）**：在 `MoneyFlowSyncService.startSync()` 开始时调用 `IndexWeightSyncService.syncIfNeeded()`。
2. **手动**：新增 `GET /index-weight/sync/run` SSE 接口，供管理员手动触发。
3. **历史回填**：手动接口支持 `yearMonth` 参数，如 `?yearMonth=202505`。

## 3.3 `MoneyFlowSyncService.startSync()` 改造

```typescript
async startSync(dto: SyncFlowDto): Promise<Subject<MoneyFlowSyncEvent>> {
  // ... SSE 初始化 ...

  setTimeout(async () => {
    try {
      // 新增：按需同步 index_weight
      await this.indexWeightSyncService.syncIfNeeded({
        startDate: dto.start_date,
        endDate: dto.end_date,
      });

      // 同步个股资金流
      const stockResult = await this.syncStocks(dto, ctx);

      // 新增：聚合到各维度
      await this.aggregateAllDimensions(dto, ctx);

      // 完成事件
    } catch (err) {
      // 错误事件
    }
  }, 0);
}
```

## 3.4 同步顺序说明

`index_weight` 必须在个股同步之前完成，原因：

- 聚合步骤需要成分股列表。
- 如果先同步个股、后同步 `index_weight`，本次同步区间内的资金流会用旧版本聚合，且不会自动重算。

## 3.5 增量/覆盖模式

| 模式 | 行为 |
|---|---|
| `incremental` | 只同步缺失日期；聚合只重算该日期；`index_weight` 按需补当月 |
| `overwrite` | 重拉指定区间个股资金流；重算区间全部聚合；`index_weight` 按需补 |

对于 `index_weight`，即使 `overwrite` 也不应盲目全量重拉所有历史月份，只补 `dateRange` 覆盖月份。

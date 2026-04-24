# 规范：TypeORM QueryBuilder 与原生 SQL 片段（问题 2：K 线日志 500）

## BUG 案例

**发生时间**：2026-04-19  
**现象**：`GET /api/backtest/runs/:runId/candle-log?onlyWithAction=true` 返回 **500**，前端仅见 `Internal server error`。

**服务端日志（节选）**：
```
TypeError: Cannot read properties of undefined (reading 'databaseName')
    at SelectQueryBuilder.createOrderByCombinedWithSelectExpression (...SelectQueryBuilder.ts:3748:41)
    at SelectQueryBuilder.getManyAndCount
    at CandleLogController.getPage (candle-log.controller.ts)
```

**根因（两层）**：

1. **PostgreSQL 类型写法与 TypeORM 占位符冲突**  
   在 `andWhere(\`...\`)` 中书写 **`'[]'::jsonb`** 时，TypeORM 会把 **`::jsonb`** 误解析为命名参数 **`:jsonb`**，运行时未绑定或 SQL 非法，易触发异常。

2. **自连接 + `getManyAndCount` + `orderBy` 与 TypeORM 0.3 不兼容**  
   对同一张表（如 `backtest_candle_logs`）再 `leftJoin` 出第二个别名（如 `prev`）后，在 **`getManyAndCount`** 合并排序表达式时，TypeORM 会为多余 join 别名解析 metadata，得到 **`undefined`**，再访问 **`databaseName`** 即抛错（与 join 使用 `Entity` 还是表名字符串无关）。

**已采用修复**：

- 空 JSON 字面量统一写 **`CAST('[]' AS jsonb)`**，避免在条件字符串中出现 **`::jsonb`**。
- 上一根 K 线数据改为 **关联标量子查询**（`SELECT ... FROM backtest_candle_logs prev WHERE ...`），**不再**对 `prev` 做 `leftJoin`，主查询仅保留主实体别名（如 `cl`）。

---

## 规范

### 1. QueryBuilder 条件字符串中禁止直接使用 `'x'::type` 形式

| 禁止 | 推荐 |
|------|------|
| `'[]'::jsonb`、`'{}'::jsonb` | `CAST('[]' AS jsonb)`、`CAST('{}' AS jsonb)` |
| 其他 `expr::timestamptz` 等（在整段传给 `andWhere`/`where` 的模板字符串内） | 优先 **`CAST(expr AS timestamptz)`**，或改用 **参数绑定** + 在应用层构造类型 |

**原因**：TypeORM 对条件中的 **`:`** 做占位符扫描，**`::`** 可能被拆成误绑定的 **`:jsonb`** 等。

### 2. 慎用「同表自连接 + `getManyAndCount`」

若业务必须在「仅主表一行实体」的前提下关联同表上一行 / 下一行：

| 做法 | 说明 |
|------|------|
| **优先** | **`EXISTS` / 标量子查询** 引用外层别名，不增加 QueryBuilder 的 join 元数据 |
| **避免** | `leftJoin(同一 Entity 或同表名, 'alias2', ...)` 后再 **`getManyAndCount`** + **`orderBy`** |

若必须用多表 join 且要分页总数，可评估：**拆成两次查询**（先 `COUNT` 子查询，再 `getMany`），或 **`DataSource.query` 手写 SQL**，避免踩 TypeORM 0.3 在 `createOrderByCombinedWithSelectExpression` 上的已知路径。

### 3. 复杂条件优先可测性

对含 `jsonb`、`IS DISTINCT FROM`、子查询的接口，本地改动后在 `apps/server` 执行：

```bash
pnpm exec tsc --noEmit
```

并对触发分支（如 `onlyWithAction=true`）做一次 **实际 HTTP 请求** 验证，不依赖「仅无报错启动」。

### 4. 与 candle-log 实现保持一致

`onlyWithAction` 类条件若再次调整，须同时满足：

- 条件字符串内 **不出现** 易被 TypeORM 误解析的 **`::类型`** 片段（见 §1）。
- **不引入** 非必要的同表 **`leftJoin`** 与 **`getManyAndCount`** 组合（见 §2）。

---

## 参考实现位置

- `apps/server/src/backtest/candle-log.controller.ts`：`onlyWithAction` 子查询写法、`CAST('[]' AS jsonb)`。

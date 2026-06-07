# 03 · 数据模型与 migration

[← 返回 index](./index.md)

三张新表，范式参考 `entities/strategy/strategy-condition-{,run-,hit-}entity.ts`。**与现有 `strategy_condition_*` 的差别**：run 保留历史多次（不 delete 重写），trade 表带完整时间维度。

## 3.1 表结构（ER）

```text
signal_test (方案配置, 长期保留)
├─ id uuid PK
├─ name varchar(100)
├─ buy_conditions  jsonb        -- StrategyConditionItem[]
├─ exit_mode       varchar(16)  -- 'fixed_n' | 'strategy'
├─ horizon_n       int  NULL    -- fixed_n 模式持有天数 (exit_mode='fixed_n' 时非空)
├─ exit_conditions jsonb NULL   -- strategy 模式卖出条件 StrategyConditionItem[]
├─ max_hold        int  NULL    -- strategy 模式兜底天数 (exit_mode='strategy' 时非空)
├─ universe        jsonb        -- {type:'all'|'list', tsCodes?: string[]}
├─ date_start      varchar(8)   -- YYYYMMDD
├─ date_end        varchar(8)
├─ created_at / updated_at timestamptz
        │ 1:N (CASCADE)
        ▼
signal_test_run (每次运行聚合统计, 留历史可对比)
├─ id uuid PK
├─ test_id uuid FK → signal_test.id (ON DELETE CASCADE)
├─ status            varchar(16)  -- 'running'|'completed'|'failed'
├─ progress_scanned  int default 0   -- 已处理交易日数
├─ progress_total    int default 0   -- 总交易日数
├─ error_message     text NULL
├─ sample_count      int  NULL       -- 有效样本数 N
├─ win_rate          numeric NULL    -- p, 0~1
├─ avg_win           numeric NULL
├─ avg_loss          numeric NULL
├─ payoff_ratio      numeric NULL    -- 赔率 b
├─ profit_factor     numeric NULL    -- null=无亏损样本
├─ kelly_f           numeric NULL    -- 凯利 f*, null=无法计算
├─ avg_hold_days     numeric NULL
├─ worst_trade_ret   numeric NULL    -- 最差单笔 ret (替代最大回撤)
├─ filtered_count    int default 0   -- 被入场过滤剔除的信号数 (可观测)
├─ created_at / completed_at timestamptz
        │ 1:N (CASCADE)
        ▼
signal_test_trade (逐笔触发明细, 供抽查手算核对)
├─ id uuid PK
├─ run_id uuid FK → signal_test_run.id (ON DELETE CASCADE)
├─ ts_code      varchar(30)
├─ signal_date  varchar(8)
├─ buy_date     varchar(8)
├─ exit_date    varchar(8)
├─ buy_price    numeric
├─ exit_price   numeric
├─ ret          numeric       -- exit_price/buy_price - 1
├─ hold_days    int
├─ exit_reason  varchar(16)   -- 'max_hold'|'signal'|'delist'
```

索引：
- `signal_test_run(test_id, created_at DESC)` — 历史运行列表。
- `signal_test_trade(run_id)` — 明细分页。
- `signal_test_trade(run_id, signal_date)` — 抽查定位。

## 3.2 TypeORM 实体

新建 `apps/server/src/entities/strategy/signal-test.entity.ts`、`signal-test-run.entity.ts`、`signal-test-trade.entity.ts`（与现有 strategy 实体同目录）。命名约定对齐现有实体：属性 camelCase，`@Column({ name: 'snake_case' })` 显式映射。

`universe`、`buy_conditions`、`exit_conditions` 用 `@Column({ type: 'jsonb' })`，TS 类型复用 `StrategyConditionItem`（`entities/strategy/strategy-condition.entity.ts:14-19`）。新增 `SignalTestUniverse` 接口：

```typescript
export interface SignalTestUniverse {
  type: 'all' | 'list';
  tsCodes?: string[];
}
```

## 3.3 双注册（必须，否则运行时 EntityMetadataNotFound 500）

参考记忆 `project_typeorm_entity_dual_registration`：三个实体须**同时**：
1. 在 `signal-stats` 所属 module 的 `TypeOrmModule.forFeature([...])` 注册（现有 `strategy-conditions.module.ts:12-16` 已注册 3 个，追加这 3 个）。
2. 在 `app.module.ts` 根 `entities` 数组追加这 3 个。

漏第 2 步会编译绿但运行时 500。实现后须**重启后端**（`nest start` 无 watch）。

## 3.4 Migration

新建 `apps/server/migrations/NNNN-create-signal-test-tables.sql` + 同名 `.ps1`（范式见现有 `migrations/*.sql` + `.ps1`，`.ps1` 内置 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -f ...` 或 `-c`）。

SQL 要点：
- `CREATE TABLE IF NOT EXISTS`，三张表 + 上述索引 + 外键 `ON DELETE CASCADE`。
- `id` 用 `uuid DEFAULT gen_random_uuid()`（对齐现有实体 uuid 主键）。
- 字段名严格 snake_case，与实体 `@Column({ name })` 对齐。
- 文件 UTF-8，无 BOM；SQL 内注释用英文（PowerShell GBK 终端安全）。

migration 须可重复执行（IF NOT EXISTS），并在 PR 随附 `docker exec` 可执行脚本。

[← index](./index.md) ｜ [下一篇：04 API 与前端 →](./04-api-and-frontend.md)

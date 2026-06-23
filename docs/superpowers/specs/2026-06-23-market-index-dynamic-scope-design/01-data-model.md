# 01 · 数据模型（零 migration）

## 1.1 核心洞察：复用 `ths_index_catalog` `type='M'`

大盘范围**不新建表**、**不加字段**、**不改 migration**。直接用现有 `ths_index_catalog` 的 `type='M'` 行作为范围真源。

**现有表**（`apps/server/src/migration/2026-05-11-ths-index-catalog.sql:1-11` + 实体 `apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts:5-33`）：

```text
ths_index_catalog:
  ts_code VARCHAR(20) PK | name VARCHAR(100) | count INTEGER
  exchange VARCHAR(8) | list_date VARCHAR(8) | type VARCHAR(4)  -- 'I'|'N'|'M'
  created_at | updated_at
```

- `type` 列 **无 DB CHECK**（实体 `:23` 注释明说），TS 联合 `'I'|'N'|'M'` 仅代码层约束
- `type='M'` 行（大盘）当前由 migration 硬塞 8 行（`20260622120000-create-unified-index-daily.sql:9-23`）

## 1.2 安全论证：type='M' 为何不受 catalog 同步影响

两条独立路径，均已核 `index-catalog-sync.service.ts`：

1. **`syncCatalog` 只对 `type IN ('I','N')` 调用**（`:35-67`，type 仅 'I'|'N'，batchUpsert 覆盖该 type 行）—— `type='M'` 从不进 syncCatalog，故 M 行不会被 batchUpsert 覆盖。
2. **`cleanupOrphans`（`:150-170`）按 `member.ts_code NOT IN (SELECT ts_code FROM ths_index_catalog 全表)` 删孤儿成分股，不区分 type**。但 `ThsMemberStockEntity` 的 tsCode 只会是行业/概念指数（`ths_member` 接口仅返回 I/N 指数成分），**大盘 tsCode 从不作为 ths_member 的 ts_code**，故大盘 type='M' 行的增删不影响 member 清理。

> ⚠️ 维护提醒：在 `cleanupOrphans` 旁加注释「type='M' 由 market-index-scope 管理，ths_member 不含大盘成分」。**未来若 syncCatalog 扩到 M 或 ths_member 逻辑变更，须重新评估此安全论证**（现状安全 ≠ 永久安全）。

## 1.3 范围语义

- `type='M'` 行**存在** = 在大盘拉取范围内
- 管理页面「加入范围」= `upsert` catalog `type='M'` 行
- 管理页面「移除」= `delete` catalog `type='M'` 行
- 不需要 `enabled` 字段（存在即启用）

## 1.4 单一数据源（避免双写漂移）

```text
  ths_index_catalog (type='M')  ← 唯一真源
       │
       ├──▶ MarketIndexSyncService 读全部 type='M' tsCode（同步清单）
       └──▶ 前端大盘 Tab 读 type='M'（目录展示）
```

不引入 `market_index_scope` 新表、不给 catalog 加 `enabled/source`，避免"范围表 + catalog"双写漂移。

## 1.5 初始数据

现有 migration 硬塞的 8 行（000001.SH 上证指数 / 399001.SZ 深证成指 / 399006.SZ 创业板指 / 000688.SH 科创50 / 000300.SH 沪深300 / 000016.SH 上证50 / 000905.SH 中证500 / 000852.SH 中证1000）作为**初始范围**保留。用户可在管理页面增删。

## 1.6 候选信息不持久化

「发现候选」的 `noise_tag`（退市/跨境/收益版/重复）是 `index_basic` 即时计算结果，**不落库**——每次点「发现候选」即时拉 `index_basic` + 即时算标签展示。范围（`type='M'`）才持久化。

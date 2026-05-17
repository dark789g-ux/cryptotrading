# M0 · 数据迁移与 schema 底座（1-1.5 周）

> 本里程碑文档是 [00-index.md](00-index.md) 的子文档。
> **实施 agent 必读**：[01-pg-schema.md](01-pg-schema.md)、[02-quant-pipeline.md](02-quant-pipeline.md)、[04-error-quality-testing.md](04-error-quality-testing.md)、[05-risks.md](05-risks.md)。

## 目标

把 A 股表迁进 `raw`，建出 `factors / ml` 空壳，所有上下游可以基于新 schema 工作。

## 交付物

1. **手写 SQL migration**（含 docker exec 脚本 + 反向脚本）覆盖 [01-pg-schema.md](01-pg-schema.md) §6 全部 6 步正向序列 + 2 步回滚序列；git tag `quant-migration-base`
2. **NestJS 既有 a-share entity 全部改指向 `raw.*` 并去 `a_share_` 前缀**；构建 & 单测通过
3. `quant-pipeline/` uv 项目骨架：`pyproject.toml` + 空 `cli.py` + `db.engine` 能连上 PG（依赖清单见 [02-quant-pipeline.md](02-quant-pipeline.md) §2）
4. `factors / ml` schema 下各表的 Alembic 初始 migration（空表 + 索引）—— **不含** Optuna 自建表（M4 由 Optuna 库自行创建，见 [05-risks.md](05-risks.md) §9）
5. `ml.jobs` 表 + 最小 worker（`run_type='noop'` 能拿行并回写 `status='success'`）

## 验收门槛

- `pnpm --filter @cryptotrading/server build` 通过；既有 A 股同步任务一次跑完无报错
- `uv run quant worker run` 启动；插入 `ml.jobs(run_type='noop')` 一行能被消费、`status` 变 `success`、`finished_at` 写入
- 回滚脚本在测试库上验证通过（手测：执行"DB 反向 + git checkout `quant-migration-base` + 重新部署"两步后 NestJS 重新跑通既有同步）
- [01-pg-schema.md](01-pg-schema.md) §6 中的"6 步发布序列 + 2 步回滚序列"作为 M0 README 一节落盘
- `raw / factors / ml` 三 schema 在生产 PG 上存在；现有 5 张 a_share_* 表全部位于 `raw` 且去前缀；`public.a_share_*` 已不存在

## 任务拆解（建议交付顺序）

| # | 任务 | 文件域 | 估时 |
|---|---|---|---|
| 1 | 创建 `raw / factors / ml` 三 schema 的 docker exec 脚本 | `docker/` 或新增 `scripts/` | 0.5 天 |
| 2 | 手写正向 SQL（5 张表 SET SCHEMA + RENAME） | `apps/server/migrations/` | 1 天 |
| 3 | 手写反向 SQL + 测试库演练 | 同上 | 0.5 天 |
| 4 | NestJS entity 全改（指向 raw + 去前缀）+ 跑通既有同步 | `apps/server/src/entities/a-share/` 及引用方 | 1.5 天 |
| 5 | 初始化 `quant-pipeline/` uv 骨架 + 连 PG | 新增根目录 `quant-pipeline/` | 1 天 |
| 6 | `factors / ml` Alembic 初始 migration | `quant-pipeline/src/quant_pipeline/db/migrations/` | 1 天 |
| 7 | 最小 worker（poller + dispatcher 空 dispatch） | `quant-pipeline/src/quant_pipeline/worker/` | 1 天 |
| 8 | M0 README（发布/回滚序列说明书）+ 集成测试库 docker-compose | `quant-pipeline/README.md`、`docker-compose.test.yml` | 0.5 天 |

## 与其它里程碑的依赖关系

- M1 / M2 / M3 / M4 **全部依赖** M0 验收通过
- M0 不依赖任何前置（除已有 NestJS A 股同步可跑）

## 风险与注意事项

- ⚠️ NestJS entity 改名涉及面较广（service / repo / controller / migration 的字符串引用），改完务必跑一次全量 lint + 类型检查
- ⚠️ 部署窗口期内既有 NestJS 同步若被定时调度触发会失败，需提前停同步任务
- ⚠️ `ALTER SCHEMA / SET SCHEMA / RENAME TABLE` 在 PG 中是元数据级操作（不复制数据），但仍需短暂锁表；选择业务低峰期执行

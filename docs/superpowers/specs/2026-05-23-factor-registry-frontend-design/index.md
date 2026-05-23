# 因子清单前端化与运维改造（factor-registry-frontend）

- **日期**: 2026-05-23
- **范围**: 全栈（quant-pipeline / NestJS / Vue）
- **目标读者**: 后续承接此 spec 派发并行 agent 的开发者

## 摘要

当前 16 个因子由 `apps/quant-pipeline/src/quant_pipeline/factors/registry.py` 的 `@register` 装饰器硬编码注册，元信息（描述/类别/PIT 窗口/锚点）仅存在于 Python 类属性中，DB 无 `factor_definitions` 表。本设计将元信息迁至 DB 作为**单一权威**，新增 `/quant/factors` 前端页面供 admin 查看并编辑描述、启停因子、调整 PIT 窗口等；并将整个 `/quant/*` 路由树改为 admin-only（基于既有 `users.role === 'admin'`）。

启停或修改元数据**仅在下一次 train_e2e job 启动时生效**（worker 启动期 `registry.reload_from_db()`）；已 pending 的 job 不受影响。`compute` 计算逻辑仍只在代码里维护。

## 目标与非目标

**目标**

1. 新增 `/quant/factors` 页面，列出全部因子元信息（id / 中文描述 / 类别 / PIT 窗口 / 启停状态 / 公式 / 数据源）
2. admin 可在前端编辑：description、category、pit_window_days、pit_anchor、enabled、display_order
3. 启停一个因子 → 下一次 train_e2e job 启动时生效，跳过该因子并产生新 feature_set
4. 整个 `/quant/*` 路由树改为 admin-only

**非目标（YAGNI）**

- 在前端新建 / 删除因子（必须有 Python `compute` 类，走代码 PR）
- 编辑因子计算逻辑 / 让 `formula` 字段可执行
- 因子编辑审计历史表（用行内 `updated_at/by` 替代）
- 角色管理后台 UI（admin 通过 SQL 设置 `users.role`）
- 完整 RBAC（roles + permissions 三张表；现仅复用既有 `users.role` 单字段）
- 批量编辑、导出 CSV
- 在已 pending 的 job 上动态生效新元数据

## 架构总览（方案 A：DB 单一权威）

```text
┌──────────────────────────────────────────────────────────┐
│ factors.factor_definitions（新表，DB 单一权威）          │
│   factor_id PK / factor_version PK / description /       │
│   formula / data_source / category /                     │
│   pit_window_days / pit_anchor / enabled /               │
│   display_order / updated_at / updated_by                │
└────────────┬─────────────────────────────┬───────────────┘
             │                             │
             ▼                             ▼
   ┌─────────────────┐         ┌──────────────────────┐
   │ NestJS quant    │         │ quant-pipeline       │
   │ FactorsService  │         │ registry.py          │
   │ CRUD + List API │         │ 启动加载 → 缓存      │
   └─────────────────┘         │ Factor.__init__ 读   │
             │                 └──────────────────────┘
             ▼
   ┌─────────────────┐
   │ /quant/factors  │  前端列表 + 行内编辑 + 启停 switch
   │ Vue 视图        │
   └─────────────────┘
```

- Python 因子类**只保留 `compute` 方法**，类属性 `description / category / pit_window_days / pit_anchor` 全部删除
- 每个 train_e2e job 启动期 `registry.reload_from_db()` 拉一次全表进进程内缓存；job 结束缓存随进程释放
- NestJS 不做应用层缓存（读量小、写后要立即反映）

## 子文档清单与阅读顺序

| 文档 | 主题 | 建议读它如果你… |
|------|------|----------------|
| [01-db-schema.md](./01-db-schema.md) | `factor_definitions` 表结构 + 初始 migration | 准备写 Alembic migration |
| [02-pipeline-refactor.md](./02-pipeline-refactor.md) | quant-pipeline registry / base / 16 个因子文件改造 | 准备改 Python 侧 |
| [03-backend.md](./03-backend.md) | NestJS AdminGuard + factors module + endpoints + DTO | 准备改 NestJS |
| [04-frontend.md](./04-frontend.md) | 路由 / 页面布局 / 编辑弹窗 / 组件拆分 / API 客户端 | 准备写 Vue |
| [05-data-flow.md](./05-data-flow.md) | 数据流图 / 缓存失效策略 / 并发 / 回滚 | 想理解端到端流程或排错 |
| [06-testing.md](./06-testing.md) | quant-pipeline / NestJS / Vue 测试矩阵 | 写测试用例 |
| [07-rollout.md](./07-rollout.md) | 5 步上线序列 + 并行 agent 任务拆分建议 | 准备派发实现任务 |

**推荐阅读顺序**：`index.md → 01 → 02 → 03 → 04 → 05 → 06 → 07`。

**跨文档引用约定**：相对路径 + 锚点，如 `./03-backend.md#endpoints`。

## 关键决策摘要（贯穿全文）

- **DB 单一权威**：因子元信息从 Python 类属性迁至 `factors.factor_definitions`，代码删除类属性，运行时从 DB 加载
- **fail-fast**：DB 缺对应行 → worker 启动 `raise FactorMetaMissing`，禁止静默跳过
- **缓存粒度**：每个 train_e2e job 启动时 reload，job 进程结束随之释放；不做长驻进程级缓存
- **admin 机制**：复用既有 `users.role`（CHECK 约束 `role IN ('admin','user')`，列与 `idx_users_role` 早已存在）；新增 `AdminGuard` 直接读 `req.user.role === 'admin'`。spec 初稿基于「无角色系统」前提引入 `ADMIN_USER_IDS` env 白名单方案，落地阶段发现 role 字段早就存在 + 已有 admin 用户，已重构为读 DB role（refactor 2026-05-23）
- **量化模块整体收口**：`/quant/*` 全部 6 个 controller + 前端路由都加 admin 守卫
- **formula / data_source 只读**：前端表单不暴露编辑入口，避免代码与文档脱节
- **启停作用范围**：仅影响"端到端训练"重算 feature_set 时的因子集合；已物化的 feature_matrix 数据不受影响
- **初始 migration 用方案 a**：硬编码 INSERT 16 行默认值，不在 migration 中 import quant_pipeline 包

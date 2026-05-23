# 07 · 上线步骤与并行任务拆分

← 回到 [index.md](./index.md)

## 上线步骤

```text
步骤 1: DB schema migration（Alembic, quant-pipeline）
  apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/
    20260524_0001_factor_definitions.py
    - CREATE TABLE factors.factor_definitions (...)
    - INSERT 16 行硬编码默认值
  → 详见 01-db-schema.md

步骤 2: quant-pipeline 代码 refactor
  - factors/base.py、registry.py 改造
  - 16 个因子文件删类属性
  - worker/train_e2e_runner.py 调 reload_from_db
  - features/runner.py:_load_factor_ids 用 list_active 取交集
  - pytest 全绿
  → 详见 02-pipeline-refactor.md、06-testing.md §1

步骤 3: NestJS 后端
  - apps/server/migrations/ 加 SQL 镜像迁移 + .ps1
    （CLAUDE.md 硬约束：DB schema 调整须附 docker exec 脚本）
  - auth/admin.guard.ts
  - users.service.getMe 注入 is_admin
  - modules/quant/factors/ 新模块
  - 6 个 quant controller @UseGuards(AdminGuard)
    (jobs / jobs-sse / quality / runs / scores + 新增 factors)
  - SSE token 端点单独加守卫（详见 03-backend.md SSE 守卫节）
  - jest 全绿
  → 详见 03-backend.md、06-testing.md §2

步骤 4: 前端
  - api/modules/quant.ts 加 3 函数 + 类型
  - router 加 quant-factors 路由 + 全 /quant/* requireAdmin meta
  - beforeEach 守卫 + 顶部菜单 v-if isAdmin
  - stores/user.ts 暴露 isAdmin
  - 3 个组件文件
  - vitest 全绿 + lint:quant-lines 通过
  → 详见 04-frontend.md、06-testing.md §3

步骤 5: 部署前手动检查
  - 确认生产 DB 至少有一个 role='admin' 用户：
      docker exec crypto-postgres psql -U cryptouser -d cryptodb \
        -c "SELECT id, email FROM users WHERE role='admin';"
    若缺则手动 UPDATE 一个用户为 admin
  - docker exec crypto-postgres psql 验证表存在
  - pnpm build 全绿
  - 端到端手动用例（详见 06-testing.md §4）
```

## 顺序约束

- **步骤 1 必须先于步骤 2**：base.py 删类属性后，代码实例化因子会立即从 `_meta_cache` 读；如果 DB 还没数据，所有 quant-pipeline 进程启动会 fail-fast。
- **步骤 2 与步骤 3 可并行**——两端的代码独立，DB schema 通过 migration 文件共享契约，列名约定提前在本 spec 固化。
- **步骤 4 可在步骤 3 给出 mock API 类型后并行**。
- **步骤 5 在 2/3/4 全部完成后**才能执行。

## 并行 Agent 任务拆分建议

按"互不相交的文件域"切分，避免 worktree（CLAUDE.md / brainstorming skill 硬约束：派发 agent 时禁用 `isolation: "worktree"`）：

```text
Agent A: quant-pipeline refactor
  独占目录:
    apps/quant-pipeline/src/quant_pipeline/factors/
    apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py
    apps/quant-pipeline/src/quant_pipeline/features/runner.py
    apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/
    apps/quant-pipeline/tests/unit/factors/
    apps/quant-pipeline/tests/unit/worker/

Agent B: NestJS backend
  独占目录:
    apps/server/src/modules/quant/factors/
    apps/server/src/auth/admin.guard.ts
    apps/server/src/auth/__tests__/admin.guard.spec.ts
    apps/server/src/entities/ml/factor-definition.entity.ts
    apps/server/migrations/20260524_factor_definitions.sql
    apps/server/migrations/20260524_factor_definitions.ps1
    .env.example (追加)
  共享触点 (需协调):
    apps/server/src/users/users.service.ts (追加 is_admin 字段)
    apps/server/src/modules/quant/*/(*.controller.ts) ×5 (加 @UseGuards)

Agent C: Frontend
  独占目录:
    apps/web/src/views/quant/QuantFactorsView.vue (新)
    apps/web/src/views/quant/__tests__/QuantFactorsView.spec.ts (新)
    apps/web/src/components/quant/FactorTable.vue (新)
    apps/web/src/components/quant/FactorEditModal.vue (新)
    apps/web/src/components/quant/__tests__/Factor*.spec.ts (新)
  共享触点 (需协调):
    apps/web/src/api/modules/quant.ts (追加 3 函数 + 类型)
    apps/web/src/router/index.ts (加路由 + meta + beforeEach)
    apps/web/src/stores/user.ts (暴露 isAdmin)
```

**冲突管理**：

- "共享触点"文件由各自 Agent 在最后 commit 时单独 push，由主 Agent 协调 merge
- 避免在同一文件多处修改时跨 Agent 重叠（如都改 quant.ts 不同段）
- 集成测试由主 Agent 在三者完成后跑端到端

## 完成判定

每个 Agent 完成时必须：

1. 自己范围的单测全绿
2. lint / type-check 通过
3. 触发触点（如有）已与其他 Agent 对齐列名 / 类型签名
4. 在 PR 描述附"我改了哪些共享触点 + 改了什么"以便主 Agent 合流

主 Agent 收尾：

1. 跑端到端手动校验清单（[06-testing.md §4](./06-testing.md#4-端到端手动校验)）
2. 验证 5 个 quant 子模块的 AdminGuard 都生效
3. 验证生产 DB 至少有一个 `role='admin'` 用户（见上面步骤 5 SQL）
4. commit 收口 + 写 release note

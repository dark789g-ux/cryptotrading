# 03 · NestJS 后端

← 回到 [index.md](./index.md)

## AdminGuard

新增文件：`apps/server/src/auth/admin.guard.ts`

**行为**（refactor 2026-05-23：由 env 白名单改为 DB `users.role`）：

- `canActivate(ctx)`：取 `ctx.switchToHttp().getRequest().user.role`；`=== 'admin'` 放行，否则 `ForbiddenException`
- 不再解析任何环境变量；admin 名单是 DB 单一权威，加/调 admin 走 SQL：
  `UPDATE users SET role='admin' WHERE id='<uuid>'`（无需重启 server）
- DB 已有 `users.role` 列（CHECK `role IN ('admin','user')`）与 `idx_users_role` 索引，复用即可，不引入 roles 表
- 共享判定函数 `isAdminUser(user)` 供 `auth.service.me()` 等非守卫场景使用

**与全局 AuthGuard 的关系**：

- AuthGuard 已通过 `APP_GUARD` 注册为全局守卫（CLAUDE.md 硬约束），**不要**在 controller 上再加 `@UseGuards(AuthGuard)`
- AdminGuard 是新增的**局部**守卫，可用 `@UseGuards(AdminGuard)` 加在 controller 类或方法上，与全局 AuthGuard 自然串联

**应用范围**：`/api/quant/*` 全部 6 个 controller（5 个现有 + 1 个新增）

```text
现有（位置：apps/server/src/modules/quant/controllers/）:
  QuantJobsController        @UseGuards(AdminGuard)
  QuantJobsSseController     @UseGuards(AdminGuard)  ← 见下节 SSE 守卫
  QuantScoresController      @UseGuards(AdminGuard)
  QuantRunsController        @UseGuards(AdminGuard)
  QuantQualityController     @UseGuards(AdminGuard)
新增:
  QuantFactorsController     @UseGuards(AdminGuard)
```

**Guard 执行顺序提示**：NestJS guard 链「先全局后局部」，AuthGuard 已在全局守卫位填充 `req.user`（`toAuthUser` 已注入 `role` 字段），AdminGuard 直接读 `req.user.role` 不需要再做登录态检查也不需要查 DB。单测构造 mock request 时必须先放 `req.user`（含 `role`），否则会被 AdminGuard 误判为非 admin（403）而非 401。

## SSE 守卫

`QuantJobsSseController` 走 EventSource（不能带 Authorization header）——既有约定是先 `POST /api/quant/jobs/:id/sse-token` 取短期 token，再用 query 参数建连（详见 CLAUDE.md SSE 章节与 `apps/web/src/views/quant/README.md`）。

**改造点**：

- `POST /api/quant/jobs/:id/sse-token` 加 `@UseGuards(AdminGuard)` — 非 admin 拿不到 token，SSE 通道天然关闭
- token 内继续编码 `user_id`（不编码 `role`，避免颁发后角色变更导致 stale），SSE 连接处理器拿到 token → 解出 `user_id` → 在 Observable 内异步查 DB `users.role`，非 admin 则 `subscriber.error(ForbiddenException)` 关流（防止 token 颁发后用户被降级 `UPDATE users SET role='user'`）
- 不需要给 `GET /api/quant/jobs/:id/sse` 加 AdminGuard（它依赖 token 而非 session）

测试用例：详见 [06-testing.md](./06-testing.md#2-nestjs-jest) `sse-token` 守卫与 token 解码 admin 二次校验两条。

**环境变量**：本 admin 方案不再引入任何新 env（refactor 2026-05-23）。原 `ADMIN_USER_IDS` 已从根 `.env.example` 删除。

## Factors Module

**目录**：`apps/server/src/modules/quant/factors/`

```text
factors.module.ts
factors.controller.ts
factors.service.ts
dto/update-factor.dto.ts
__tests__/factors.service.spec.ts
__tests__/factors.controller.spec.ts
```

**Entity**：`apps/server/src/entities/ml/factor-definition.entity.ts`（按 CLAUDE.md「entities 按业务域分子目录」放 `ml/`）

字段命名遵循仓库现有风格（参考 `apps/server/src/entities/ml/ml-job.entity.ts`）：**类属性驼峰** + `@Column({ name: 'snake_case' })` 映射 DB 列：

```text
@Entity({ schema: 'factors', name: 'factor_definitions' })
class FactorDefinition {
  @PrimaryColumn({ name: 'factor_id' }) factorId: string
  @PrimaryColumn({ name: 'factor_version' }) factorVersion: string
  @Column('text') description: string
  @Column('text', { nullable: true }) formula: string | null
  @Column('text', { name: 'data_source', array: true, nullable: true })
    dataSource: string[] | null
  @Column() category: string
  @Column({ name: 'pit_window_days' }) pitWindowDays: number
  @Column({ name: 'pit_anchor' }) pitAnchor: string
  @Column({ default: true }) enabled: boolean
  @Column({ name: 'display_order', default: 100 }) displayOrder: number
  @Column('timestamptz', { name: 'updated_at' }) updatedAt: Date
  @Column({ name: 'updated_by', nullable: true }) updatedBy: string | null
}
```

**API 响应字段保持 snake_case**（与 quant-pipeline / DB 一致），service 层做转换：

```text
DB 列 (snake_case) → entity 属性 (camelCase) → 响应 DTO (snake_case)
```

避免前端类型既要兼容 DB 又要兼容 entity 的混乱。

## Endpoints

```text
GET    /api/quant/factors                         ?enabled=&category=
GET    /api/quant/factors/categories              去重 category 列表
PATCH  /api/quant/factors/:id/:version            编辑单条
```

**不做的端点**：

- `POST /factors`、`DELETE /factors/:id`——前端不可新建/删除（必须有 Python compute）
- `POST /factors/:id/:version/toggle`——PATCH `{enabled}` 可干同样事，避免冗余端点

## Service 方法签名

```text
FactorsService {
  listFactors(query?: { enabled?: boolean; category?: string })
    → Promise<FactorDefinition[]>

  listCategories()
    → Promise<string[]>

  findOne(factorId: string, factorVersion: string)
    → Promise<FactorDefinition>                  // 不存在 → NotFoundException

  update(factorId, factorVersion, dto: UpdateFactorDefinitionDto, userId: string)
    → Promise<FactorDefinition>                  // 先 findOne 抛 404；再 update
}
```

- `findOne` 用于 PATCH 前置校验：资源不存在直接返 404，而不是静默 update 0 行
- `update` 内部强写 `updated_at = NOW()`、`updated_by = userId`，dto 中这两字段（若误传）应被忽略

## PATCH DTO

`apps/server/src/modules/quant/factors/dto/update-factor.dto.ts`（class-validator）：

```text
UpdateFactorDefinitionDto {
  description?:        string                @MaxLength(500)
  formula?:            string | null         @MaxLength(500)
  data_source?:        string[] | null
  category?:           enum 4 值             @IsIn(['price','industry','fundamental','mixed'])
  pit_window_days?:    integer 1..400        @Min(1) @Max(400)
  pit_anchor?:         'trade_date' | 'ann_date'
  enabled?:            boolean
  display_order?:      integer 0..9999       @Min(0) @Max(9999)
}
```

- 全部 optional，未传字段保持原值
- service 内 PATCH 时强写 `updated_at = NOW()`、`updated_by = req.user.id`
- 前端表单**不**暴露 `formula` / `data_source` 编辑入口（只读展示），但 DTO 保留以便管理脚本/migration 使用

## 响应形态

```text
GET   /factors            → { items: FactorDefinition[] }
GET   /factors/categories → { items: string[] }
PATCH /factors/:id/:v     → { item: FactorDefinition }
```

与既有 `quantApi.getModelVersions` / `getDailyTopK` 命名风格一致。

## /api/auth/me 扩展

**目的**：前端需要知道当前用户是不是 admin，以隐藏菜单 + 阻止路由进入。

- `apps/server/src/auth/auth.service.ts` 的 `me(user)` 响应**追加 `is_admin: boolean`**
- 实现：`is_admin: isAdminUser(user)`（共享判定函数，仅做 `user.role === 'admin'`），与 `AdminGuard` 同源同语义
- 不需要查 DB——`user` 是全局 AuthGuard 注入的 `AuthUserDto`，已含 `role` 字段（来自 `toAuthUser(UserEntity)`）

**响应示例**：

```json
{
  "id": "uuid...",
  "username": "...",
  "is_admin": true,
  "...": "其他既有字段"
}
```

## Migration（NestJS 侧：幂等校验脚本）

按 CLAUDE.md 硬约束：DB schema 调整须附 docker exec 脚本。但本表由 Alembic（步骤 1）建立，NestJS 侧**不**重复建表，而是写**幂等校验脚本**避免 DDL 冲突：

- `apps/server/migrations/20260524_factor_definitions.sql`
  - 内容：`CREATE TABLE IF NOT EXISTS factors.factor_definitions (...)` + 列与索引存在性 `DO $$ ... $$` 校验
  - 列定义必须与 Alembic migration 完全一致（CI 用 diff 比对两份脚本）
- `apps/server/migrations/20260524_factor_definitions.ps1`
  - 内置 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -f /tmp/...sql`
  - 跑完输出表行数、列清单，供发布时人工核对

**用途**：发布纪录、灾难恢复时的 fallback、CI schema 漂移检测；正常路径上 Alembic 已经建好，本脚本不应执行 DDL。

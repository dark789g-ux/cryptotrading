---
paths:
  - "apps/server/**/*.ts"
---

# NestJS

## AuthGuard 使用规范

`AuthGuard` 已通过 `APP_GUARD` 注册为全局守卫，Controller 上**禁止**再加 `@UseGuards(AuthGuard)`。

**原因**：会让 NestJS 在当前模块上下文解析 Guard 依赖，未导入 `AuthModule` 启动报 `Can't resolve dependencies`。

## 修改 tsconfig.json 后必须验证构建入口

新增/修改 `paths`、`include`、`rootDir` 后，运行 `pnpm --filter @cryptotrading/server build`，确认 `nest-cli.json` 的 `entryFile`（`apps/server/src/main`）与实际产物路径一致。

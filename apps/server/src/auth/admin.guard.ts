import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Admin 判定：以 DB 的 `users.role`（CHECK 约束 `role IN ('admin','user')`）为单一权威。
 *
 * 设计背景（refactor 2026-05-23）：
 * - 早期 spec 在「无角色系统」前提下引入了 `ADMIN_USER_IDS` env 白名单 + `AdminPolicy`，
 *   落地时发现 `users.role` 列与 `idx_users_role` 早就存在，env 白名单是冗余设计；
 *   已重构为直接读 `req.user.role === 'admin'`。
 * - 全局 AuthGuard（APP_GUARD）通过 `toAuthUser(UserEntity)` 注入的 `req.user` 已带 `role`
 *   字段（见 `apps/server/src/auth/shared/auth.utils.ts`、`dto/auth.dto.ts`），因此本 guard
 *   不需要再查 DB——`req.user.role` 与 DB 同步（每个请求都从 session_tokens 联表查 user）。
 * - 加 / 调 admin 走 SQL：`UPDATE users SET role='admin' WHERE id='<uuid>'`，无需重启 server。
 *
 * 与全局 AuthGuard 关系（CLAUDE.md）：
 * - AuthGuard 已通过 APP_GUARD 注册为全局守卫，负责把 `req.user` 挂上
 * - AdminGuard 是局部守卫，直接读 `req.user.role`，不再做登录态校验
 * - guard 链「先全局后局部」，所以本守卫执行时 `req.user` 必已存在；测试构造 mock
 *   request 时必须先放 `req.user`，否则会被误判为 403（而非 401）
 *
 * 行为：
 * - `req.user.role === 'admin'` → 放行
 * - 否则 throw `ForbiddenException`
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role: string | undefined = req?.user?.role;
    if (role !== 'admin') {
      throw new ForbiddenException('需要管理员权限');
    }
    return true;
  }
}

/**
 * 共享的 admin 判定函数。
 *
 * 仅用于「已经拿到 user 对象」的场景（如 `auth.service.me()`、SSE 二次校验）。
 * 守卫场景请直接用 `AdminGuard`。
 *
 * 入参可为：
 * - `AuthUserDto` / `UserEntity` / 任何带 `role` 字段的对象
 * - `undefined` / `null` → false
 */
export function isAdminUser(
  user: { role?: string | null } | null | undefined,
): boolean {
  return user?.role === 'admin';
}

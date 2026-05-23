import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard, isAdminUser } from '../admin.guard';

/**
 * AdminGuard 与 isAdminUser 单测。
 *
 * refactor 2026-05-23：admin 判定从 env 白名单 (`ADMIN_USER_IDS`) 改为 DB 的
 * `users.role`。全局 AuthGuard 注入的 `req.user` 已带 `role` 字段
 * （见 `apps/server/src/auth/shared/auth.utils.ts` `toAuthUser`），
 * AdminGuard 直接读 `req.user.role === 'admin'`，无需查 DB。
 */
function mockContext(user: { role?: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('isAdminUser', () => {
  it('role=admin → true', () => {
    expect(isAdminUser({ role: 'admin' })).toBe(true);
  });

  it('role=user → false', () => {
    expect(isAdminUser({ role: 'user' })).toBe(false);
  });

  it('role 缺失 → false', () => {
    expect(isAdminUser({})).toBe(false);
  });

  it('null / undefined → false', () => {
    expect(isAdminUser(null)).toBe(false);
    expect(isAdminUser(undefined)).toBe(false);
  });

  it('role 大小写敏感（仅严格小写 "admin"）', () => {
    // DB CHECK 约束已限定 role ∈ ('admin','user')，所以这里要求严格匹配
    expect(isAdminUser({ role: 'Admin' })).toBe(false);
    expect(isAdminUser({ role: 'ADMIN' })).toBe(false);
  });
});

describe('AdminGuard.canActivate', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    guard = new AdminGuard();
  });

  it('req.user.role === "admin" → 放行', () => {
    const ctx = mockContext({ role: 'admin' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('req.user.role === "user" → ForbiddenException', () => {
    const ctx = mockContext({ role: 'user' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('req.user 缺失（理论上全局 AuthGuard 已挡） → ForbiddenException（兜底）', () => {
    const ctx = mockContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('req.user.role 缺失 → ForbiddenException', () => {
    const ctx = mockContext({});
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SseTokenGuard } from './sse-token.guard';
import { SseTokenService } from '../services/sse-token.service';
import { signSseToken, SSE_TOKEN_TTL_SECONDS } from '../realtime/sse-token.util';

/**
 * SseTokenGuard 用例：合法 / 过期 / 签名错 / job_id 不匹配 / 缺 token / 密钥未配置。
 */
describe('SseTokenGuard', () => {
  const SECRET = 'unit-test-secret';

  const makeCtx = (token: string | undefined, idParam: string | undefined): ExecutionContext => {
    const req: any = {
      query: token === undefined ? {} : { token },
      params: idParam === undefined ? {} : { id: idParam },
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext;
  };

  const makeGuard = (secret: string | undefined = SECRET): SseTokenGuard => {
    const cfg = { get: jest.fn().mockImplementation((k: string) => (k === 'QUANT_SSE_TOKEN_SECRET' ? secret : undefined)) } as unknown as ConfigService;
    const tokens = new SseTokenService(cfg);
    return new SseTokenGuard(tokens);
  };

  it('合法 token + path param id 与 payload.job_id 一致 → 放行，并把 payload 挂到 req.sseTokenPayload', () => {
    const guard = makeGuard();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = signSseToken({ job_id: 'job-1', user_id: 'user-1', exp: nowSec + SSE_TOKEN_TTL_SECONDS }, SECRET);

    const ctx = makeCtx(token, 'job-1');
    expect(guard.canActivate(ctx)).toBe(true);
    const req: any = (ctx.switchToHttp().getRequest() as any);
    expect(req.sseTokenPayload).toMatchObject({ job_id: 'job-1', user_id: 'user-1' });
  });

  it('过期 token → 抛 UnauthorizedException', () => {
    const guard = makeGuard();
    const expiredToken = signSseToken({ job_id: 'j', user_id: 'u', exp: 1 }, SECRET);
    expect(() => guard.canActivate(makeCtx(expiredToken, 'j'))).toThrow(UnauthorizedException);
  });

  it('签名错（密钥不同）→ 抛 UnauthorizedException', () => {
    const guard = makeGuard();
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenSignedWithOtherSecret = signSseToken(
      { job_id: 'j', user_id: 'u', exp: nowSec + 60 },
      'other-secret',
    );
    expect(() => guard.canActivate(makeCtx(tokenSignedWithOtherSecret, 'j'))).toThrow(
      UnauthorizedException,
    );
  });

  it('job_id 不匹配 path param → 抛 UnauthorizedException', () => {
    const guard = makeGuard();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = signSseToken({ job_id: 'job-A', user_id: 'u', exp: nowSec + 60 }, SECRET);
    expect(() => guard.canActivate(makeCtx(token, 'job-B'))).toThrow(UnauthorizedException);
  });

  it('缺 token → 抛 UnauthorizedException', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(makeCtx(undefined, 'j'))).toThrow(UnauthorizedException);
  });

  it('密钥未配置 → 抛 UnauthorizedException（服务端配置问题但对外仍 401）', () => {
    const guard = makeGuard(undefined);
    const token = 'whatever.sig';
    expect(() => guard.canActivate(makeCtx(token, 'j'))).toThrow(UnauthorizedException);
  });
});

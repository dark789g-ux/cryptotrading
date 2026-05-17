import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SseTokenService } from './sse-token.service';
import { SSE_TOKEN_TTL_SECONDS, signSseToken } from '../realtime/sse-token.util';

/**
 * SseTokenService 单测：
 *  - issue → verify 回环
 *  - 5 分钟 TTL 边界
 *  - 篡改检测（签名错 / payload 错 / 过期）
 *  - 密钥优先级：QUANT_SSE_TOKEN_SECRET > QUANT_SSE_SECRET > JWT_SECRET
 *  - 密钥全空时 issue 抛错 / verify 返回 null
 */
describe('SseTokenService', () => {
  const SECRET = 'unit-test-secret-please-rotate';

  const makeService = (cfgImpl: (k: string) => string | undefined): SseTokenService => {
    const cfg: any = { get: jest.fn().mockImplementation(cfgImpl) };
    return new SseTokenService(cfg as ConfigService);
  };

  describe('issueToken / verifyToken 回环', () => {
    it('颁发 → 校验通过，返回相同 jobId / userId', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      const issued = svc.issueToken('job-abc', 'user-1');
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(issued.payload).toMatchObject({ job_id: 'job-abc', user_id: 'user-1' });

      const verified = svc.verifyToken(issued.token);
      expect(verified).toEqual({ jobId: 'job-abc', userId: 'user-1' });
    });

    it('expiresAt 落在 ~5 分钟后（允许 5s 容差）', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      const before = Date.now();
      const issued = svc.issueToken('j', 'u');
      const after = Date.now();
      const expMs = issued.expiresAt.getTime();
      expect(expMs).toBeGreaterThanOrEqual(before + SSE_TOKEN_TTL_SECONDS * 1000 - 5000);
      expect(expMs).toBeLessThanOrEqual(after + SSE_TOKEN_TTL_SECONDS * 1000 + 5000);
    });
  });

  describe('篡改 / 过期检测', () => {
    it('payload 篡改 → 签名失配 → null', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      const issued = svc.issueToken('job-A', 'user-X');
      // 把 payload 部分换成「别的 job_id」但保留原签名
      const fakePayload = Buffer.from(JSON.stringify({ job_id: 'job-B', user_id: 'user-X', exp: 9999999999 })).toString('base64url');
      const tampered = `${fakePayload}.${issued.token.split('.')[1]}`;
      expect(svc.verifyToken(tampered)).toBeNull();
    });

    it('签名段乱改 → null', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      const issued = svc.issueToken('j', 'u');
      const [body] = issued.token.split('.');
      // 用一段长度合法但不属于本 secret 的签名替换
      const wrongSig = Buffer.from('a'.repeat(32)).toString('base64url');
      const tampered = `${body}.${wrongSig}`;
      expect(svc.verifyToken(tampered)).toBeNull();
    });

    it('用不同密钥签的 token → null', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      const nowSec = Math.floor(Date.now() / 1000);
      const foreignToken = signSseToken({ job_id: 'j', user_id: 'u', exp: nowSec + 60 }, 'other-secret');
      expect(svc.verifyToken(foreignToken)).toBeNull();
    });

    it('过期 token → null', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      const expiredToken = signSseToken({ job_id: 'j', user_id: 'u', exp: 1 }, SECRET);
      expect(svc.verifyToken(expiredToken)).toBeNull();
    });

    it('格式畸形 token（无 `.`）→ null', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? SECRET : undefined));
      expect(svc.verifyToken('not-a-real-token')).toBeNull();
    });
  });

  describe('密钥读取优先级', () => {
    it('QUANT_SSE_TOKEN_SECRET 优先', () => {
      const svc = makeService((k) => {
        if (k === 'QUANT_SSE_TOKEN_SECRET') return 'primary';
        if (k === 'QUANT_SSE_SECRET') return 'fallback-1';
        if (k === 'JWT_SECRET') return 'fallback-2';
        return undefined;
      });
      const issued = svc.issueToken('j', 'u');
      // 由 primary 签发 → primary 必能校验通过
      expect(svc.verifyToken(issued.token)).toEqual({ jobId: 'j', userId: 'u' });
      // 验证 fallback-1 / fallback-2 都不可校验该 token
      const svcFallback = makeService((k) => (k === 'QUANT_SSE_TOKEN_SECRET' ? 'fallback-1' : undefined));
      expect(svcFallback.verifyToken(issued.token)).toBeNull();
    });

    it('回退到 QUANT_SSE_SECRET', () => {
      const svc = makeService((k) => (k === 'QUANT_SSE_SECRET' ? 'old-name' : undefined));
      const issued = svc.issueToken('j', 'u');
      expect(svc.verifyToken(issued.token)).toEqual({ jobId: 'j', userId: 'u' });
    });

    it('再回退到 JWT_SECRET', () => {
      const svc = makeService((k) => (k === 'JWT_SECRET' ? 'jwt-fallback' : undefined));
      const issued = svc.issueToken('j', 'u');
      expect(svc.verifyToken(issued.token)).toEqual({ jobId: 'j', userId: 'u' });
    });

    it('全部缺失：issueToken 抛错；verifyToken 返回 null', () => {
      const svc = makeService(() => undefined);
      expect(() => svc.issueToken('j', 'u')).toThrow(/secret 未配置/);
      expect(svc.verifyToken('whatever.sig')).toBeNull();
    });
  });
});

// 静音 Nest 内置 Logger，避免单测输出大量 warn/error
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

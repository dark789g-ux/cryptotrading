import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SSE_TOKEN_TTL_SECONDS,
  signCustomIndexSseToken,
  signSseToken,
  verifyCustomIndexSseToken,
  verifySseToken,
  type CustomIndexSseTokenPayload,
  type SseTokenPayload,
} from '../realtime/sse-token.util';

/**
 * SSE 短期 token 服务。
 *
 * 设计动机（来自 03-nestjs-vue.md §1）：
 *   浏览器原生 `EventSource` 不带 `Authorization` header，无法走全局 AuthGuard。
 *   方案：客户端先通过常规 HTTP 接口（受 AuthGuard 保护）调
 *   `POST /quant/jobs/:id/sse-token` 拿一个 5 分钟有效的短期 token，
 *   再以 `EventSource('/quant/jobs/:id/stream?token=...')` 建连；
 *   SSE controller 单独的 SseTokenGuard 校验该 token，不挂全局 AuthGuard。
 *
 * 密钥来源：环境变量 `QUANT_SSE_TOKEN_SECRET`；fallback 到 `JWT_SECRET` / `QUANT_SSE_SECRET`。
 * 三者全部缺失时启动应让任何 issue/verify 调用抛错 / 返回失败。
 */
export interface IssueTokenResult {
  token: string;
  expiresAt: Date;
  payload: SseTokenPayload;
}

export interface IssueCustomIndexTokenResult {
  token: string;
  expiresAt: Date;
  payload: CustomIndexSseTokenPayload;
}

@Injectable()
export class SseTokenService {
  private readonly logger = new Logger(SseTokenService.name);

  constructor(private readonly config: ConfigService) {}

  private getSecret(): string {
    const secret =
      this.config.get<string>('QUANT_SSE_TOKEN_SECRET') ||
      this.config.get<string>('QUANT_SSE_SECRET') ||
      this.config.get<string>('JWT_SECRET') ||
      '';
    return secret;
  }

  /**
   * 颁发一个 5 分钟有效 token；payload 含 `{ job_id, user_id, exp }`，HMAC-SHA256 签名。
   */
  issueToken(jobId: string, userId: string): IssueTokenResult {
    const secret = this.getSecret();
    if (!secret) {
      this.logger.error('SSE token secret 未配置（QUANT_SSE_TOKEN_SECRET / QUANT_SSE_SECRET / JWT_SECRET 至少一项必填）');
      throw new Error('SSE token secret 未配置');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: SseTokenPayload = {
      job_id: jobId,
      user_id: userId,
      exp: nowSec + SSE_TOKEN_TTL_SECONDS,
    };
    const token = signSseToken(payload, secret);
    return {
      token,
      expiresAt: new Date(payload.exp * 1000),
      payload,
    };
  }

  /**
   * 校验 token；通过返回 `{ jobId, userId }`，失败返回 `null`（不抛错，由调用方决定如何响应）。
   */
  verifyToken(token: string): { jobId: string; userId: string } | null {
    const secret = this.getSecret();
    if (!secret) {
      this.logger.error('SSE token secret 未配置，verifyToken 直接拒绝');
      return null;
    }
    const result = verifySseToken(token, secret);
    if (result.ok === false) {
      // 项目 tsconfig.strictNullChecks=false 时判别联合不会自动收窄，
      // 这里用 `as` 显式断言到失败分支以拿到 `reason` 字段。
      const reason = (result as { ok: false; reason: string }).reason;
      this.logger.warn(`sse_token_reject reason=${reason}`);
      return null;
    }
    return { jobId: result.payload.job_id, userId: result.payload.user_id };
  }

  issueCustomIndexToken(
    customIndexId: string,
    userId: string,
  ): IssueCustomIndexTokenResult {
    const secret = this.getSecret();
    if (!secret) {
      this.logger.error(
        'SSE token secret 未配置（QUANT_SSE_TOKEN_SECRET / QUANT_SSE_SECRET / JWT_SECRET 至少一项必填）',
      );
      throw new Error('SSE token secret 未配置');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: CustomIndexSseTokenPayload = {
      custom_index_id: customIndexId,
      user_id: userId,
      exp: nowSec + SSE_TOKEN_TTL_SECONDS,
    };
    const token = signCustomIndexSseToken(payload, secret);
    return {
      token,
      expiresAt: new Date(payload.exp * 1000),
      payload,
    };
  }

  verifyCustomIndexToken(
    token: string,
  ): { customIndexId: string; userId: string } | null {
    const secret = this.getSecret();
    if (!secret) {
      this.logger.error('SSE token secret 未配置，verifyCustomIndexToken 直接拒绝');
      return null;
    }
    const result = verifyCustomIndexSseToken(token, secret);
    if (result.ok === false) {
      const reason = (result as { ok: false; reason: string }).reason;
      this.logger.warn(`custom_index_sse_token_reject reason=${reason}`);
      return null;
    }
    return {
      customIndexId: result.payload.custom_index_id,
      userId: result.payload.user_id,
    };
  }
}

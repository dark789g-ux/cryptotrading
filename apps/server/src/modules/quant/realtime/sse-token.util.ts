import { createHmac, timingSafeEqual } from 'crypto';

/**
 * SSE 短期 token 工具：HMAC-SHA256 签名 `{job_id, user_id, exp}`。
 *
 * 设计动机（来自 03-nestjs-vue.md §1）：
 *   浏览器原生 `EventSource` 不带 `Authorization` header，无法走全局 AuthGuard。
 *   方案：客户端先通过常规 HTTP 接口（受 AuthGuard 保护）调
 *   `POST /quant/jobs/:id/sse-token` 拿一个 5 分钟有效的短期 token，
 *   再以 `EventSource('/quant/jobs/:id/stream?token=...')` 建连；
 *   SSE controller 单独的 SseTokenGuard 校验该 token，不挂全局 AuthGuard。
 *
 * 安全性：
 *   - HMAC-SHA256 + `timingSafeEqual` 防时序攻击
 *   - payload 含 `job_id` 与 `user_id`，建连时校验 job_id 匹配 path param
 *   - 5 分钟有效期；token 不可刷新，过期需重新请求
 *   - 密钥来自 `process.env.QUANT_SSE_SECRET`，缺失时启动应失败（由调用方校验）
 */

export interface SseTokenPayload {
  /** 关联的 ml.jobs.id */
  job_id: string;
  /** 颁发时的用户 id（CurrentUser.id） */
  user_id: string;
  /** 过期 unix 秒（UTC） */
  exp: number;
}

/** 自定义指数 SSE token payload（无 job_id） */
export interface CustomIndexSseTokenPayload {
  custom_index_id: string;
  user_id: string;
  exp: number;
}

export const SSE_TOKEN_TTL_SECONDS = 300; // 5 分钟

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(norm, 'base64');
}

/**
 * Token 格式：`base64url(payload_json).base64url(hmac_sha256(payload_json))`
 *
 * 选用「明文 payload + 签名」而非 JWT 全套：依赖少、可读、project 内一次性使用，
 * 不需要 JWT 的 alg 协商 / kid 体系。
 */
export function signSseToken(payload: SseTokenPayload, secret: string): string {
  if (!secret) {
    throw new Error('QUANT_SSE_SECRET 未配置');
  }
  const json = JSON.stringify(payload);
  const body = base64urlEncode(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(body).digest();
  return `${body}.${base64urlEncode(sig)}`;
}

export function signCustomIndexSseToken(
  payload: CustomIndexSseTokenPayload,
  secret: string,
): string {
  if (!secret) {
    throw new Error('QUANT_SSE_SECRET 未配置');
  }
  const json = JSON.stringify(payload);
  const body = base64urlEncode(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(body).digest();
  return `${body}.${base64urlEncode(sig)}`;
}

export type VerifySseTokenResult =
  | { ok: true; payload: SseTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_payload' };

export function verifySseToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifySseTokenResult {
  if (!secret) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) {
    return { ok: false, reason: 'malformed' };
  }

  // 1. 签名校验（timingSafeEqual 防时序攻击）
  const expectedSig = createHmac('sha256', secret).update(body).digest();
  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sig);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // 2. payload 解析
  let payload: SseTokenPayload;
  try {
    const json = base64urlDecode(body).toString('utf8');
    const parsed = JSON.parse(json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.job_id !== 'string' ||
      typeof parsed.user_id !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return { ok: false, reason: 'invalid_payload' };
    }
    payload = parsed as SseTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }

  // 3. 过期校验
  if (payload.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

export type VerifyCustomIndexSseTokenResult =
  | { ok: true; payload: CustomIndexSseTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_payload' };

export function verifyCustomIndexSseToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyCustomIndexSseTokenResult {
  if (!secret) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) {
    return { ok: false, reason: 'malformed' };
  }

  const expectedSig = createHmac('sha256', secret).update(body).digest();
  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sig);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: CustomIndexSseTokenPayload;
  try {
    const json = base64urlDecode(body).toString('utf8');
    const parsed = JSON.parse(json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.custom_index_id !== 'string' ||
      typeof parsed.user_id !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return { ok: false, reason: 'invalid_payload' };
    }
    payload = parsed as CustomIndexSseTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }

  if (payload.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

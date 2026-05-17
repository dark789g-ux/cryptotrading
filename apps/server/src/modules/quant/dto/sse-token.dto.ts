/**
 * `POST /quant/jobs/:id/sse-token` 不需要 body；id 走 path param。
 * 响应体使用本接口约定的形状。
 */
export interface SseTokenResponse {
  /** base64url 形式的短期 token */
  token: string;
  /** 过期时间，UTC 墙钟字符串（CLAUDE.md 时间规范） */
  expires_at: string;
  /** 与 token 内 payload 一致，便于前端调试 */
  job_id: string;
}

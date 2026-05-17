import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { SseTokenService } from '../services/sse-token.service';

/**
 * 校验 SSE 流接口（query `?token=...`）的短期 token，并把 `job_id` 与 path param 比对。
 *
 * 使用方式：
 *
 *   // SSE endpoint - AuthGuard global exception, uses SseTokenGuard instead
 *   @Sse(':id/stream')
 *   @Public()              // 跳过全局 AuthGuard
 *   @UseGuards(SseTokenGuard)
 *   stream(@Param('id') id: string, @Req() req): Observable<MessageEvent> { ... }
 *
 * 这是 CLAUDE.md「AuthGuard 全局注册」的合法例外：
 * 浏览器 EventSource 不带 cookie/header 以外的鉴权，因此必须把 token 放在 query 上。
 */
@Injectable()
export class SseTokenGuard implements CanActivate {
  private readonly logger = new Logger(SseTokenGuard.name);

  constructor(private readonly tokens: SseTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.query?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException('缺少 token');
    }

    const result = this.tokens.verifyToken(token);
    if (!result) {
      throw new UnauthorizedException('SSE token 校验失败');
    }
    // 类型守卫：上面 `if (!result)` 已 narrow 掉 null，本断言仅为给 strictNullChecks=false
    // 的 tsconfig 显式标记 result 非空，便于阅读
    const verified = result;

    // path param `id` 必须与 token 内 job_id 完全一致，避免 token 复用到其它 job 的流
    const jobIdParam: string | undefined = req.params?.id;
    if (jobIdParam && jobIdParam !== verified.jobId) {
      this.logger.warn(
        `sse_token_reject reason=job_id_mismatch path=${jobIdParam} token=${verified.jobId}`,
      );
      throw new UnauthorizedException('SSE token 与 job_id 不匹配');
    }

    // 把 token payload 挂到 req 上，便于下游 controller 取用户信息（如审计）
    req.sseTokenPayload = { job_id: verified.jobId, user_id: verified.userId };
    return true;
  }
}

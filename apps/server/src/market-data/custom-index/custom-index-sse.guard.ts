import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { SseTokenService } from '../../modules/quant/services/sse-token.service';

/**
 * 自定义指数 SSE 鉴权：校验 query token 签名/过期，**不**要求 path :id === token.job_id。
 * path :id 为 custom_index_id；token.job_id 为 latest ml.jobs.id（见 issueSseToken）。
 */
@Injectable()
export class CustomIndexSseGuard implements CanActivate {
  private readonly logger = new Logger(CustomIndexSseGuard.name);

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

    req.sseTokenPayload = { job_id: result.jobId, user_id: result.userId };
    return true;
  }
}

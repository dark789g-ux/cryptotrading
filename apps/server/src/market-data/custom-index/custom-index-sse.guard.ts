import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SseTokenService } from '../../modules/quant/services/sse-token.service';

/**
 * 自定义指数 SSE 鉴权：校验 query token 签名/过期；
 * path :id 须与 token.custom_index_id 一致。
 */
@Injectable()
export class CustomIndexSseGuard implements CanActivate {
  constructor(private readonly tokens: SseTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.query?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException('缺少 token');
    }

    const result = this.tokens.verifyCustomIndexToken(token);
    if (!result) {
      throw new UnauthorizedException('SSE token 校验失败');
    }

    const pathId = req.params?.id;
    if (typeof pathId === 'string' && pathId !== result.customIndexId) {
      throw new ForbiddenException('SSE token custom_index_id 与 path :id 不匹配');
    }

    req.sseTokenPayload = {
      custom_index_id: result.customIndexId,
      user_id: result.userId,
    };
    return true;
  }
}

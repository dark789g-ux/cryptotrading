import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';

import { CurrentUserParam as CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestWithUser } from '../auth/shared/auth.types';
import { ApiKeysService } from './api-keys.service';
import {
  CreateApiKeyDto,
  CurrentUserWithAuthType,
} from './api-keys.types';

/**
 * Assert that the request is authenticated via session, not via API key.
 * API key management endpoints must not be accessible by API keys themselves.
 */
function assertSessionAuth(req: RequestWithUser): void {
  const user = req.user as CurrentUserWithAuthType | undefined;
  if (!user) {
    throw new UnauthorizedException('未登录');
  }
  if (user.authType === 'apikey') {
    throw new UnauthorizedException('管理 API Key 需要会话登录');
  }
}

@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  /** GET /api/api-keys */
  @Get()
  list(
    @CurrentUser() user: CurrentUserWithAuthType,
    @Req() req: RequestWithUser,
  ) {
    assertSessionAuth(req);
    return this.apiKeysService.listKeys(user.id);
  }

  /** POST /api/api-keys */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: CurrentUserWithAuthType,
    @Body() body: CreateApiKeyDto,
    @Req() req: RequestWithUser,
  ) {
    assertSessionAuth(req);
    const name = (body.name ?? '').trim();
    if (!name) {
      throw new BadRequestException('name 不能为空');
    }
    if (name.length > 100) {
      throw new BadRequestException('name 不能超过 100 字符');
    }
    return this.apiKeysService.createKey(user.id, name);
  }

  /** DELETE /api/api-keys/:id */
  @Delete(':id')
  @HttpCode(200)
  async revoke(
    @CurrentUser() user: CurrentUserWithAuthType,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ) {
    assertSessionAuth(req);
    await this.apiKeysService.revokeKey(user.id, id);
    return { ok: true };
  }
}

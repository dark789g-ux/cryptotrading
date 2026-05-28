import { Body, Controller, Post } from '@nestjs/common';
import { QuantScoresService } from '../services/quant-scores.service';
import { validateScoresByTsCodesBody } from '../dto/score-query.dto';

/**
 * `POST /quant/scores/by-tscodes`：A 股面板评分列用的批量查询，**普通登录用户可访问**。
 *
 * 鉴权约束（CLAUDE.md）：
 *   - AuthGuard 已通过 APP_GUARD 全局注册，本 Controller **禁止**再加 `@UseGuards(AuthGuard)`。
 *   - 与同前缀的 `QuantScoresController` 不同——后者类级带 `@UseGuards(AdminGuard)`（仅 admin 看板）。
 *     评分是 A 股面板（普通用户可用）的一列，故拆出本公开 controller，复用同一 QuantScoresService。
 *   - NestJS 允许多个 controller 共享 `quant/scores` 前缀，只要具体路径不冲突。
 */
@Controller('quant/scores')
export class QuantPublicScoresController {
  constructor(private readonly svc: QuantScoresService) {}

  @Post('by-tscodes')
  async byTsCodes(@Body() body: Record<string, unknown>) {
    return this.svc.getScoresByTsCodes(validateScoresByTsCodesBody(body ?? {}));
  }
}

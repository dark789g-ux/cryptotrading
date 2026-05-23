import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FactorDefinitionEntity } from '../../../entities/ml/factor-definition.entity';
import { FactorsController } from './factors.controller';
import { FactorsService } from './factors.service';

/**
 * `apps/server/src/modules/quant/factors/`：因子元数据 admin 管理 API。
 *
 * 端点详见 `factors.controller.ts` 头注。表 `factors.factor_definitions` 由
 * Alembic（quant-pipeline 侧）建表，NestJS `synchronize: false`；本 module 仅做读写。
 *
 * AdminGuard 由 `@auth/admin.guard.ts` 提供，无需 DI 容器额外配置
 * （只读 `req.user.role`，无外部依赖）；不在 providers 列出 AdminGuard，
 * 避免与它处直接 `new AdminGuard()` 不一致。
 */
@Module({
  imports: [TypeOrmModule.forFeature([FactorDefinitionEntity])],
  controllers: [FactorsController],
  providers: [FactorsService],
  exports: [FactorsService],
})
export class FactorsModule {}

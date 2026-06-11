/**
 * create-portfolio-sim.dto.ts
 *
 * 新建组合模拟方案请求 DTO。
 *
 * 校验策略与 signal-stats 一致：仓内**无全局 ValidationPipe**（main.ts 未注册），
 * class-validator 装饰器不会在运行时强制；故校验统一在 service 层 fail-fast 抛 BadRequestException。
 * 本文件用纯接口表达契约（与 signal-stats dto 同构），service.validateCreateDto 做实际校验。
 *
 * config 形态钉死引擎 PortfolioSimConfig（loader/engine 直接消费），落 jsonb 列。
 */

import { PortfolioSimConfig } from '../portfolio-sim.types';

export interface CreatePortfolioSimDto {
  /** 方案名称，非空、≤100 字符。 */
  name: string;

  /** 备注（可选）。 */
  note?: string | null;

  /** 组合配置：sources（1~5）+ 初始资金 + 费率 + 锚点模式。 */
  config: PortfolioSimConfig;
}

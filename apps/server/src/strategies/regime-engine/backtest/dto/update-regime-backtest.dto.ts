import { CreateRegimeBacktestDto } from './create-regime-backtest.dto';

/**
 * PATCH body: create DTO 字段子集（name / config / capital / dateStart / dateEnd）。
 * note / regimeConfigId 可选，与 create 对齐便于前端复用同一 payload。
 */
export type UpdateRegimeBacktestDto = Pick<
  CreateRegimeBacktestDto,
  'name' | 'config' | 'capital' | 'dateStart' | 'dateEnd'
> &
  Pick<CreateRegimeBacktestDto, 'note' | 'regimeConfigId'>;

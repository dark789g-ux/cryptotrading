/**
 * regime-engine.types.ts
 *
 * regime-engine 模块的请求/响应 DTO 类型。
 */
import {
  RegimeConfigEntry,
} from '../../entities/strategy/regime-strategy-config.entity';
import {
  RegimeDailyPickEntity,
  RegimePickAction,
} from '../../entities/strategy/regime-daily-pick.entity';
import { RegimeResult } from './regime.classifier';

/** POST /regime-engine/configs 请求体 */
export interface CreateRegimeConfigDto {
  /** 缺省自动取 max(version)+1 */
  version?: number;
  note?: string | null;
  /** 四象限配置 jsonb（结构校验见 regime-engine.validation.ts） */
  config: unknown;
}

/** POST /regime-engine/run-daily 响应 */
export interface RunDailyResult {
  tradeDate: string;
  regime: RegimeResult;
  action: RegimePickAction;
  configVersion: number | null;
  /** trade 命中标的数；flat/unknown 恒 0 */
  pickCount: number;
}

/** GET /regime-engine/today 响应 */
export interface RegimeTodaySummary {
  /** oamv_daily 最新交易日；表空时 null */
  tradeDate: string | null;
  regime: RegimeResult;
  oamv: {
    close: number;
    amvDif: number | null;
    amvDea: number | null;
    amvMacd: number | null;
  } | null;
  /** active 配置摘要；无 active 配置时 null（today 是只读视图，不抛 409） */
  activeConfig: {
    id: string;
    version: number;
    note: string | null;
    /** 当前象限的配置条目；regime=unknown 时 null */
    entry: RegimeConfigEntry | null;
  } | null;
  /** 最新交易日的清单（若已跑；未跑为空数组） */
  picks: RegimeDailyPickEntity[];
}

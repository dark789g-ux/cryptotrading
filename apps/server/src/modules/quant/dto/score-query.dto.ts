import { BadRequestException } from '@nestjs/common';

/**
 * `GET /quant/scores/*` 系列查询 DTO 集合。
 *
 * 沿用本 module 既有 DTO 约定（见 create-job.dto.ts 注释）：
 *  - DTO 仅声明类型
 *  - 校验放到独立 `validate*` 函数，由 controller 显式调用
 *  - 不引入 class-validator（项目目前未用）
 *  - 严格度与 class-validator 等价
 *
 * 注意：本模块所有 service 内的动态过滤 / 排序字段必须经 FIELD_COL_MAP 翻译，
 *      未命中字段一律 `logger.warn` + skip（CLAUDE.md 硬约束）。
 */

const TRADE_DATE_RE = /^\d{8}$/;
// model_version 例如 `lgb-lambdarank-v1-20260620-seed42`：字母 / 数字 / 下划线 / 短横线
const MODEL_VERSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
// ts_code 例如 `000001.SZ` / `600519.SH`
const TS_CODE_RE = /^[A-Za-z0-9.]{1,16}$/;

function parseTradeDate(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !TRADE_DATE_RE.test(raw)) {
    throw new BadRequestException(`${field} 必须为 8 位数字串 YYYYMMDD`);
  }
  return raw;
}

function parseModelVersion(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !MODEL_VERSION_RE.test(raw)) {
    throw new BadRequestException(
      `${field} 必须为 1..128 长度，且仅含字母/数字/下划线/短横线`,
    );
  }
  return raw;
}

function parseTsCode(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !TS_CODE_RE.test(raw)) {
    throw new BadRequestException(`${field} 必须为 1..16 长度，且仅含字母/数字/点号`);
  }
  return raw;
}

function parseTopK(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 50;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    throw new BadRequestException('top_k 必须为 1..500 之间的整数');
  }
  return n;
}

/**
 * 顶层 `/quant/scores` 用更宽的 top_k 上限（spec M3 §5：5500 标的 × 4 年 P95 < 500ms；
 * 上限 1000 用于 scores 列表分页场景的 limit 拼接，防止全表扫描）。
 */
function parseTopKWide(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 50;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > 1000) {
    throw new BadRequestException('top_k 必须为 1..1000 之间的整数');
  }
  return n;
}

function parsePage(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new BadRequestException('page 必须为 >=1 的整数');
  }
  return n;
}

function parsePageSize(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 50;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    throw new BadRequestException('page_size 必须为 1..500 之间的整数');
  }
  return n;
}

/** 顶层 /quant/scores 允许排序的前端字段名（service 内再经 FIELD_COL_MAP 翻译为列名） */
const SCORES_LIST_ALLOWED_SORT_FIELDS: readonly string[] = [
  'rank_in_day',
  'score',
  'ts_code',
] as const;
const SCORES_LIST_ALLOWED_SORT_DIRS: readonly string[] = ['ASC', 'DESC'] as const;

// ============ /quant/scores/daily ============

export class ScoresDailyQueryDto {
  trade_date!: string;
  model_version!: string;
  top_k?: number;
}

export interface ValidatedScoresDailyQuery {
  tradeDate: string;
  modelVersion: string;
  topK: number;
}

export function validateScoresDailyQuery(
  query: Record<string, unknown>,
): ValidatedScoresDailyQuery {
  return {
    tradeDate: parseTradeDate(query.trade_date, 'trade_date'),
    modelVersion: parseModelVersion(query.model_version, 'model_version'),
    topK: parseTopK(query.top_k),
  };
}

// ============ /quant/scores/ts/:ts_code ============

export class ScoresTimeSeriesQueryDto {
  model_version!: string;
  start!: string;
  end!: string;
}

export interface ValidatedScoresTimeSeriesQuery {
  tsCode: string;
  modelVersion: string;
  start: string;
  end: string;
}

export function validateScoresTimeSeriesQuery(
  tsCode: string,
  query: Record<string, unknown>,
): ValidatedScoresTimeSeriesQuery {
  const code = parseTsCode(tsCode, 'ts_code');
  const modelVersion = parseModelVersion(query.model_version, 'model_version');
  const start = parseTradeDate(query.start, 'start');
  const end = parseTradeDate(query.end, 'end');
  if (start > end) {
    throw new BadRequestException(`start (${start}) 不得晚于 end (${end})`);
  }
  return { tsCode: code, modelVersion, start, end };
}

// ============ /quant/scores/compare ============

export class ScoresCompareQueryDto {
  trade_date!: string;
  /** 逗号分隔的多个 model_version */
  model_versions!: string;
  top_k?: number;
}

export interface ValidatedScoresCompareQuery {
  tradeDate: string;
  modelVersions: string[];
  topK: number;
}

export function validateScoresCompareQuery(
  query: Record<string, unknown>,
): ValidatedScoresCompareQuery {
  const tradeDate = parseTradeDate(query.trade_date, 'trade_date');
  const raw = query.model_versions;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException('model_versions 必须为非空逗号分隔字符串');
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 1 || parts.length > 8) {
    throw new BadRequestException('model_versions 数量必须 ∈ [1, 8]');
  }
  for (const p of parts) {
    if (!MODEL_VERSION_RE.test(p)) {
      throw new BadRequestException(
        `model_versions 中包含非法版本号 ${JSON.stringify(p)}（仅含字母/数字/下划线/短横线，≤128 字符）`,
      );
    }
  }
  // 去重，避免 PG ::text[] 内部冗余
  const dedup = Array.from(new Set(parts));
  return {
    tradeDate,
    modelVersions: dedup,
    topK: parseTopK(query.top_k),
  };
}

// ============ /quant/scores （顶层：spec M3 §5 列表 + 分页 + 排序） ============

/**
 * `GET /quant/scores?trade_date=&model_version=&top_k=&page=&page_size=&sort=`
 *
 * - trade_date / model_version 必填
 * - top_k：上限 1000（防全表扫描），仅作为单次查询行数硬上限
 * - sort 形如 `rank_in_day,asc`（field,dir 用逗号分隔，与 spec 文本完全一致）
 *   字段白名单：rank_in_day / score / ts_code（service 端再经 FIELD_COL_MAP 翻译）
 */
export class ScoresListQueryDto {
  trade_date!: string;
  model_version!: string;
  top_k?: number;
  page?: number;
  page_size?: number;
  /** `field,dir` 例如 `rank_in_day,asc` */
  sort?: string;
}

export interface ValidatedScoresListQuery {
  tradeDate: string;
  modelVersion: string;
  topK: number;
  page: number;
  pageSize: number;
  sortField: string;
  sortDir: 'ASC' | 'DESC';
}

export function validateScoresListQuery(
  query: Record<string, unknown>,
): ValidatedScoresListQuery {
  const tradeDate = parseTradeDate(query.trade_date, 'trade_date');
  const modelVersion = parseModelVersion(query.model_version, 'model_version');
  const topK = parseTopKWide(query.top_k);
  const page = parsePage(query.page);
  const pageSize = parsePageSize(query.page_size);

  // 默认 rank_in_day,asc（走 (trade_date, model_version, rank_in_day) 索引）
  let sortField = 'rank_in_day';
  let sortDir: 'ASC' | 'DESC' = 'ASC';
  if (query.sort !== undefined && query.sort !== null && query.sort !== '') {
    const raw = String(query.sort);
    const [field, dirRaw] = raw.split(',').map((s) => s.trim());
    if (!field) {
      throw new BadRequestException('sort 必须形如 `field,asc|desc`');
    }
    if (!SCORES_LIST_ALLOWED_SORT_FIELDS.includes(field)) {
      throw new BadRequestException(
        `sort.field 必须 ∈ {${SCORES_LIST_ALLOWED_SORT_FIELDS.join('|')}}`,
      );
    }
    const dir = (dirRaw ?? 'asc').toUpperCase();
    if (!SCORES_LIST_ALLOWED_SORT_DIRS.includes(dir)) {
      throw new BadRequestException(
        `sort.dir 必须 ∈ {asc|desc}`,
      );
    }
    sortField = field;
    sortDir = dir as 'ASC' | 'DESC';
  }

  return { tradeDate, modelVersion, topK, page, pageSize, sortField, sortDir };
}

export const ALLOWED_SCORES_SORT_FIELDS = SCORES_LIST_ALLOWED_SORT_FIELDS;

// ============ POST /quant/scores/by-tscodes（A 股面板评分列批量查） ============

/**
 * 单次批量查的 ts_codes 上限。A 股面板分页最大 50/页，留余量到 500
 * （翻页快速连点时可能合并，且未来可能放大 pageSize）。
 */
const SCORES_BY_TSCODES_MAX = 500;

export class ScoresByTsCodesBodyDto {
  trade_date!: string;
  ts_codes!: string[];
}

export interface ValidatedScoresByTsCodesQuery {
  tradeDate: string;
  tsCodes: string[];
}

export function validateScoresByTsCodesBody(
  body: Record<string, unknown>,
): ValidatedScoresByTsCodesQuery {
  const tradeDate = parseTradeDate(body.trade_date, 'trade_date');
  const raw = body.ts_codes;
  if (!Array.isArray(raw)) {
    throw new BadRequestException('ts_codes 必须为字符串数组');
  }
  if (raw.length > SCORES_BY_TSCODES_MAX) {
    throw new BadRequestException(
      `ts_codes 数量不得超过 ${SCORES_BY_TSCODES_MAX}（实际 ${raw.length}）`,
    );
  }
  // 复用 parseTsCode 做逐项校验（非法 code 直接 400），再去重
  const tsCodes = Array.from(
    new Set(raw.map((v, i) => parseTsCode(v, `ts_codes[${i}]`))),
  );
  return { tradeDate, tsCodes };
}

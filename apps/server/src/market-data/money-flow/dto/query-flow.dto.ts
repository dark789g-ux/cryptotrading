/** 高级筛选条件比较操作符 */
export type QueryConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

/** 数值类条件：右值为常量 number */
export interface QueryNumberCondition {
  field: string;
  op: QueryConditionOp;
  valueType?: 'number';
  value: number;
}

/** 字段引用类条件：右值为另一字段名 */
export interface QueryFieldCondition {
  field: string;
  op: QueryConditionOp;
  valueType: 'field';
  compareField: string;
}

export type QueryCondition = QueryNumberCondition | QueryFieldCondition;

export class QueryFlowDto {
  /** 单日查询（YYYYMMDD），与 start_date/end_date 互斥 */
  trade_date?: string;
  start_date?: string;
  end_date?: string;
  /** 按实体代码过滤（个股 ts_code、行业 ts_code、板块 ts_code） */
  ts_code?: string;
  /** 返回条数上限（按 trade_date DESC 取最新 N 条） */
  limit?: number;

  // ---------- 行业资金流筛选（服务端筛选） ----------
  /** 行业名 LIKE 模糊匹配 */
  industry?: string;
  /** 涨跌幅 % 区间（DB 原始单位） */
  pct_change_min?: number;
  pct_change_max?: number;
  /** 净流入 / 净买入 / 净卖出 下限（DB 原始单位「万元」，前端需自行换算） */
  net_amount_min?: number;
  net_buy_amount_min?: number;
  net_sell_amount_min?: number;
  /** 高级筛选条件数组 */
  conditions?: QueryCondition[];
  /** 申万行业级别筛选：1=一级 / 2=二级 / 3=三级（仅申万行业维度有效） */
  sw_level?: 1 | 2 | 3;
}

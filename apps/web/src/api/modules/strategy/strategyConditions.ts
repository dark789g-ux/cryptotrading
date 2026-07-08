import { API_BASE, post, put, del, request } from '../../client'

export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
  compareMode?: 'field' | 'value';
  /** 自定义 KDJ 参数（N/M1/M2）；仅当 field/compareField 为 KDJ 字段时有意义；缺省视为 9/3/3。 */
  kdjParams?: { n: number; m1: number; m2: number };
}

export interface StrategyConditionLastRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | string;
  /** 运行启动时间（UTC ISO 字符串） */
  startedAt: string;
  /** 运行完成时间；运行中则为 null */
  completedAt: string | null;
}

export interface StrategyCondition {
  id: string;
  name: string;
  userId: string;
  targetType: 'crypto' | 'a-share';
  conditions: StrategyConditionItem[];
  createdAt: string;
  updatedAt: string;
  lastRunId?: string | null;
  lastRun: StrategyConditionLastRun | null;
}

export interface RunResult {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
  totalScanned: number;
}

export interface RunProgress {
  runId: string;
  status: 'running' | 'queued' | 'completed' | 'failed';
  progressScanned: number;
  progressTotal: number;
  totalHits: number;
  errorMessage: string | null;
}

export interface RunResultDetail {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
}

export interface LastRunStatus {
  conditionId: string;
  freshness: 'fresh' | 'stale' | 'never' | 'running' | 'failed';
  lastRunAt: string | null;
  totalHits: number;
  /** 问题 8：失败原因，刷新页面后仍可展示 */
  errorMessage?: string | null;
}

export interface CreateStrategyConditionDto {
  name: string;
  targetType: 'crypto' | 'a-share';
  conditions: StrategyConditionItem[];
}

export interface UpdateStrategyConditionDto {
  name?: string;
  conditions?: StrategyConditionItem[];
}

export const strategyConditionsApi = {
  create(data: CreateStrategyConditionDto) {
    return post<StrategyCondition>(`${API_BASE}/strategy-conditions`, data);
  },

  findAll(targetType?: string) {
    const url = targetType
      ? `${API_BASE}/strategy-conditions?targetType=${targetType}`
      : `${API_BASE}/strategy-conditions`;
    return request<StrategyCondition[]>(url);
  },

  findOne(id: string) {
    return request<StrategyCondition>(`${API_BASE}/strategy-conditions/${id}`);
  },

  update(id: string, data: UpdateStrategyConditionDto) {
    return put<StrategyCondition>(`${API_BASE}/strategy-conditions/${id}`, data);
  },

  remove(id: string) {
    return del(`${API_BASE}/strategy-conditions/${id}`);
  },

  run(id: string) {
    return post<RunResult>(`${API_BASE}/strategy-conditions/${id}/run`);
  },

  startRun(id: string) {
    return post<{ runId: string; status: 'running' | 'queued' }>(`${API_BASE}/strategy-conditions/${id}/run`);
  },

  getRunProgress(id: string) {
    return request<RunProgress>(`${API_BASE}/strategy-conditions/${id}/run/progress`);
  },

  getRunResult(id: string) {
    return request<RunResultDetail>(`${API_BASE}/strategy-conditions/${id}/run/result`);
  },

  getLastRunStatus() {
    return request<LastRunStatus[]>(`${API_BASE}/strategy-conditions/last-run-status`);
  },
};

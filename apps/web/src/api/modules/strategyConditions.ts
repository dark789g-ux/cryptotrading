import { API_BASE, post, put, del, request } from '../client'

export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
  compareMode?: 'field' | 'value';
}

export interface StrategyCondition {
  id: string;
  name: string;
  userId: string;
  targetType: 'crypto' | 'a-share';
  conditions: StrategyConditionItem[];
  createdAt: string;
  updatedAt: string;
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
};

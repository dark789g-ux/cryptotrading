import { http } from '../http';

export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
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
    return http.post<StrategyCondition>('/strategy-conditions', data);
  },

  findAll(targetType?: string) {
    return http.get<StrategyCondition[]>('/strategy-conditions', {
      params: { targetType },
    });
  },

  findOne(id: string) {
    return http.get<StrategyCondition>(`/strategy-conditions/${id}`);
  },

  update(id: string, data: UpdateStrategyConditionDto) {
    return http.put<StrategyCondition>(`/strategy-conditions/${id}`, data);
  },

  remove(id: string) {
    return http.delete(`/strategy-conditions/${id}`);
  },

  run(id: string) {
    return http.post<RunResult>(`/strategy-conditions/${id}/run`);
  },
};

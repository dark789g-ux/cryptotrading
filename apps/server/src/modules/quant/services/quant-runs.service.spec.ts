import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import {
  QuantRunsService,
  RUNS_FIELD_COL_MAP,
  resolveRunsFilterColumn,
  extractOosMetricsCore,
} from './quant-runs.service';
import { MlModelRunEntity } from '../../../entities/ml/ml-model-run.entity';

describe('QuantRunsService', () => {
  let service: QuantRunsService;
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
  };
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        QuantRunsService,
        { provide: getRepositoryToken(MlModelRunEntity), useValue: repo },
      ],
    }).compile();

    service = moduleRef.get(QuantRunsService);
  });

  describe('FIELD_COL_MAP', () => {
    it('白名单含 model_version / created_at / feature_set_id / artifact_uri', () => {
      expect(RUNS_FIELD_COL_MAP.model_version).toBe('r.model_version');
      expect(RUNS_FIELD_COL_MAP.created_at).toBe('r.created_at');
      expect(RUNS_FIELD_COL_MAP.feature_set_id).toBe('r.feature_set_id');
      expect(RUNS_FIELD_COL_MAP.artifact_uri).toBe('r.artifact_uri');
    });
    it('Object.freeze 不可变 + 未知字段返回 null', () => {
      expect(Object.isFrozen(RUNS_FIELD_COL_MAP)).toBe(true);
      expect(resolveRunsFilterColumn('drop_table')).toBeNull();
      // hyperparams 是 jsonb，不暴露过滤/排序
      expect(resolveRunsFilterColumn('hyperparams')).toBeNull();
      expect(resolveRunsFilterColumn('oos_metrics')).toBeNull();
    });
  });

  describe('list', () => {
    const sampleRow = (): MlModelRunEntity => ({
      id: 'run-1',
      jobId: 'job-1',
      modelVersion: 'lgb-v1-20260517',
      featureSetId: 'fs-1',
      hyperparams: { num_leaves: 63 },
      oosMetrics: {
        'ndcg@5': 0.501,
        'ndcg@10': 0.515,
        ic: 0.042,
        rank_ic: 0.038,
        portfolio_annual_after_cost: 0.187,
      },
      artifactUri: './artifacts/run-1/model.txt',
      reportUri: './artifacts/run-1/report.md',
      shapUri: null,
      createdAt: new Date('2026-05-17T01:02:03Z'),
    });

    it('happy path：合法 filter+sort → andWhere 翻译 + orderBy 经映射 + 分页生效', async () => {
      qb.getManyAndCount.mockResolvedValue([[sampleRow()], 1]);
      const out = await service.list({
        modelVersion: 'lgb-v1-20260517',
        sortField: 'created_at',
        sortDir: 'ASC',
        page: 2,
        pageSize: 10,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('r.model_version = :model_version', {
        model_version: 'lgb-v1-20260517',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('r.created_at', 'ASC');
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(out.total).toBe(1);
      expect(out.items[0].oos_metrics_core).toEqual({
        ndcg_at_5: 0.501,
        ndcg_at_10: 0.515,
        ic: 0.042,
        rank_ic: 0.038,
        portfolio_annual_after_cost: 0.187,
      });
      expect(out.items[0].created_at).toBe('2026-05-17 01:02:03Z');
    });

    it('未传 filter / sort：不调 andWhere，orderBy 回退默认 created_at DESC', async () => {
      await service.list({ page: 1, pageSize: 20 });
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('r.created_at', 'DESC');
    });

    it('空结果：total=0，items=[]', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      const out = await service.list({ page: 1, pageSize: 20 });
      expect(out).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
    });

    it('sortField 未命中 FIELD_COL_MAP：service 必须 warn 并回退 created_at DESC（不允许把 user 字段拼进 SQL）', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      // 通过强转模拟 controller 校验漏过了未知字段（防御层验证）
      await service.list({
        sortField: 'drop_table_users' as any,
        sortDir: 'ASC',
        page: 1,
        pageSize: 20,
      });
      expect(warnSpy).toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('r.created_at', 'DESC');
    });
  });

  describe('findOne', () => {
    it('命中：返回详情 + 暴露 hyperparams / oos_metrics / shap_uri', async () => {
      repo.findOne.mockResolvedValue({
        id: 'r1',
        jobId: 'j1',
        modelVersion: 'v1',
        featureSetId: 'fs',
        hyperparams: { x: 1 },
        oosMetrics: { 'ndcg@10': 0.5 },
        artifactUri: './a',
        reportUri: null,
        shapUri: null,
        createdAt: new Date('2026-05-17T00:00:00Z'),
      } as MlModelRunEntity);

      const out = await service.findOne('r1');
      expect(out.hyperparams).toEqual({ x: 1 });
      expect(out.oos_metrics).toEqual({ 'ndcg@10': 0.5 });
      expect(out.oos_metrics_core.ndcg_at_10).toBe(0.5);
      expect(out.job_id).toBe('j1');
    });

    it('不存在：抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('extractOosMetricsCore', () => {
    it('容忍 `ndcg@5` 与 `ndcg_at_5` 两种命名（演化兼容）', () => {
      expect(extractOosMetricsCore({ 'ndcg@5': 0.5 })).toMatchObject({ ndcg_at_5: 0.5 });
      expect(extractOosMetricsCore({ ndcg_at_5: 0.5 })).toMatchObject({ ndcg_at_5: 0.5 });
    });
    it('缺失 / 非数字 / NaN → null', () => {
      expect(extractOosMetricsCore({})).toEqual({
        ndcg_at_5: null,
        ndcg_at_10: null,
        ic: null,
        rank_ic: null,
        portfolio_annual_after_cost: null,
      });
      expect(extractOosMetricsCore({ ic: 'oops' as any, rank_ic: NaN })).toMatchObject({
        ic: null,
        rank_ic: null,
      });
    });
  });
});

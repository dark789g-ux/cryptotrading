import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import {
  QuantJobsService,
  JOBS_FIELD_COL_MAP,
  resolveJobsFilterColumn,
} from './quant-jobs.service';
import { SseTokenService } from './sse-token.service';
import { MlJobEntity } from '../../../entities/ml/ml-job.entity';
import type { ValidatedCreateJob } from '../dto/create-job.dto';
import type { ValidatedJobQuery } from '../dto/job-query.dto';
import { verifySseToken } from '../realtime/sse-token.util';

/**
 * QuantJobsService 单测：
 *  - create / findOne / list（含 FIELD_COL_MAP 未命中场景）/ cancel / issueSseToken
 *  - SseTokenService 用真实实例（密钥走 ConfigService mock），跨越 service → token 工具的整链路
 *  - 仓库走 jest mock，不连真实 DB
 */
describe('QuantJobsService', () => {
  let service: QuantJobsService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let configGet: jest.Mock;

  const setupModule = async (secretArg?: { value: string | undefined }) => {
    // 用 `{ value }` 包一层，避免「显式传 undefined 也用默认值」的 JS 默认参数陷阱
    const secret = secretArg === undefined ? 'unit-test-secret' : secretArg.value;
    qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = {
      create: jest.fn((e) => e),
      save: jest.fn(async (e) => ({ id: 'job-uuid', ...e })),
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    configGet = jest.fn((k: string) => (k === 'QUANT_SSE_TOKEN_SECRET' ? secret : undefined));
    const config: any = { get: configGet };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        QuantJobsService,
        SseTokenService,
        { provide: getRepositoryToken(MlJobEntity), useValue: repo },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(QuantJobsService);
  };

  beforeEach(async () => {
    await setupModule();
  });

  describe('create', () => {
    it('insert pending job with given params/priority/maxAttempts，createdBy 来自调用方', async () => {
      const dto: ValidatedCreateJob = {
        runType: 'train',
        params: { feature_set_id: 'fs-1', model: 'lgb-lambdarank' },
        priority: 50,
        maxAttempts: 3,
      };
      const out = await service.create(dto, 'user-42');
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          runType: 'train',
          params: { feature_set_id: 'fs-1', model: 'lgb-lambdarank' },
          priority: 50,
          maxAttempts: 3,
          status: 'pending',
          progress: 0,
          attempts: 0,
          cancelRequested: false,
          parentJobId: null,
          createdBy: 'user-42',
        }),
      );
      expect(repo.save).toHaveBeenCalled();
      expect(out.id).toBe('job-uuid');
    });

    it('dto.parentJobId / dto.createdBy 在 controller 未提供 createdBy 时也能透传', async () => {
      const dto: ValidatedCreateJob = {
        runType: 'optuna',
        params: {},
        priority: 100,
        maxAttempts: 1,
        parentJobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        createdBy: 'cron',
      };
      await service.create(dto, null);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          parentJobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          createdBy: 'cron',
        }),
      );
    });
  });

  describe('findOne', () => {
    it('找不到时抛 NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
    it('命中时返回行', async () => {
      const row = { id: 'x', status: 'pending' } as Partial<MlJobEntity>;
      repo.findOne.mockResolvedValue(row);
      await expect(service.findOne('x')).resolves.toBe(row);
    });

    it('详情接口透传完整 warnings 明细（不像 list 那样降级为 count）', async () => {
      const warnings = [
        {
          type: 'factor_window_short' as const,
          ts: '2026-05-23T08:00:00Z',
          factor_id: 'momentum_20d',
          factor_version: 'v1',
          trade_date: '20260520',
          detail: { available: 18, required: 21 },
        },
      ];
      const row = { id: 'w', status: 'success', warnings } as Partial<MlJobEntity>;
      repo.findOne.mockResolvedValue(row);
      const out = await service.findOne('w');
      expect(out.warnings).toEqual(warnings);
    });
  });

  describe('list', () => {
    it('已知字段（status / run_type）走 FIELD_COL_MAP 翻译为 j.status / j.run_type', async () => {
      const dto: ValidatedJobQuery = { status: 'running', runType: 'infer', page: 2, pageSize: 10 };
      qb.getManyAndCount.mockResolvedValue([[{ id: 'a', warnings: [] }], 1]);

      const res = await service.list(dto);

      const whereCalls = qb.andWhere.mock.calls.map((c) => c[0]);
      expect(whereCalls).toContain('j.status = :status');
      expect(whereCalls).toContain('j.run_type = :run_type');
      expect(qb.skip).toHaveBeenCalledWith(10); // (2-1)*10
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(res.items).toEqual([{ id: 'a', warnings_count: 0 }]);
      expect(res.total).toBe(1);
      expect(res.page).toBe(2);
      expect(res.page_size).toBe(10);
    });

    it('list 输出 warnings_count 而非明细：3 条 warnings → count=3，不暴露 items[].warnings', async () => {
      const dto: ValidatedJobQuery = { page: 1, pageSize: 20 };
      qb.getManyAndCount.mockResolvedValue([
        [
          {
            id: 'job-w',
            status: 'success',
            warnings: [
              { type: 'factor_window_short', ts: 't1', factor_id: 'm20' },
              { type: 'factor_window_short', ts: 't2', factor_id: 'm20' },
              { type: 'factor_window_retry_failed', ts: 't3', factor_id: 'm20' },
            ],
          },
        ],
        1,
      ]);
      const res = await service.list(dto);
      expect(res.items[0]).not.toHaveProperty('warnings');
      expect(res.items[0].warnings_count).toBe(3);
    });

    it('list 防御：warnings 为 null（旧行无 default）→ count=0', async () => {
      const dto: ValidatedJobQuery = { page: 1, pageSize: 20 };
      qb.getManyAndCount.mockResolvedValue([[{ id: 'job-null', warnings: null }], 1]);
      const res = await service.list(dto);
      expect(res.items[0].warnings_count).toBe(0);
    });

    it('两个过滤都不传时，andWhere 不应被调用，但 orderBy/分页正常', async () => {
      const dto: ValidatedJobQuery = { page: 1, pageSize: 20 };
      await service.list(dto);
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('j.created_at', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
    });

    it('FIELD_COL_MAP 当前必含 status / run_type / created_by / created_at', () => {
      expect(JOBS_FIELD_COL_MAP.status).toBe('j.status');
      expect(JOBS_FIELD_COL_MAP.run_type).toBe('j.run_type');
      expect(JOBS_FIELD_COL_MAP.created_by).toBe('j.created_by');
      expect(JOBS_FIELD_COL_MAP.created_at).toBe('j.created_at');
    });

    it('resolveJobsFilterColumn：已知字段返回 SQL 列；未知字段返回 null（list 内部据此 warn+skip）', () => {
      expect(resolveJobsFilterColumn('status')).toBe('j.status');
      expect(resolveJobsFilterColumn('run_type')).toBe('j.run_type');
      // 未命中分支：未知字段必须返回 null，避免被拼进 SQL
      expect(resolveJobsFilterColumn('drop_table_users')).toBeNull();
      expect(resolveJobsFilterColumn('')).toBeNull();
      expect(resolveJobsFilterColumn('priority')).toBeNull(); // 不在白名单中（避免误开放为过滤字段）
      // parent_job_id 是 linter 后补加入 MAP 的字段，验证它已被收录
      expect(resolveJobsFilterColumn('parent_job_id')).toBe('j.parent_job_id');
    });

    it('JOBS_FIELD_COL_MAP 不可变（Object.freeze），防止运行时被改写', () => {
      expect(Object.isFrozen(JOBS_FIELD_COL_MAP)).toBe(true);
    });
  });

  describe('cancel', () => {
    it('pending 状态：调用 update({cancel_requested:true}) 并返回最新行', async () => {
      repo.findOne
        .mockResolvedValueOnce({ id: 'j1', status: 'pending' } as Partial<MlJobEntity>)
        .mockResolvedValueOnce({ id: 'j1', status: 'pending', cancelRequested: true } as Partial<MlJobEntity>);
      const out = await service.cancel('j1');
      expect(repo.update).toHaveBeenCalledWith({ id: 'j1' }, { cancelRequested: true });
      expect(out.status).toBe('pending');
    });

    it('终态：不调用 update，直接返回当前行', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'j2', status: 'success' } as Partial<MlJobEntity>);
      const out = await service.cancel('j2');
      expect(repo.update).not.toHaveBeenCalled();
      expect(out.status).toBe('success');
    });

    it('不存在：抛 404', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.cancel('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('issueSseToken', () => {
    it('返回 token 可被 verifySseToken 验证通过；payload 含 job_id / user_id / exp', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'job-xyz', status: 'running' } as Partial<MlJobEntity>);
      const res = await service.issueSseToken('job-xyz', 'user-7');

      expect(res.job_id).toBe('job-xyz');
      expect(res.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      // expires_at 格式：YYYY-MM-DD HH:mm:ssZ（UTC 墙钟）
      expect(res.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);

      const verified = verifySseToken(res.token, 'unit-test-secret');
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.payload.job_id).toBe('job-xyz');
        expect(verified.payload.user_id).toBe('user-7');
        const nowSec = Math.floor(Date.now() / 1000);
        expect(verified.payload.exp).toBeGreaterThan(nowSec);
        // 5 分钟 TTL，留 5s 容差
        expect(verified.payload.exp).toBeLessThanOrEqual(nowSec + 305);
      }
    });

    it('SSE token secret 未配置时抛错', async () => {
      await setupModule({ value: undefined });
      repo.findOne.mockResolvedValueOnce({ id: 'j', status: 'pending' } as Partial<MlJobEntity>);
      await expect(service.issueSseToken('j', 'u')).rejects.toThrow(/secret 未配置/);
    });

    it('job 不存在时抛 404', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.issueSseToken('missing', 'u')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

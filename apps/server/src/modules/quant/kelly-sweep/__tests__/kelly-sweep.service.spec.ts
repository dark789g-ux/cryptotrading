import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KellySweepService, KELLY_SORT_FIELD_MAP, KELLY_META } from '../kelly-sweep.service';
import { KellySweepResult } from '../../../../entities/ml/kelly-sweep-result.entity';
import { MlJobEntity } from '../../../../entities/ml/ml-job.entity';

/**
 * KellySweepService 查询单测。
 * 覆盖：分页/排序/RS 分组；sort 列白名单防注入；group 必填；meta 返回值。
 */

function makeResultRepo() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

function makeJobRepo() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  return {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

describe('KellySweepService', () => {
  let service: KellySweepService;
  let resultRepo: ReturnType<typeof makeResultRepo>;
  let jobRepo: ReturnType<typeof makeJobRepo>;

  beforeEach(async () => {
    resultRepo = makeResultRepo();
    jobRepo = makeJobRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KellySweepService,
        { provide: getRepositoryToken(KellySweepResult), useValue: resultRepo },
        { provide: getRepositoryToken(MlJobEntity), useValue: jobRepo },
      ],
    }).compile();

    service = module.get(KellySweepService);
  });

  // ── getMeta ──────────────────────────────────────────────────────────────────
  describe('getMeta', () => {
    it('返回 base_fields 含 kdj_j', () => {
      const meta = service.getMeta();
      expect(meta.base_fields).toContain('kdj_j');
    });

    it('返回 exit_families 含 fixed_n/tp_sl/trailing/atr_stop', () => {
      const meta = service.getMeta();
      expect(meta.exit_families).toContain('fixed_n');
      expect(meta.exit_families).toContain('tp_sl');
      expect(meta.exit_families).toContain('trailing');
      expect(meta.exit_families).toContain('atr_stop');
    });

    it('rs_benchmarks 不含 industry', () => {
      const meta = service.getMeta();
      expect(meta.rs_benchmarks).not.toContain('industry');
    });

    it('base_fields 共 29 个（与 enumerate.py:57 对齐）', () => {
      expect(KELLY_META.base_fields.length).toBe(29);
    });
  });

  // ── KELLY_SORT_FIELD_MAP 白名单 ───────────────────────────────────────────
  describe('KELLY_SORT_FIELD_MAP', () => {
    it('包含 kelly_valid / n_valid / variant_id / created_at', () => {
      expect(KELLY_SORT_FIELD_MAP['kelly_valid']).toBe('kellyValid');
      expect(KELLY_SORT_FIELD_MAP['n_valid']).toBe('nValid');
      expect(KELLY_SORT_FIELD_MAP['variant_id']).toBe('variantId');
      expect(KELLY_SORT_FIELD_MAP['created_at']).toBe('createdAt');
    });

    it('不包含 job_id（外键，防注入）', () => {
      expect(KELLY_SORT_FIELD_MAP['job_id']).toBeUndefined();
    });

    it('不包含任意注入字符串', () => {
      expect(KELLY_SORT_FIELD_MAP['1;DROP TABLE']).toBeUndefined();
    });
  });

  // ── getSummary ──────────────────────────────────────────────────────────────
  describe('getSummary', () => {
    it('job 不存在 → NotFoundException', async () => {
      jobRepo.findOne.mockResolvedValue(null);
      await expect(service.getSummary('nonexist-uuid')).rejects.toThrow(NotFoundException);
    });

    it('job.runType 非 kelly_sweep → BadRequestException', async () => {
      jobRepo.findOne.mockResolvedValue({ id: 'uuid1', runType: 'train', resultPayload: {} });
      await expect(service.getSummary('uuid1')).rejects.toThrow(BadRequestException);
    });

    it('kelly_sweep job → 返回摘要对象', async () => {
      const job = {
        id: 'uuid1',
        runType: 'kelly_sweep',
        status: 'success',
        progress: 100,
        stage: null,
        params: { base_trigger: { field: 'kdj_j', op: 'lt', value: 0 } },
        resultPayload: { n_rows: 848 },
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
      };
      jobRepo.findOne.mockResolvedValue(job);
      const result = await service.getSummary('uuid1');
      expect(result.id).toBe('uuid1');
      expect(result.result_payload).toEqual({ n_rows: 848 });
      expect(result.run_type).toBe('kelly_sweep');
    });
  });

  // ── getScatter ──────────────────────────────────────────────────────────────
  describe('getScatter', () => {
    it('group 缺失 → BadRequestException', async () => {
      await expect(service.getScatter('uuid1', undefined)).rejects.toThrow(BadRequestException);
    });

    it("group='invalid' → BadRequestException", async () => {
      await expect(service.getScatter('uuid1', 'invalid')).rejects.toThrow(BadRequestException);
    });

    it("group='with_rs' → 调用 find，并映射精简字段", async () => {
      const mockRow = {
        id: '1',
        nValid: 100,
        kellyValid: 0.3,
        isFrontier: true,
        belowFloor: false,
        variantId: 'kdj_j<0',
        exitId: 'fixed_n(n=5)',
      };
      resultRepo.find.mockResolvedValue([mockRow]);
      const pts = await service.getScatter('uuid1', 'with_rs');
      expect(pts).toHaveLength(1);
      expect(pts[0].n_valid).toBe(100);
      expect(pts[0].is_frontier).toBe(true);
      expect(pts[0].variant_id).toBe('kdj_j<0');
    });

    it("group='no_rs' → 也能通过校验", async () => {
      resultRepo.find.mockResolvedValue([]);
      const pts = await service.getScatter('uuid1', 'no_rs');
      expect(pts).toHaveLength(0);
    });
  });

  // ── getTopk ─────────────────────────────────────────────────────────────────
  describe('getTopk', () => {
    it('group 缺失 → BadRequestException', async () => {
      await expect(service.getTopk('uuid1', undefined, 1, 50, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('默认分页 page=1 pageSize=50', async () => {
      resultRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
      const result = await service.getTopk('uuid1', 'with_rs', undefined, undefined, undefined);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
    });

    it('pageSize 超过上限 200 → 截断为 200', async () => {
      resultRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
      const result = await service.getTopk('uuid1', 'with_rs', 1, 999, undefined);
      expect(result.pageSize).toBe(200);
    });

    it('sort 字段非白名单 → 静默回退默认排序，不报错', async () => {
      resultRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
      const result = await service.getTopk('uuid1', 'with_rs', 1, 50, '1;DROP TABLE');
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
    });

    it('sort=kelly_valid:asc → 通过白名单并传给 orderBy', async () => {
      resultRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
      await service.getTopk('uuid1', 'with_rs', 1, 10, 'kelly_valid:asc');
      expect(resultRepo._qb.orderBy).toHaveBeenCalledWith('r.kellyValid', 'ASC', 'NULLS LAST');
    });
  });

  // ── getRows ──────────────────────────────────────────────────────────────────
  describe('getRows', () => {
    it('group 缺失 → BadRequestException', async () => {
      await expect(service.getRows('uuid1', undefined, 1, 50, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('正常分页返回 items/total/page/pageSize', async () => {
      resultRepo._qb.getManyAndCount.mockResolvedValue([[], 42]);
      const result = await service.getRows('uuid1', 'no_rs', 2, 10, undefined);
      expect(result.total).toBe(42);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
    });
  });

  // ── getRow ───────────────────────────────────────────────────────────────────
  describe('getRow', () => {
    it('rowId 不存在 → NotFoundException', async () => {
      resultRepo.findOne.mockResolvedValue(null);
      await expect(service.getRow('uuid1', '999')).rejects.toThrow(NotFoundException);
    });

    it('存在的行 → 返回完整对象', async () => {
      const mockRow = { id: '1', jobId: 'uuid1', variantId: 'test' };
      resultRepo.findOne.mockResolvedValue(mockRow);
      const row = await service.getRow('uuid1', '1');
      expect(row.id).toBe('1');
    });
  });

  // ── getHistory ────────────────────────────────────────────────────────────────
  describe('getHistory', () => {
    it('无 status 过滤 → 不调用 andWhere status', async () => {
      jobRepo._qb.getManyAndCount.mockResolvedValue([[], 5]);
      const result = await service.getHistory(undefined, 1, 50);
      expect(result.total).toBe(5);
      // andWhere for status should not be called
      const andWhereCalls = jobRepo._qb.andWhere.mock.calls;
      const statusCalls = andWhereCalls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('status'),
      );
      expect(statusCalls).toHaveLength(0);
    });

    it('传 status=success → 调用 andWhere status', async () => {
      jobRepo._qb.getManyAndCount.mockResolvedValue([[], 3]);
      await service.getHistory('success', 1, 50);
      const andWhereCalls = jobRepo._qb.andWhere.mock.calls;
      const statusCalls = andWhereCalls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('status'),
      );
      expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('分页参数生效 pageSize=20', async () => {
      jobRepo._qb.getManyAndCount.mockResolvedValue([[], 0]);
      const result = await service.getHistory(undefined, 1, 20);
      expect(result.pageSize).toBe(20);
      expect(jobRepo._qb.skip).toHaveBeenCalledWith(0);
      expect(jobRepo._qb.take).toHaveBeenCalledWith(20);
    });
  });
});

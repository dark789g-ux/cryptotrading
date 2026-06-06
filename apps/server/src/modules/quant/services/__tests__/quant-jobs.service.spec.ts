import { BadRequestException } from '@nestjs/common';
import { QuantJobsService } from '../quant-jobs.service';
import type { ValidatedCreateJob } from '../../dto/create-job.dto';
import type { CoverageSegment } from '../../feature-sets/quant-feature-sets.service';

/**
 * QuantJobsService.create() 单测（spec 03-backend-decoupling.md §建 train 类 job 校验）
 *
 * 覆盖场景：
 *   - prepare 缺 labelRef → 400（由 validateCreateJob 捕捉；此处用正确 dto 验证 service 不再展开）
 *   - train / optuna / seed_avg 缺 feature_set_id/date_range → 400（由 validateCreateJob 捕捉）
 *   - train date_range 越出 R_F 边界 → 400 带提示
 *   - train date_range 落在空洞 → 400 带提示
 *   - train date_range ⊆ R_F 完整连续段 → 通过（写入 DB）
 *   - labels/features/prepare 正确展开 labelRef
 *   - train_e2e 不被接受（dto 层已拒绝，service 层无此分支）
 */

function makeBaseRepo() {
  return {
    create: jest.fn((data: object) => ({ ...data })),
    save: jest.fn(async (entity: object) => ({ id: 'job-uuid', ...entity })),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    update: jest.fn(),
  };
}

function makeLabels() {
  return {
    expandForTraining: jest.fn(),
  };
}

function makeFeatureSets(segments: CoverageSegment[]) {
  return {
    coverage: jest.fn(async (_fsId: string) => segments),
  };
}

function makeSseTokens() {
  return { issueToken: jest.fn() };
}

function makeDto(overrides: Partial<ValidatedCreateJob> & { runType: ValidatedCreateJob['runType'] }): ValidatedCreateJob {
  return {
    params: {},
    priority: 100,
    maxAttempts: 1,
    ...overrides,
  };
}

const EXPANDED_LABEL = {
  base_type: 'fwd_ret',
  base_params: { horizon: 5 },
  classify_mode: 'band',
  classify_params: { eps: 0.003 },
  label_id: 'ret5d',
  label_version: 'v1',
};

describe('QuantJobsService.create() — LABEL_REF_RUN_TYPES（labels/features/prepare）', () => {
  let repo: ReturnType<typeof makeBaseRepo>;
  let labels: ReturnType<typeof makeLabels>;
  let featureSets: ReturnType<typeof makeFeatureSets>;
  let svc: QuantJobsService;

  beforeEach(() => {
    repo = makeBaseRepo();
    labels = makeLabels();
    featureSets = makeFeatureSets([]);
    svc = new QuantJobsService(repo as any, makeSseTokens() as any, labels as any, featureSets as any);
    labels.expandForTraining.mockResolvedValue(EXPANDED_LABEL);
  });

  for (const runType of ['labels', 'features', 'prepare'] as const) {
    it(`${runType}: 有 labelRef → 调 expandForTraining 并写入 params`, async () => {
      const dto = makeDto({
        runType,
        labelRef: { labelId: 'ret5d', labelVersion: 'v1' },
        params: { factor_version: 'v1' },
      });
      const result = await svc.create(dto, 'user-1');
      expect(labels.expandForTraining).toHaveBeenCalledWith('ret5d', 'v1');
      expect(repo.save).toHaveBeenCalled();
      const saved = repo.save.mock.calls[0][0] as Record<string, unknown>;
      expect(saved.params).toMatchObject({ base_type: 'fwd_ret', label_id: 'ret5d' });
    });

    it(`${runType}: coverage() 不被调用`, async () => {
      const dto = makeDto({
        runType,
        labelRef: { labelId: 'ret5d', labelVersion: 'v1' },
      });
      await svc.create(dto, 'user-1');
      expect(featureSets.coverage).not.toHaveBeenCalled();
    });
  }
});

describe('QuantJobsService.create() — FEATURE_SET_RUN_TYPES（train/optuna/seed_avg）', () => {
  const FULL_SEGMENT: CoverageSegment[] = [{ start: '20260101', end: '20260331' }];
  const GAP_SEGMENTS: CoverageSegment[] = [
    { start: '20260101', end: '20260115' },
    { start: '20260201', end: '20260331' },
  ];

  let repo: ReturnType<typeof makeBaseRepo>;
  let labels: ReturnType<typeof makeLabels>;
  let featureSets: { coverage: jest.Mock };
  let svc: QuantJobsService;

  function buildSvc(segments: CoverageSegment[]) {
    repo = makeBaseRepo();
    labels = makeLabels();
    featureSets = makeFeatureSets(segments);
    svc = new QuantJobsService(repo as any, makeSseTokens() as any, labels as any, featureSets as any);
  }

  for (const runType of ['train', 'optuna', 'seed_avg'] as const) {
    describe(`run_type="${runType}"`, () => {
      it('date_range ⊆ R_F 完整连续段 → 通过，不调 expandForTraining', async () => {
        buildSvc(FULL_SEGMENT);
        const dto = makeDto({
          runType,
          params: { feature_set_id: 'fs-001', date_range: '20260101:20260228' },
        });
        const result = await svc.create(dto, 'user-1');
        expect(labels.expandForTraining).not.toHaveBeenCalled();
        expect(featureSets.coverage).toHaveBeenCalledWith('fs-001');
        expect(repo.save).toHaveBeenCalled();
        expect(result).toMatchObject({ runType });
      });

      it('date_range 越出 R_F 上界 → BadRequestException 带提示', async () => {
        buildSvc(FULL_SEGMENT); // 覆盖到 20260331
        const dto = makeDto({
          runType,
          params: { feature_set_id: 'fs-001', date_range: '20260101:20260430' },
        });
        await expect(svc.create(dto, 'user-1')).rejects.toThrow(BadRequestException);
      });

      it('date_range 越出 R_F 下界 → BadRequestException 带提示', async () => {
        buildSvc(FULL_SEGMENT); // 从 20260101 起
        const dto = makeDto({
          runType,
          params: { feature_set_id: 'fs-001', date_range: '20251201:20260131' },
        });
        await expect(svc.create(dto, 'user-1')).rejects.toThrow(BadRequestException);
      });

      it('date_range 跨越空洞（两段之间缺口）→ BadRequestException 带提示', async () => {
        buildSvc(GAP_SEGMENTS); // [20260101,20260115] ∪ [20260201,20260331]
        const dto = makeDto({
          runType,
          // 横跨空洞 20260116-20260131
          params: { feature_set_id: 'fs-001', date_range: '20260110:20260210' },
        });
        await expect(svc.create(dto, 'user-1')).rejects.toThrow(BadRequestException);
      });

      it('feature_matrix 为空（coverage 返回 []）→ BadRequestException', async () => {
        buildSvc([]); // 无已备料数据
        const dto = makeDto({
          runType,
          params: { feature_set_id: 'fs-001', date_range: '20260101:20260131' },
        });
        await expect(svc.create(dto, 'user-1')).rejects.toThrow(BadRequestException);
      });

      it('date_range 精确等于单个连续段 → 通过', async () => {
        buildSvc(FULL_SEGMENT);
        const dto = makeDto({
          runType,
          params: { feature_set_id: 'fs-001', date_range: '20260101:20260331' },
        });
        await expect(svc.create(dto, 'user-1')).resolves.toBeDefined();
      });

      it('date_range 完全落在其中一段内（有空洞但目标段完整覆盖）→ 通过', async () => {
        buildSvc(GAP_SEGMENTS);
        // 选第一段内的子区间
        const dto = makeDto({
          runType,
          params: { feature_set_id: 'fs-001', date_range: '20260105:20260113' },
        });
        await expect(svc.create(dto, 'user-1')).resolves.toBeDefined();
      });
    });
  }
});

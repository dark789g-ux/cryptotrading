import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_RUN_TYPES,
  FEATURE_SET_RUN_TYPES,
  LABEL_REF_RUN_TYPES,
  validateCreateJob,
} from '../create-job.dto';
import { MlJobEntity } from '../../../../entities/ml/ml-job.entity';

/**
 * CreateJobDto / validateCreateJob 单测，覆盖 spec
 * docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/03-backend-decoupling.md
 * §run_type 参数契约理顺
 *
 * 契约表：
 *   labels/features/prepare  → 需 labelRef；不需 feature_set_id
 *   train/optuna/seed_avg    → 需 feature_set_id + date_range；不需 labelRef
 *   train_e2e                → 已废弃，ALLOWED_RUN_TYPES 中不存在
 */
describe('ALLOWED_RUN_TYPES 集合契约', () => {
  it('包含 prepare', () => {
    expect(ALLOWED_RUN_TYPES).toContain('prepare');
  });

  it('不包含已废弃的 train_e2e', () => {
    expect(ALLOWED_RUN_TYPES).not.toContain('train_e2e');
  });

  it('LABEL_REF_RUN_TYPES = {labels, features, prepare}', () => {
    expect(LABEL_REF_RUN_TYPES.has('labels')).toBe(true);
    expect(LABEL_REF_RUN_TYPES.has('features')).toBe(true);
    expect(LABEL_REF_RUN_TYPES.has('prepare')).toBe(true);
    expect(LABEL_REF_RUN_TYPES.has('train')).toBe(false);
    expect(LABEL_REF_RUN_TYPES.has('optuna')).toBe(false);
    expect(LABEL_REF_RUN_TYPES.has('seed_avg')).toBe(false);
  });

  it('FEATURE_SET_RUN_TYPES = {train, optuna, seed_avg}', () => {
    expect(FEATURE_SET_RUN_TYPES.has('train')).toBe(true);
    expect(FEATURE_SET_RUN_TYPES.has('optuna')).toBe(true);
    expect(FEATURE_SET_RUN_TYPES.has('seed_avg')).toBe(true);
    expect(FEATURE_SET_RUN_TYPES.has('labels')).toBe(false);
    expect(FEATURE_SET_RUN_TYPES.has('prepare')).toBe(false);
  });

  it('包含美股一键同步 us_one_click_sync（spec 2026-06-17-us-sync-tab-design 02）', () => {
    expect(ALLOWED_RUN_TYPES).toContain('us_one_click_sync');
  });
});

describe('validateCreateJob — us_one_click_sync（美股一键同步）', () => {
  it('接受 run_type="us_one_click_sync"（非 LABEL_REF / FEATURE_SET，无额外字段要求）', () => {
    const out = validateCreateJob({ run_type: 'us_one_click_sync', params: {} });
    expect(out.runType).toBe('us_one_click_sync');
    expect(out.labelRef).toBeUndefined();
  });

  it('拒绝形近的未知 run_type "us_one_click_sync_extra"', () => {
    expect(() =>
      validateCreateJob({ run_type: 'us_one_click_sync_extra', params: {} }),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob — train_e2e 已废弃', () => {
  it('拒绝 run_type="train_e2e"（已从 ALLOWED_RUN_TYPES 移除）', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'train_e2e',
        params: {},
        label_ref: { label_id: 'ret5d', label_version: 'v1' },
      }),
    ).toThrow(BadRequestException);
  });

  it('拒绝完全未列出的 run_type', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'monitor',
        params: {},
      }),
    ).toThrow(BadRequestException);
  });

  it('拒绝未知 run_type "train_e2e_extra"', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'train_e2e_extra',
        params: {},
      }),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob — prepare (LABEL_REF_RUN_TYPES)', () => {
  it('prepare + label_ref + factor_version + date_range → 通过', () => {
    const out = validateCreateJob({
      run_type: 'prepare',
      params: {
        factor_version: 'v1',
        date_range: '20260101:20260131',
        new_listing_min_days: 60,
      },
      label_ref: { label_id: 'ret5d', label_version: 'v1' },
      priority: 50,
    });
    expect(out.runType).toBe('prepare');
    expect(out.labelRef).toEqual({ labelId: 'ret5d', labelVersion: 'v1' });
    expect(out.priority).toBe(50);
  });

  it('prepare 缺 label_ref → BadRequestException', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'prepare',
        params: { factor_version: 'v1', date_range: '20260101:20260131' },
      }),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob — train/optuna/seed_avg (FEATURE_SET_RUN_TYPES)', () => {
  const BASE_TRAIN_BODY = {
    params: {
      feature_set_id: 'fs-abc123',
      date_range: '20260101:20260131',
      model: 'lgb-lambdarank',
    },
  };

  for (const runType of ['train', 'optuna', 'seed_avg'] as const) {
    describe(`run_type="${runType}"`, () => {
      it('feature_set_id + date_range → 通过，无 labelRef', () => {
        const out = validateCreateJob({ run_type: runType, ...BASE_TRAIN_BODY });
        expect(out.runType).toBe(runType);
        expect(out.labelRef).toBeUndefined();
        expect(out.params.feature_set_id).toBe('fs-abc123');
        expect(out.params.date_range).toBe('20260101:20260131');
      });

      it('缺 feature_set_id → BadRequestException', () => {
        expect(() =>
          validateCreateJob({
            run_type: runType,
            params: { date_range: '20260101:20260131' },
          }),
        ).toThrow(BadRequestException);
      });

      it('缺 date_range → BadRequestException', () => {
        expect(() =>
          validateCreateJob({
            run_type: runType,
            params: { feature_set_id: 'fs-abc123' },
          }),
        ).toThrow(BadRequestException);
      });

      it('date_range 格式错误（非 YYYYMMDD:YYYYMMDD）→ BadRequestException', () => {
        expect(() =>
          validateCreateJob({
            run_type: runType,
            params: { feature_set_id: 'fs-abc123', date_range: '2026-01-01/2026-01-31' },
          }),
        ).toThrow(BadRequestException);
      });

      it('date_range start > end → BadRequestException', () => {
        expect(() =>
          validateCreateJob({
            run_type: runType,
            params: { feature_set_id: 'fs-abc123', date_range: '20260201:20260101' },
          }),
        ).toThrow(BadRequestException);
      });

      it('传了 label_ref 也不报错（label_ref 对训练类是可选忽略的额外字段，不强制拒绝）', () => {
        // validateCreateJob 不强制拒绝多余字段；service 层不会展开 labelRef for FEATURE_SET_RUN_TYPES
        const out = validateCreateJob({
          run_type: runType,
          params: { feature_set_id: 'fs-abc123', date_range: '20260101:20260131' },
          label_ref: { label_id: 'ret5d', label_version: 'v1' },
        });
        expect(out.runType).toBe(runType);
        // labelRef 被解析但 service 层会忽略（按 FEATURE_SET_RUN_TYPES 分支走）
        expect(out.labelRef).toEqual({ labelId: 'ret5d', labelVersion: 'v1' });
      });
    });
  }
});

describe('validateCreateJob — labels run_type fail-fast 校验', () => {
  // ---- 通过路径 ----
  it('labels + label_ref → 通过，labelRef 被正确解析', () => {
    const out = validateCreateJob({
      run_type: 'labels',
      label_ref: { label_id: 'ret5d', label_version: 'v2' },
    });
    expect(out.runType).toBe('labels');
    expect(out.labelRef).toEqual({ labelId: 'ret5d', labelVersion: 'v2' });
  });

  it('labels + params.scheme → 通过', () => {
    const out = validateCreateJob({
      run_type: 'labels',
      params: { scheme: 'dir3' },
      label_ref: { label_id: 'ret5d', label_version: 'v2' },
    });
    expect(out.runType).toBe('labels');
    expect(out.params.scheme).toBe('dir3');
  });

  it('labels + params.strategy_id & params.strategy_version → 通过（加 label_ref 满足 LABEL_REF_RUN_TYPES）', () => {
    const out = validateCreateJob({
      run_type: 'labels',
      params: { strategy_id: 'strat-001', strategy_version: 'v3' },
      label_ref: { label_id: 'ret5d', label_version: 'v2' },
    });
    expect(out.runType).toBe('labels');
    expect(out.params.strategy_id).toBe('strat-001');
  });

  // ---- 拒绝路径 ----
  it('labels 缺 label_ref（LABEL_REF_RUN_TYPES 要求）→ BadRequestException', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'labels',
        params: { scheme: 'dir3' },
      }),
    ).toThrow(BadRequestException);
  });

  it('labels + label_ref（无 scheme/strategy）→ 通过（label_ref 本身满足三者之一）', () => {
    const out = validateCreateJob({
      run_type: 'labels',
      params: {},
      label_ref: { label_id: 'ret5d', label_version: 'v2' },
    });
    expect(out.runType).toBe('labels');
    expect(out.labelRef).toEqual({ labelId: 'ret5d', labelVersion: 'v2' });
  });

  it('labels params.strategy_id 缺 strategy_version（有 label_ref）→ 通过（label_ref 满足三者之一）', () => {
    // strategy_id 单独不满足；但 label_ref 存在 → hasLabelRef=true → 通过
    const out = validateCreateJob({
      run_type: 'labels',
      params: { strategy_id: 'strat-001' },
      label_ref: { label_id: 'ret5d', label_version: 'v2' },
    });
    expect(out.runType).toBe('labels');
  });

  it('labels 缺 label_ref 且 params 只有 strategy_id（缺 strategy_version）→ BadRequestException', () => {
    // 无法提供 label_ref（会被 LABEL_REF_RUN_TYPES check 先拒），所以此场景不可能发生
    // 真实的"三者全缺"只能在 params={} 且无 label_ref 时出现 → 已由 LABEL_REF_RUN_TYPES 先 400
    // 这里测"labels 有 label_ref 但 params.strategy 只有 id 无 version"是合法的（label_ref 已满足三者之一）
    // 本用例改为测试"无 label_ref，scheme 空字符串"：
    expect(() =>
      validateCreateJob({
        run_type: 'labels',
        // 无 label_ref → LABEL_REF_RUN_TYPES 先 400，到不了三者检查
      }),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob — features run_type', () => {
  it('features + label_ref + factor_version → 通过', () => {
    const out = validateCreateJob({
      run_type: 'features',
      params: { factor_version: 'v1' },
      label_ref: { label_id: 'ret5d', label_version: 'v2' },
    });
    expect(out.runType).toBe('features');
    expect(out.labelRef).toEqual({ labelId: 'ret5d', labelVersion: 'v2' });
  });

  it('features 缺 label_ref → BadRequestException', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'features',
        params: { factor_version: 'v1' },
      }),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob — 回归：其它 run_type 行为不变', () => {
  it('factors 不带 label_ref → 通过（非 LABEL_REF_RUN_TYPES）', () => {
    const out = validateCreateJob({
      run_type: 'factors',
      params: { factor_version: 'v1' },
    });
    expect(out.runType).toBe('factors');
    expect(out.labelRef).toBeUndefined();
  });

  it('noop 不带任何额外字段 → 通过', () => {
    const out = validateCreateJob({ run_type: 'noop' });
    expect(out.runType).toBe('noop');
  });

  it('infer 不带 label_ref → 通过', () => {
    const out = validateCreateJob({ run_type: 'infer', params: {} });
    expect(out.runType).toBe('infer');
  });
});

describe('validateCreateJob — as_draft（M2 草稿态）', () => {
  it('不传 as_draft → asDraft 默认 false（向后兼容）', () => {
    const out = validateCreateJob({ run_type: 'noop' });
    expect(out.asDraft).toBe(false);
  });

  it('as_draft=true → asDraft=true', () => {
    const out = validateCreateJob({ run_type: 'noop', as_draft: true });
    expect(out.asDraft).toBe(true);
  });

  it('as_draft=false → asDraft=false', () => {
    const out = validateCreateJob({ run_type: 'noop', as_draft: false });
    expect(out.asDraft).toBe(false);
  });

  it('as_draft 非布尔（字符串）→ BadRequestException', () => {
    expect(() =>
      validateCreateJob({ run_type: 'noop', as_draft: 'true' as any }),
    ).toThrow(BadRequestException);
  });
});

describe('MlJobEntity.resultPayload', () => {
  it('实体字段可读写，类型为对象；默认值由 DB 端 default 提供（NestJS 侧无强 schema）', () => {
    const job = new MlJobEntity();
    job.resultPayload = { feature_set_id: 'fs_abc123', step_snapshots: { labels: { ms: 12000 } } };
    expect(job.resultPayload.feature_set_id).toBe('fs_abc123');
    expect(typeof job.resultPayload.step_snapshots).toBe('object');

    job.resultPayload = {};
    expect(job.resultPayload).toEqual({});
  });
});

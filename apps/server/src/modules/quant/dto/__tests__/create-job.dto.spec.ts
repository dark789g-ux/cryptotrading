import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_RUN_TYPES,
  validateCreateJob,
} from '../create-job.dto';
import { MlJobEntity } from '../../../../entities/ml/ml-job.entity';

/**
 * CreateJobDto / validateCreateJob 单测,覆盖 spec
 * doc/specs/2026-05-23-train-e2e-new-listing-threshold-design/06 文档 §NestJS 单测矩阵:
 *  (1) 接受 run_type='train_e2e' + 完整 params;
 *  (2) 拒绝未知 run_type(如 'train_e2e_extra');
 *  (3) MlJobEntity.resultPayload 字段读写正常(jsonb 透传无强 schema)。
 */
describe('validateCreateJob (train_e2e 扩展)', () => {
  it('ALLOWED_RUN_TYPES 必须包含 train_e2e(D-15 CHECK 同步契约)', () => {
    expect(ALLOWED_RUN_TYPES).toContain('train_e2e');
  });

  it('接受 run_type="train_e2e" + 端到端完整 params', () => {
    const body = {
      run_type: 'train_e2e',
      params: {
        factor_version: 'v1',
        label_scheme: 'strategy-aware',
        new_listing_min_days: 60,
        date_range: '20260101:20260131',
        model: 'lgb-lambdarank',
        walk_forward: true,
        seed: 42,
      },
      priority: 50,
      max_attempts: 1,
    };
    const out = validateCreateJob(body);
    expect(out.runType).toBe('train_e2e');
    // params 透传不做内部 schema 校验(Python worker 负责 _validate_params)
    expect(out.params).toEqual(body.params);
    expect(out.priority).toBe(50);
    expect(out.maxAttempts).toBe(1);
  });

  it('拒绝未知 run_type "train_e2e_extra"(防止笔误绕过 CHECK)', () => {
    expect(() =>
      validateCreateJob({
        run_type: 'train_e2e_extra',
        params: {},
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

  it('train_e2e 不传 params 时,默认 {} 兼容', () => {
    const out = validateCreateJob({ run_type: 'train_e2e' });
    expect(out.runType).toBe('train_e2e');
    expect(out.params).toEqual({});
  });
});

describe('MlJobEntity.resultPayload(D-13)', () => {
  it('实体字段可读写,类型为对象;默认值由 DB 端 default 提供(NestJS 侧无强 schema)', () => {
    const job = new MlJobEntity();
    // 模拟从 DB 反序列化:resultPayload 应为对象
    job.resultPayload = { feature_set_id: 'fs_abc123', step_snapshots: { labels: { ms: 12000 } } };
    expect(job.resultPayload.feature_set_id).toBe('fs_abc123');
    expect(typeof job.resultPayload.step_snapshots).toBe('object');

    // 重新赋值空对象(对应 DB default '{}'::jsonb)
    job.resultPayload = {};
    expect(job.resultPayload).toEqual({});
  });
});

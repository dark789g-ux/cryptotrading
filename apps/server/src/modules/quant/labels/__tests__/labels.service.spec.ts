import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LabelsService } from '../labels.service';
import { LabelDefinitionEntity } from '../../../../entities/ml/label-definition.entity';

/**
 * LabelsService 单测（spec 06-validation-and-testing.md 测试矩阵）：
 *   - CRUD：create / list / findOne / update
 *   - 语义字段不可变：PATCH base_type 被 validateUpdateLabel 拒（由 controller 层调），
 *     此处测 service.update 只接收已校验 dto（DTO 校验单独覆盖）
 *   - expandForTraining：正确展开 + label 不存在 fail-fast + disabled fail-fast
 */

function makeRow(overrides: Partial<LabelDefinitionEntity> = {}): LabelDefinitionEntity {
  return {
    labelId: 'next_day_band05',
    labelVersion: 'v1',
    name: '次日涨跌·横盘±0.5%',
    baseType: 'fwd_ret',
    baseParams: { horizon: 1 },
    classifyMode: 'band',
    classifyParams: { eps: 0.005 },
    description: '次日涨跌，横盘阈值 0.5%',
    enabled: true,
    displayOrder: 0,
    createdAt: new Date('2026-06-05T08:00:00Z'),
    ...overrides,
  } as LabelDefinitionEntity;
}

describe('LabelsService', () => {
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let svc: LabelsService;
  let strategies: { findRaw: jest.Mock };
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(() => {
    qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };
    repo = {
      createQueryBuilder: jest.fn(() => qb),
      findOne: jest.fn(),
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (entity) => entity),
      update: jest.fn(async () => undefined),
    };
    // QuantStrategiesService mock：strategy_aware 标签建/展开时校验引用策略
    strategies = {
      findRaw: jest.fn(),
    };
    svc = new LabelsService(repo as any, strategies as any);
  });

  // ────────── list ──────────

  describe('list', () => {
    it('无 query → 不加 where；按 display_order, label_id 排序', async () => {
      qb.getMany.mockResolvedValue([makeRow()]);
      const out = await svc.list();
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('l.display_order', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('l.label_id', 'ASC');
      expect(out).toHaveLength(1);
      expect(out[0].label_id).toBe('next_day_band05');
      expect(out[0].base_type).toBe('fwd_ret');
      expect(out[0].classify_mode).toBe('band');
    });

    it('enabled=true 过滤', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.list({ enabled: true });
      expect(qb.andWhere).toHaveBeenCalledWith('l.enabled = :enabled', { enabled: true });
    });

    it('base_type=fwd_ret 过滤', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.list({ base_type: 'fwd_ret' });
      expect(qb.andWhere).toHaveBeenCalledWith('l.base_type = :base_type', {
        base_type: 'fwd_ret',
      });
    });

    it('enabled + base_type 联合 → 两条 andWhere', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.list({ enabled: false, base_type: 'strategy_aware' });
      expect(qb.andWhere).toHaveBeenCalledTimes(2);
    });

    it('响应 created_at 格式为 YYYY-MM-DD HH:mm:ssZ', async () => {
      qb.getMany.mockResolvedValue([makeRow()]);
      const out = await svc.list();
      expect(out[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
    });
  });

  // ────────── findOne ──────────

  describe('findOne', () => {
    it('存在 → 返回响应 DTO', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      const out = await svc.findOne('next_day_band05', 'v1');
      expect(out.label_id).toBe('next_day_band05');
      expect(out.label_version).toBe('v1');
      expect(out.base_params).toEqual({ horizon: 1 });
    });

    it('不存在 → NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.findOne('nope', 'v1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────── create ──────────

  describe('create', () => {
    const dto = {
      labelId: 'next_day_band05',
      labelVersion: 'v1',
      name: '次日涨跌·横盘±0.5%',
      baseType: 'fwd_ret',
      baseParams: { horizon: 1 },
      classifyMode: 'band' as const,
      classifyParams: { eps: 0.005 },
      description: null,
      enabled: true,
      displayOrder: 0,
    };

    it('不存在时成功创建，返回响应 DTO', async () => {
      repo.findOne.mockResolvedValue(null); // 不存在 → 可创建
      const saved = makeRow();
      repo.save.mockResolvedValue(saved);

      const out = await svc.create(dto);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(out.label_id).toBe('next_day_band05');
      expect(out.base_type).toBe('fwd_ret');
    });

    it('(label_id, label_version) 已存在 → BadRequestException（冲突）', async () => {
      repo.findOne.mockResolvedValue(makeRow()); // 已存在
      await expect(svc.create(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ── create：strategy_aware 引用校验（spec 04 §6.2）──
  describe('create：strategy_aware 引用出场策略校验', () => {
    const stratDto = {
      labelId: 'strat_label',
      labelVersion: 'v1',
      name: '固定策略收益',
      baseType: 'strategy_aware',
      baseParams: { strategy_id: 'default_exit', strategy_version: 'v1' },
      classifyMode: null,
      classifyParams: {},
      description: null,
      enabled: true,
      displayOrder: 0,
    };

    it('引用策略存在且 enabled=true → 成功创建', async () => {
      repo.findOne.mockResolvedValue(null); // label 不存在 → 可创建
      strategies.findRaw.mockResolvedValue({ enabled: true });
      repo.save.mockResolvedValue(makeRow({ baseType: 'strategy_aware' }));

      const out = await svc.create(stratDto as any);
      expect(strategies.findRaw).toHaveBeenCalledWith('default_exit', 'v1');
      expect(out.label_id).toBeDefined();
    });

    it('引用策略不存在 → 422（UnprocessableEntity）', async () => {
      const { UnprocessableEntityException } = require('@nestjs/common');
      repo.findOne.mockResolvedValue(null);
      strategies.findRaw.mockResolvedValue(null);
      await expect(svc.create(stratDto as any)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('引用策略 enabled=false → 422', async () => {
      const { UnprocessableEntityException } = require('@nestjs/common');
      repo.findOne.mockResolvedValue(null);
      strategies.findRaw.mockResolvedValue({ enabled: false });
      await expect(svc.create(stratDto as any)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ────────── update（语义字段不可变 + 展示字段可改）──────────

  describe('update', () => {
    it('name/description/enabled/display_order 可 PATCH', async () => {
      const existing = makeRow();
      const fresh = makeRow({ name: '新名称', enabled: false, displayOrder: 10 });
      repo.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);

      const out = await svc.update('next_day_band05', 'v1', {
        name: '新名称',
        enabled: false,
        displayOrder: 10,
      });

      expect(repo.update).toHaveBeenCalledTimes(1);
      const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(patch.name).toBe('新名称');
      expect(patch.enabled).toBe(false);
      expect(patch.displayOrder).toBe(10);
      expect(patch).not.toHaveProperty('baseType');
      expect(patch).not.toHaveProperty('baseParams');
      expect(out.name).toBe('新名称');
    });

    it('未传字段保持原值（partial update）', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      await svc.update('next_day_band05', 'v1', { enabled: false });
      const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(patch.enabled).toBe(false);
      expect(patch).not.toHaveProperty('name');
      expect(patch).not.toHaveProperty('description');
      expect(patch).not.toHaveProperty('displayOrder');
    });

    it('行不存在 → NotFoundException（不调 repo.update）', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        svc.update('nope', 'v1', { enabled: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // ────────── validateUpdateLabel（语义字段不可变）──────────

  describe('validateUpdateLabel：语义字段不可变', () => {
    // 注：validateUpdateLabel 在 controller 调用前被调用；此处直接测 DTO 函数
    it('PATCH base_type 被拒（400）', () => {
      const { validateUpdateLabel } = require('../dto/update-label.dto');
      expect(() => validateUpdateLabel({ base_type: 'fwd_ret' })).toThrow(BadRequestException);
    });

    it('PATCH base_params 被拒（400）', () => {
      const { validateUpdateLabel } = require('../dto/update-label.dto');
      expect(() => validateUpdateLabel({ base_params: { horizon: 5 } })).toThrow(
        BadRequestException,
      );
    });

    it('PATCH classify_mode 被拒（400）', () => {
      const { validateUpdateLabel } = require('../dto/update-label.dto');
      expect(() => validateUpdateLabel({ classify_mode: 'band' })).toThrow(BadRequestException);
    });

    it('PATCH classify_params 被拒（400）', () => {
      const { validateUpdateLabel } = require('../dto/update-label.dto');
      expect(() => validateUpdateLabel({ classify_params: { eps: 0.01 } })).toThrow(
        BadRequestException,
      );
    });

    it('PATCH name（展示字段）→ 通过', () => {
      const { validateUpdateLabel } = require('../dto/update-label.dto');
      expect(() => validateUpdateLabel({ name: '新名称' })).not.toThrow();
    });
  });

  // ────────── expandForTraining ──────────

  describe('expandForTraining', () => {
    it('enabled=true 的 label → 正确展开明文字段', async () => {
      repo.findOne.mockResolvedValue(
        makeRow({
          labelId: 'next_day_band05',
          labelVersion: 'v1',
          baseType: 'fwd_ret',
          baseParams: { horizon: 1 },
          classifyMode: 'band',
          classifyParams: { eps: 0.005 },
          enabled: true,
        }),
      );

      const result = await svc.expandForTraining('next_day_band05', 'v1');

      expect(result.base_type).toBe('fwd_ret');
      expect(result.base_params).toEqual({ horizon: 1 });
      expect(result.classify_mode).toBe('band');
      expect(result.classify_params).toEqual({ eps: 0.005 });
      expect(result.label_id).toBe('next_day_band05');
      expect(result.label_version).toBe('v1');
    });

    it('classify_mode=null 时也能展开（连续标签）', async () => {
      repo.findOne.mockResolvedValue(
        makeRow({
          classifyMode: null,
          classifyParams: {},
        }),
      );
      const result = await svc.expandForTraining('next_day_band05', 'v1');
      expect(result.classify_mode).toBeNull();
    });

    it('label 不存在 → fail-fast BadRequestException（禁止静默回退默认）', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.expandForTraining('unknown_label', 'v1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('label enabled=false → fail-fast BadRequestException', async () => {
      repo.findOne.mockResolvedValue(makeRow({ enabled: false }));
      await expect(svc.expandForTraining('next_day_band05', 'v1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('label 不存在的错误信息包含 label_id@label_version', async () => {
      repo.findOne.mockResolvedValue(null);
      let caught: unknown;
      try {
        await svc.expandForTraining('missing_label', 'v99');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const msg = (caught as BadRequestException).message;
      expect(msg).toContain('missing_label');
      expect(msg).toContain('v99');
    });

    it('enabled=false 的错误信息提及 enabled=false', async () => {
      repo.findOne.mockResolvedValue(makeRow({ enabled: false }));
      let caught: unknown;
      try {
        await svc.expandForTraining('next_day_band05', 'v1');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const msg = (caught as BadRequestException).message;
      expect(msg).toContain('enabled=false');
    });
  });

  // ────────── getBaseTypes ──────────

  describe('getBaseTypes', () => {
    it('返回 base_types 和 classify_modes 枚举', () => {
      const result = svc.getBaseTypes();
      expect(result.base_types).toContain('fwd_ret');
      expect(result.base_types).toContain('strategy_aware');
      expect(result.classify_modes).toContain('band');
      expect(result.classify_modes).toContain('tercile');
      expect(result.classify_modes).toContain('custom');
    });
  });
});

// ────────── validateCreateLabel 组合校验 ──────────

describe('validateCreateLabel：组合校验', () => {
  const { validateCreateLabel } = require('../dto/create-label.dto');

  const base = {
    label_id: 'test_label',
    label_version: 'v1',
    name: '测试标签',
  };

  describe('base_type=fwd_ret', () => {
    it('horizon ≥ 1 整数 → 通过', () => {
      expect(() =>
        validateCreateLabel({ ...base, base_type: 'fwd_ret', base_params: { horizon: 1 } }),
      ).not.toThrow();
    });

    it('horizon=0 → 400', () => {
      expect(() =>
        validateCreateLabel({ ...base, base_type: 'fwd_ret', base_params: { horizon: 0 } }),
      ).toThrow(BadRequestException);
    });

    it('horizon 缺失 → 400', () => {
      expect(() =>
        validateCreateLabel({ ...base, base_type: 'fwd_ret', base_params: {} }),
      ).toThrow(BadRequestException);
    });

    it('horizon=5 → 通过', () => {
      expect(() =>
        validateCreateLabel({ ...base, base_type: 'fwd_ret', base_params: { horizon: 5 } }),
      ).not.toThrow();
    });

    it('horizon=1.5（非整数）→ 400', () => {
      expect(() =>
        validateCreateLabel({ ...base, base_type: 'fwd_ret', base_params: { horizon: 1.5 } }),
      ).toThrow(BadRequestException);
    });
  });

  describe('base_type=strategy_aware（引用出场策略定义）', () => {
    it('合法 {strategy_id, strategy_version} → 通过（形状校验，引用完整性在 service）', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'strategy_aware',
          base_params: { strategy_id: 'default_exit', strategy_version: 'v1' },
        }),
      ).not.toThrow();
    });

    it('strategy_id 缺失 → 400', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'strategy_aware',
          base_params: { strategy_version: 'v1' },
        }),
      ).toThrow(BadRequestException);
    });

    it('strategy_id 含大写（不匹配 /^[a-z0-9_]+$/）→ 400', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'strategy_aware',
          base_params: { strategy_id: 'Default_Exit', strategy_version: 'v1' },
        }),
      ).toThrow(BadRequestException);
    });

    it('strategy_version 格式非法（不匹配 /^v\\d+$/）→ 400', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'strategy_aware',
          base_params: { strategy_id: 'default_exit', strategy_version: '1' },
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('classify_mode=band', () => {
    it('eps > 0 → 通过', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
          classify_mode: 'band',
          classify_params: { eps: 0.005 },
        }),
      ).not.toThrow();
    });

    it('eps=0 → 400（须为正数）', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
          classify_mode: 'band',
          classify_params: { eps: 0 },
        }),
      ).toThrow(BadRequestException);
    });

    it('eps 缺失 → 400', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
          classify_mode: 'band',
          classify_params: {},
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('classify_mode=tercile', () => {
    it('无额外参数 → 通过', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
          classify_mode: 'tercile',
        }),
      ).not.toThrow();
    });
  });

  describe('classify_mode=null（连续）', () => {
    it('不传 classify_mode → 通过', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
        }),
      ).not.toThrow();
    });
  });

  describe('base_type 枚举', () => {
    it('非法 base_type → 400', () => {
      expect(() =>
        validateCreateLabel({ ...base, base_type: 'unknown_type', base_params: {} }),
      ).toThrow(BadRequestException);
    });
  });

  describe('classify_mode 枚举', () => {
    it('非法 classify_mode → 400', () => {
      expect(() =>
        validateCreateLabel({
          ...base,
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
          classify_mode: 'unknown_mode',
        }),
      ).toThrow(BadRequestException);
    });
  });
});

import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { QuantStrategiesService } from '../strategies.service';
import { validateUpdateStrategy } from '../dto/update-strategy.dto';
import { StrategyDefinitionEntity } from '../../../../entities/ml/strategy-definition.entity';

/**
 * QuantStrategiesService 单测（spec 04 §5 + .claude/rules/database-sql.md）：
 *   - create：落库前再校验 exit_rules / PK 冲突 → 409 / 成功
 *   - update：仅改展示字段、不存在 → 404
 *   - findOne：不存在 → 404
 *   - validateUpdateStrategy：语义字段（exit_rules / strategy_id / strategy_version）→ 422
 *   ⚠ list/findOne 的水合正确性靠真机集成验证（mock QB 验不出，见 rules）。
 */

const VALID_RULES = [
  { type: 'stop_loss', params: { pct: 0.08 } },
  { type: 'max_hold', params: { days: 20 } },
];

function makeRow(overrides: Partial<StrategyDefinitionEntity> = {}): StrategyDefinitionEntity {
  return {
    strategyId: 'default_exit',
    strategyVersion: 'v1',
    name: '默认出场策略',
    exitRules: VALID_RULES,
    description: '止损-8% / 最大持仓20日',
    enabled: true,
    displayOrder: 10,
    createdAt: new Date('2026-06-06T08:00:00Z'),
    ...overrides,
  } as StrategyDefinitionEntity;
}

describe('QuantStrategiesService', () => {
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
  };
  let svc: QuantStrategiesService;

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
    svc = new QuantStrategiesService(repo as any);
  });

  // ── list ──
  describe('list', () => {
    it('无 query → 不加 where；按 display_order, strategy_id, strategy_version 排序', async () => {
      qb.getMany.mockResolvedValue([makeRow()]);
      const out = await svc.list();
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('s.display_order', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('s.strategy_id', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('s.strategy_version', 'ASC');
      expect(out[0].strategy_id).toBe('default_exit');
      expect(out[0].exit_rules).toEqual(VALID_RULES);
    });

    it('enabled=true 过滤', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.list({ enabled: true });
      expect(qb.andWhere).toHaveBeenCalledWith('s.enabled = :enabled', { enabled: true });
    });

    it('created_at 格式 YYYY-MM-DD HH:mm:ssZ', async () => {
      qb.getMany.mockResolvedValue([makeRow()]);
      const out = await svc.list();
      expect(out[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('存在 → 响应 DTO', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      const out = await svc.findOne('default_exit', 'v1');
      expect(out.strategy_id).toBe('default_exit');
      expect(out.exit_rules).toEqual(VALID_RULES);
    });

    it('不存在 → 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.findOne('nope', 'v1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── create ──
  describe('create', () => {
    const dto = {
      strategyId: 'my_exit',
      strategyVersion: 'v1',
      name: '我的策略',
      exitRules: VALID_RULES,
      description: null,
      enabled: true,
      displayOrder: 0,
    };

    it('不存在时成功创建', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.save.mockResolvedValue(makeRow({ strategyId: 'my_exit' }));
      const out = await svc.create(dto as any);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(out.strategy_id).toBe('my_exit'); // save 返回的实体
    });

    it('PK 冲突 → 409（ConflictException），不落库', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      await expect(svc.create(dto as any)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('落库前再校验：exitRules 缺 max_hold → 422，不查重不落库', async () => {
      const bad = { ...dto, exitRules: [{ type: 'stop_loss', params: { pct: 0.08 } }] };
      await expect(svc.create(bad as any)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ── update（仅展示字段）──
  describe('update', () => {
    it('name/enabled/display_order 可 PATCH，不含语义字段', async () => {
      const existing = makeRow();
      const fresh = makeRow({ name: '新名', enabled: false, displayOrder: 5 });
      repo.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);

      const out = await svc.update('default_exit', 'v1', {
        name: '新名',
        enabled: false,
        displayOrder: 5,
      });

      const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(patch.name).toBe('新名');
      expect(patch.enabled).toBe(false);
      expect(patch.displayOrder).toBe(5);
      expect(patch).not.toHaveProperty('exitRules');
      expect(patch).not.toHaveProperty('strategyId');
      expect(out.name).toBe('新名');
    });

    it('未传字段保持原值（partial）', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      await svc.update('default_exit', 'v1', { enabled: false });
      const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(patch).toEqual({ enabled: false });
    });

    it('行不存在 → 404（不调 repo.update）', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.update('nope', 'v1', { enabled: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // ── findRaw（供 labels 引用校验）──
  describe('findRaw', () => {
    it('存在 → 原始实体', async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      const out = await svc.findRaw('default_exit', 'v1');
      expect(out).toBe(row);
    });

    it('不存在 → null（不抛）', async () => {
      repo.findOne.mockResolvedValue(null);
      const out = await svc.findRaw('nope', 'v1');
      expect(out).toBeNull();
    });
  });

  // ── getExitRuleTypes ──
  describe('getExitRuleTypes', () => {
    it('返回 { items } 含 5 种 type', () => {
      const { items } = svc.getExitRuleTypes();
      expect(items.map((m) => m.type).sort()).toEqual(
        ['ma_break', 'max_hold', 'stop_loss', 'take_profit', 'trailing_stop'].sort(),
      );
    });
  });
});

// ── validateUpdateStrategy：语义字段不可变 ──
describe('validateUpdateStrategy：语义字段不可变（422）', () => {
  it('PATCH exit_rules 被拒 → 422', () => {
    expect(() => validateUpdateStrategy({ exit_rules: [] })).toThrow(UnprocessableEntityException);
  });

  it('PATCH strategy_id 被拒 → 422', () => {
    expect(() => validateUpdateStrategy({ strategy_id: 'x' })).toThrow(UnprocessableEntityException);
  });

  it('PATCH strategy_version 被拒 → 422', () => {
    expect(() => validateUpdateStrategy({ strategy_version: 'v2' })).toThrow(
      UnprocessableEntityException,
    );
  });

  it('PATCH name（展示字段）→ 通过', () => {
    expect(() => validateUpdateStrategy({ name: '新名' })).not.toThrow();
  });

  it('PATCH 全部展示字段 → 通过且映射驼峰', () => {
    const out = validateUpdateStrategy({
      name: 'n',
      description: 'd',
      enabled: false,
      display_order: 3,
    });
    expect(out).toEqual({ name: 'n', description: 'd', enabled: false, displayOrder: 3 });
  });

  it('display_order 越界 → 400', () => {
    const { BadRequestException } = require('@nestjs/common');
    expect(() => validateUpdateStrategy({ display_order: 10000 })).toThrow(BadRequestException);
  });
});

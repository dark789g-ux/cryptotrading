import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FactorsService, PIT_WINDOW_COEFFICIENT } from '../factors.service';
import { FactorDefinitionEntity } from '../../../../entities/ml/factor-definition.entity';

/**
 * FactorsService 单测：
 *   - listFactors 过滤 enabled / category 经 QueryBuilder 拼装
 *   - listCategories distinct
 *   - findOne 不存在 → NotFoundException
 *   - update 写 updated_at / updated_by；未传字段保持原值；不存在 → 404
 */
function makeRow(overrides: Partial<FactorDefinitionEntity> = {}): FactorDefinitionEntity {
  return {
    factorId: 'momentum_20d',
    factorVersion: 'v1',
    description: '20 日动量',
    formula: 'close_adj(T) / close_adj(T-20) - 1',
    dataSource: ['raw.daily_quote'],
    category: 'price',
    pitWindowDays: 42,
    minTradeDays: 21,
    pitAnchor: 'trade_date',
    enabled: true,
    displayOrder: 100,
    updatedAt: new Date('2026-05-23T08:00:00Z'),
    updatedBy: null,
    ...overrides,
  } as FactorDefinitionEntity;
}

describe('FactorsService', () => {
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let svc: FactorsService;
  let qb: {
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(() => {
    qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(),
    };
    repo = {
      createQueryBuilder: jest.fn(() => qb),
      findOne: jest.fn(),
      update: jest.fn(async () => undefined),
    };
    svc = new FactorsService(repo as any);
  });

  describe('listFactors', () => {
    it('无 query → 不加 where；按 display_order, factor_id 排序', async () => {
      qb.getMany.mockResolvedValue([makeRow()]);
      const out = await svc.listFactors();
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('f.display_order', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('f.factor_id', 'ASC');
      expect(out).toHaveLength(1);
      expect(out[0].factor_id).toBe('momentum_20d');
      expect(out[0].pit_window_days).toBe(42);
      expect(out[0].min_trade_days).toBe(21);
      expect(out[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
    });

    it('enabled=true 过滤 → 拼 enabled = true', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.listFactors({ enabled: true });
      expect(qb.andWhere).toHaveBeenCalledWith('f.enabled = :enabled', { enabled: true });
    });

    it('category=price 过滤 → 拼 category = :category', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.listFactors({ category: 'price' });
      expect(qb.andWhere).toHaveBeenCalledWith('f.category = :category', { category: 'price' });
    });

    it('enabled + category 联合 → 两条 andWhere', async () => {
      qb.getMany.mockResolvedValue([]);
      await svc.listFactors({ enabled: false, category: 'industry' });
      expect(qb.andWhere).toHaveBeenCalledTimes(2);
    });
  });

  describe('listCategories', () => {
    it('distinct → 返回字符串数组（去 null / 空串）', async () => {
      qb.getRawMany.mockResolvedValue([
        { category: 'price' },
        { category: 'industry' },
        { category: '' },
      ]);
      const out = await svc.listCategories();
      expect(out).toEqual(['price', 'industry']);
    });
  });

  describe('findOne', () => {
    it('存在 → 返回响应 DTO', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      const out = await svc.findOne('momentum_20d', 'v1');
      expect(out.factor_id).toBe('momentum_20d');
    });

    it('不存在 → NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.findOne('nope', 'v1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('写入 updated_at = NOW、updated_by = userId（dto 误传也被覆盖）', async () => {
      const existing = makeRow();
      const fresh = makeRow({
        description: '新描述',
        updatedAt: new Date('2026-05-23T09:00:00Z'),
        updatedBy: 'user-1',
      });
      repo.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);

      const before = Date.now();
      const out = await svc.update(
        'momentum_20d',
        'v1',
        { description: '新描述' },
        'user-1',
      );
      const after = Date.now();

      expect(repo.update).toHaveBeenCalledTimes(1);
      const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(patch.description).toBe('新描述');
      expect(patch.updatedBy).toBe('user-1');
      expect(patch.updatedAt).toBeInstanceOf(Date);
      expect((patch.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect((patch.updatedAt as Date).getTime()).toBeLessThanOrEqual(after);
      expect(out.description).toBe('新描述');
      expect(out.updated_by).toBe('user-1');
    });

    it('未传字段保持原值（partial update：repo.update 只收到传的字段）', async () => {
      repo.findOne.mockResolvedValue(makeRow());
      await svc.update('momentum_20d', 'v1', { enabled: false }, 'u');
      const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(patch.enabled).toBe(false);
      expect(patch).not.toHaveProperty('description');
      expect(patch).not.toHaveProperty('pitWindowDays');
      expect(patch).not.toHaveProperty('category');
    });

    it('行不存在 → NotFoundException（不调 repo.update）', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        svc.update('nope', 'v1', { enabled: true }, 'u'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    /**
     * PIT 窗口护门跨字段校验：pit_window_days >= ceil(min_trade_days × 2.0)。
     *
     * 校验仅在 dto 显式包含 pit_window_days 时触发，未传不触发。
     * 不足时抛 BadRequestException 且 response.code === 'PIT_WINDOW_TOO_SMALL'。
     */
    describe('pit_window 跨字段校验', () => {
      it('pit_window < required → BadRequestException(code=PIT_WINDOW_TOO_SMALL)，不调 repo.update', async () => {
        // minTradeDays=21，required=42；传 41 应被拒
        repo.findOne.mockResolvedValueOnce(makeRow({ minTradeDays: 21, pitWindowDays: 42 }));
        let caught: unknown;
        try {
          await svc.update('momentum_20d', 'v1', { pitWindowDays: 41 }, 'u');
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(BadRequestException);
        const resp = (caught as BadRequestException).getResponse() as {
          code?: string;
          detail?: { declared: number; required: number; min_trade_days: number };
        };
        expect(resp.code).toBe('PIT_WINDOW_TOO_SMALL');
        expect(resp.detail).toEqual({ declared: 41, required: 42, min_trade_days: 21 });
        expect(repo.update).not.toHaveBeenCalled();
      });

      it('pit_window === required → 成功（边界值 ceil(21×2)=42）', async () => {
        const existing = makeRow({ minTradeDays: 21, pitWindowDays: 42 });
        const fresh = makeRow({ minTradeDays: 21, pitWindowDays: 42 });
        repo.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);
        await expect(
          svc.update('momentum_20d', 'v1', { pitWindowDays: 42 }, 'u'),
        ).resolves.toBeDefined();
        expect(repo.update).toHaveBeenCalled();
      });

      it('pit_window > required → 成功', async () => {
        const existing = makeRow({ minTradeDays: 21, pitWindowDays: 42 });
        const fresh = makeRow({ minTradeDays: 21, pitWindowDays: 60 });
        repo.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);
        await svc.update('momentum_20d', 'v1', { pitWindowDays: 60 }, 'u');
        const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
        expect(patch.pitWindowDays).toBe(60);
      });

      it('PATCH 不含 pit_window_days → 不触发跨字段校验（仅改 description 不影响窗口）', async () => {
        // existing 的 pit_window_days=10 < required=42 也不报错，因为 dto 没传
        const existing = makeRow({ minTradeDays: 21, pitWindowDays: 10 });
        const fresh = makeRow({ minTradeDays: 21, pitWindowDays: 10, description: '新描述' });
        repo.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(fresh);
        await expect(
          svc.update('momentum_20d', 'v1', { description: '新描述' }, 'u'),
        ).resolves.toBeDefined();
        expect(repo.update).toHaveBeenCalled();
        const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
        expect(patch).not.toHaveProperty('pitWindowDays');
      });

      it('PIT_WINDOW_COEFFICIENT 当前为 2.0（与 Python constants.py 同步）', () => {
        expect(PIT_WINDOW_COEFFICIENT).toBe(2.0);
      });

      it('min_trade_days 非整数（如 13）→ ceil 后 required=26', async () => {
        // 边界场景：未来若 min_trade_days 改为 13，ceil(13×2.0)=26
        repo.findOne.mockResolvedValueOnce(makeRow({ minTradeDays: 13, pitWindowDays: 30 }));
        let caught: unknown;
        try {
          await svc.update('rsi_14', 'v1', { pitWindowDays: 25 }, 'u');
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(BadRequestException);
        const resp = (caught as BadRequestException).getResponse() as {
          detail?: { required: number };
        };
        expect(resp.detail?.required).toBe(26);
      });
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  QuantQualityService,
  QUALITY_FIELD_COL_MAP,
  resolveQualityFilterColumn,
  computeLowerTradeDate,
} from './quant-quality.service';
import { MlQualityReportEntity } from '../../../entities/ml/ml-quality-report.entity';

describe('QuantQualityService', () => {
  let service: QuantQualityService;
  let repo: { createQueryBuilder: jest.Mock };
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        QuantQualityService,
        { provide: getRepositoryToken(MlQualityReportEntity), useValue: repo },
      ],
    }).compile();

    service = moduleRef.get(QuantQualityService);
  });

  describe('FIELD_COL_MAP', () => {
    it('白名单含 trade_date / level / rule / created_at', () => {
      expect(QUALITY_FIELD_COL_MAP.trade_date).toBe('q.trade_date');
      expect(QUALITY_FIELD_COL_MAP.level).toBe('q.level');
      expect(QUALITY_FIELD_COL_MAP.rule).toBe('q.rule');
      expect(QUALITY_FIELD_COL_MAP.created_at).toBe('q.created_at');
    });
    it('Object.freeze 不可变 + 未知字段返回 null', () => {
      expect(Object.isFrozen(QUALITY_FIELD_COL_MAP)).toBe(true);
      expect(resolveQualityFilterColumn('drop_table_users')).toBeNull();
      // detail 是 jsonb，禁止暴露过滤排序
      expect(resolveQualityFilterColumn('detail')).toBeNull();
      expect(resolveQualityFilterColumn('')).toBeNull();
    });
  });

  describe('getByDate', () => {
    it('happy path：按 trade_date 过滤 + level 严重程度 CASE 排序 + created_at DESC', async () => {
      qb.getMany.mockResolvedValue([
        {
          id: '1',
          tradeDate: '20260517',
          level: 'critical',
          rule: 'null_violation',
          detail: { table: 'raw.daily_quote', column: 'open', violation_count: 3 },
          createdAt: new Date('2026-05-17T01:02:03Z'),
        },
      ] as unknown as MlQualityReportEntity[]);

      const out = await service.getByDate('20260517');
      expect(qb.where).toHaveBeenCalledWith('q.trade_date = :tradeDate', {
        tradeDate: '20260517',
      });
      // CASE 排序串内不允许含 user input；用字面量
      const orderByArg = String(qb.orderBy.mock.calls[0][0]);
      expect(orderByArg).toContain("CASE q.level WHEN 'critical' THEN 0");
      expect(qb.addOrderBy).toHaveBeenCalledWith('q.created_at', 'DESC');
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        id: '1',
        trade_date: '20260517',
        level: 'critical',
        rule: 'null_violation',
        detail: { table: 'raw.daily_quote', column: 'open', violation_count: 3 },
        created_at: '2026-05-17 01:02:03Z',
      });
    });

    it('空结果：当日无质量事件 → []', async () => {
      qb.getMany.mockResolvedValue([]);
      const out = await service.getByDate('20260517');
      expect(out).toEqual([]);
    });

    it('传 levels：用 = ANY(:levels::text[]) 过滤（spec M3 §5 `?level=warn,critical`）', async () => {
      qb.getMany.mockResolvedValue([]);
      await service.getByDate('20260517', ['warn', 'critical']);
      const anyCall = qb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('= ANY(:levels::text[])'),
      );
      expect(anyCall).toBeTruthy();
      expect(anyCall![1]).toEqual({ levels: ['warn', 'critical'] });
    });

    it('未传 levels（或空数组）：不调用 andWhere', async () => {
      qb.getMany.mockResolvedValue([]);
      await service.getByDate('20260517');
      const anyCall = qb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('= ANY(:levels::text[])'),
      );
      expect(anyCall).toBeUndefined();
    });
  });

  describe('getRecent', () => {
    it('happy path：按 days 计算下界 + 不传 levels 不加 level 过滤', async () => {
      qb.getMany.mockResolvedValue([]);
      await service.getRecent({ days: 7 });

      const whereCall = qb.where.mock.calls[0];
      expect(whereCall[0]).toBe('q.trade_date >= :lowerBound');
      expect(whereCall[1].lowerBound).toMatch(/^\d{8}$/);

      // 不传 levels 时不应有 = ANY 子句
      const anyCall = qb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('= ANY(:levels::text[])'),
      );
      expect(anyCall).toBeUndefined();
    });

    it('传 levels：用 = ANY(:levels::text[]) 而非 IN(...) （CLAUDE.md NOT DO 第 1 条：数组与列类型对齐）', async () => {
      qb.getMany.mockResolvedValue([]);
      await service.getRecent({ days: 30, levels: ['warn', 'critical'] });

      const anyCall = qb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('= ANY(:levels::text[])'),
      );
      expect(anyCall).toBeTruthy();
      expect(anyCall![1]).toEqual({ levels: ['warn', 'critical'] });
    });

    it('空结果：最近 N 日无事件 → []', async () => {
      qb.getMany.mockResolvedValue([]);
      const out = await service.getRecent({ days: 7, levels: ['warn'] });
      expect(out).toEqual([]);
    });

    it('多版本对照"无串扰"语义化验证：同日多 model_version 的 quality_reports 互不混淆（按 trade_date 索引取，所有 model 共享一份质量门禁数据，这条属于跨表共识）', async () => {
      // quality_reports 表不含 model_version 列（schema §4.3）；本测试验证 service 不会因此泄露 model_version
      qb.getMany.mockResolvedValue([
        {
          id: '10',
          tradeDate: '20260517',
          level: 'warn',
          rule: 'feature_drift_psi',
          detail: { model_version: 'v1', psi: 0.3 },
          createdAt: new Date('2026-05-17T00:00:00Z'),
        },
        {
          id: '11',
          tradeDate: '20260517',
          level: 'warn',
          rule: 'feature_drift_psi',
          detail: { model_version: 'v2', psi: 0.4 },
          createdAt: new Date('2026-05-17T00:00:01Z'),
        },
      ] as unknown as MlQualityReportEntity[]);

      const out = await service.getByDate('20260517');
      // detail 原样回传，便于前端按 model_version 自行分桶；service 不做合并
      expect(out.map((r) => (r.detail as any).model_version)).toEqual(['v1', 'v2']);
    });
  });

  describe('computeLowerTradeDate', () => {
    it('按 UTC 回拨 days 天，返回 YYYYMMDD', () => {
      const ref = new Date('2026-05-17T12:00:00Z');
      expect(computeLowerTradeDate(7, ref)).toBe('20260510');
      expect(computeLowerTradeDate(0, ref)).toBe('20260517');
      // 跨月
      expect(computeLowerTradeDate(20, new Date('2026-05-05T00:00:00Z'))).toBe('20260415');
    });
  });
});

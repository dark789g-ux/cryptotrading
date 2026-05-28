import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  QuantScoresService,
  SCORES_FIELD_COL_MAP,
  resolveScoresFilterColumn,
} from './quant-scores.service';
import { MlScoreDailyEntity } from '../../../entities/ml/ml-score-daily.entity';
import { MlModelRunEntity } from '../../../entities/ml/ml-model-run.entity';
import { AShareSymbolEntity } from '../../../entities/a-share/a-share-symbol.entity';

/**
 * QuantScoresService 单测：
 *  - getDailyTopK：FIELD_COL_MAP 翻译 + 索引列排序 + limit
 *  - getTimeSeries：日期区间过滤
 *  - getModelVersions：从 model_runs 抽 distinct
 *  - compareModels：多版本数组参数 + 内存分组（验证"无串扰"）
 *  - FIELD_COL_MAP 不可变 / 未知字段返回 null
 */
describe('QuantScoresService', () => {
  let service: QuantScoresService;
  let scoresRepo: { createQueryBuilder: jest.Mock };
  let runsRepo: { createQueryBuilder: jest.Mock };
  let scoresQb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    limit: jest.Mock;
    offset: jest.Mock;
    select: jest.Mock;
    clone: jest.Mock;
    getMany: jest.Mock;
    getRawOne: jest.Mock;
  };
  let runsQb: {
    select: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getRawMany: jest.Mock;
    getRawOne: jest.Mock;
  };
  let symbolsRepo: { find: jest.Mock };

  beforeEach(async () => {
    scoresQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      clone: jest.fn(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ cnt: '0' }),
    };
    // clone 返回同一个 mock self，便于断言所有链式调用
    scoresQb.clone.mockImplementation(() => scoresQb);
    runsQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue(undefined),
    };
    scoresRepo = { createQueryBuilder: jest.fn().mockReturnValue(scoresQb) };
    runsRepo = { createQueryBuilder: jest.fn().mockReturnValue(runsQb) };
    // 默认 symbolsRepo.find 返回空（即 name=null）；测试可覆盖
    symbolsRepo = { find: jest.fn().mockResolvedValue([]) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        QuantScoresService,
        { provide: getRepositoryToken(MlScoreDailyEntity), useValue: scoresRepo },
        { provide: getRepositoryToken(MlModelRunEntity), useValue: runsRepo },
        { provide: getRepositoryToken(AShareSymbolEntity), useValue: symbolsRepo },
      ],
    }).compile();

    service = moduleRef.get(QuantScoresService);
  });

  describe('FIELD_COL_MAP', () => {
    it('白名单含 trade_date / model_version / ts_code / score / rank_in_day', () => {
      expect(SCORES_FIELD_COL_MAP.trade_date).toBe('s.trade_date');
      expect(SCORES_FIELD_COL_MAP.model_version).toBe('s.model_version');
      expect(SCORES_FIELD_COL_MAP.ts_code).toBe('s.ts_code');
      expect(SCORES_FIELD_COL_MAP.score).toBe('s.score');
      expect(SCORES_FIELD_COL_MAP.rank_in_day).toBe('s.rank_in_day');
    });
    it('Object.freeze 不可变', () => {
      expect(Object.isFrozen(SCORES_FIELD_COL_MAP)).toBe(true);
    });
    it('未知字段返回 null（list 内部据此 warn+skip）', () => {
      expect(resolveScoresFilterColumn('drop_table')).toBeNull();
      expect(resolveScoresFilterColumn('')).toBeNull();
      // 防御：rank 是 PG 关键字，列名固定为 rank_in_day；rank 不应命中
      expect(resolveScoresFilterColumn('rank')).toBeNull();
    });
  });

  describe('listScores（顶层 /quant/scores：spec M3 §5 主端点）', () => {
    it('happy path：分页 + 默认排序 rank_in_day ASC + total 取 min(dbTotal, top_k)', async () => {
      scoresQb.getMany.mockResolvedValueOnce([
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v1', score: 1.2, rankInDay: 51 },
        { tradeDate: '20260517', tsCode: '600519.SH', modelVersion: 'v1', score: 1.1, rankInDay: 52 },
      ] as MlScoreDailyEntity[]);
      scoresQb.getRawOne.mockResolvedValueOnce({ cnt: '5500' });

      const out = await service.listScores({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 200,
        page: 2,
        pageSize: 50,
        sortField: 'rank_in_day',
        sortDir: 'ASC',
      });

      expect(scoresQb.where).toHaveBeenCalledWith('s.trade_date = :tradeDate', {
        tradeDate: '20260517',
      });
      expect(scoresQb.andWhere).toHaveBeenCalledWith('s.model_version = :modelVersion', {
        modelVersion: 'v1',
      });
      // 必须明确 select 列字段（P95 优化点 2：不发 SELECT *）
      expect(scoresQb.select).toHaveBeenCalledWith([
        's.trade_date',
        's.ts_code',
        's.model_version',
        's.score',
        's.rank_in_day',
      ]);
      expect(scoresQb.orderBy).toHaveBeenCalledWith('s.rank_in_day', 'ASC');
      // skip = (page-1)*pageSize = 50；effectiveLimit = min(pageSize, topK-skip) = min(50, 150) = 50
      expect(scoresQb.offset).toHaveBeenCalledWith(50);
      expect(scoresQb.limit).toHaveBeenCalledWith(50);
      // total 上限被 topK 截断
      expect(out.total).toBe(200);
      expect(out.trade_date).toBe('20260517');
      expect(out.model_version).toBe('v1');
      expect(out.items).toHaveLength(2);
    });

    it('top_k 上限生效：dbTotal 远大于 top_k → total 锁在 top_k', async () => {
      scoresQb.getRawOne.mockResolvedValueOnce({ cnt: '5500' });
      const out = await service.listScores({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 1000,
        page: 1,
        pageSize: 50,
        sortField: 'rank_in_day',
        sortDir: 'ASC',
      });
      expect(out.total).toBe(1000);
    });

    it('翻页超出 top_k：effectiveLimit=0 → 不查 list，items=[]', async () => {
      scoresQb.getRawOne.mockResolvedValueOnce({ cnt: '500' });
      const out = await service.listScores({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 100,
        page: 5,
        pageSize: 50,
        sortField: 'rank_in_day',
        sortDir: 'ASC',
      });
      // page=5,pageSize=50 → skip=200 > topK=100 → effectiveLimit=0
      expect(scoresQb.getMany).not.toHaveBeenCalled();
      expect(out.items).toEqual([]);
      expect(out.total).toBe(100);
    });

    it('sortField 未命中 FIELD_COL_MAP：warn 并回退 rank_in_day ASC（防御 user 输入透传）', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      scoresQb.getRawOne.mockResolvedValueOnce({ cnt: '0' });
      await service.listScores({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 50,
        page: 1,
        pageSize: 50,
        sortField: 'drop_table_users' as any,
        sortDir: 'DESC',
      });
      expect(warnSpy).toHaveBeenCalled();
      expect(scoresQb.orderBy).toHaveBeenCalledWith('s.rank_in_day', 'ASC');
    });

    it('合法 sort=score,desc：orderBy 命中 s.score DESC（FIELD_COL_MAP 翻译）', async () => {
      scoresQb.getRawOne.mockResolvedValueOnce({ cnt: '10' });
      await service.listScores({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 50,
        page: 1,
        pageSize: 50,
        sortField: 'score',
        sortDir: 'DESC',
      });
      expect(scoresQb.orderBy).toHaveBeenCalledWith('s.score', 'DESC');
    });
  });

  describe('getDailyTopK', () => {
    it('happy path：where(trade_date) + where(model_version) + orderBy(rank_in_day ASC) + limit(top_k)', async () => {
      scoresQb.getMany.mockResolvedValue([
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v1', score: 1.23, rankInDay: 1 },
        { tradeDate: '20260517', tsCode: '600519.SH', modelVersion: 'v1', score: 1.10, rankInDay: 2 },
      ] as MlScoreDailyEntity[]);

      const out = await service.getDailyTopK({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 50,
      });

      expect(scoresQb.where).toHaveBeenCalledWith('s.trade_date = :tradeDate', {
        tradeDate: '20260517',
      });
      expect(scoresQb.andWhere).toHaveBeenCalledWith('s.model_version = :modelVersion', {
        modelVersion: 'v1',
      });
      expect(scoresQb.orderBy).toHaveBeenCalledWith('s.rank_in_day', 'ASC');
      expect(scoresQb.limit).toHaveBeenCalledWith(50);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        trade_date: '20260517',
        ts_code: '000001.SZ',
        model_version: 'v1',
        score: 1.23,
        rank_in_day: 1,
        name: null,
      });
    });

    it('补股票中文名：symbolsRepo.find 返回的 name 透传到 row.name', async () => {
      scoresQb.getMany.mockResolvedValue([
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v1', score: 1.23, rankInDay: 1 },
        { tradeDate: '20260517', tsCode: '600519.SH', modelVersion: 'v1', score: 1.10, rankInDay: 2 },
        { tradeDate: '20260517', tsCode: '999999.SZ', modelVersion: 'v1', score: 1.05, rankInDay: 3 },
      ] as MlScoreDailyEntity[]);
      symbolsRepo.find.mockResolvedValue([
        { tsCode: '000001.SZ', name: '平安银行' },
        { tsCode: '600519.SH', name: '贵州茅台' },
      ]);

      const out = await service.getDailyTopK({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 50,
      });

      // 命中的 ts_code 取自 a_share_symbols.name
      expect(out[0].name).toBe('平安银行');
      expect(out[1].name).toBe('贵州茅台');
      // 未命中的 ts_code 退回 null（不抛错、不静默用 ts_code 替代）
      expect(out[2].name).toBeNull();
      // symbolsRepo.find 必须传去重后的 ts_code 集合（不重复查同一标的）
      expect(symbolsRepo.find).toHaveBeenCalledTimes(1);
    });

    it('空结果：repo 返回空数组 → 返回空数组', async () => {
      scoresQb.getMany.mockResolvedValue([]);
      const out = await service.getDailyTopK({
        tradeDate: '20260517',
        modelVersion: 'no-such-version',
        topK: 50,
      });
      expect(out).toEqual([]);
    });
  });

  describe('getTimeSeries', () => {
    it('happy path：where(ts_code) + where(model_version) + 日期区间 + orderBy(trade_date ASC)', async () => {
      scoresQb.getMany.mockResolvedValue([
        { tradeDate: '20260510', tsCode: '000001.SZ', modelVersion: 'v1', score: 0.5, rankInDay: 100 },
        { tradeDate: '20260511', tsCode: '000001.SZ', modelVersion: 'v1', score: 0.6, rankInDay: 50 },
      ] as MlScoreDailyEntity[]);

      const out = await service.getTimeSeries({
        tsCode: '000001.SZ',
        modelVersion: 'v1',
        start: '20260510',
        end: '20260511',
      });

      expect(scoresQb.where).toHaveBeenCalledWith('s.ts_code = :tsCode', { tsCode: '000001.SZ' });
      const andWhereCalls = scoresQb.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereCalls).toContain('s.model_version = :modelVersion');
      expect(andWhereCalls).toContain('s.trade_date >= :start');
      expect(andWhereCalls).toContain('s.trade_date <= :end');
      expect(scoresQb.orderBy).toHaveBeenCalledWith('s.trade_date', 'ASC');
      expect(out).toEqual([
        { trade_date: '20260510', score: 0.5, rank_in_day: 100 },
        { trade_date: '20260511', score: 0.6, rank_in_day: 50 },
      ]);
    });
  });

  describe('getModelVersions', () => {
    it('从 model_runs 抽 distinct model_version + created_at 倒序', async () => {
      runsQb.getRawMany.mockResolvedValue([
        { model_version: 'v2', created_at: new Date('2026-05-17T03:04:05Z') },
        { model_version: 'v1', created_at: new Date('2026-05-10T00:00:00Z') },
      ]);

      const out = await service.getModelVersions();
      expect(runsQb.orderBy).toHaveBeenCalledWith('r.createdAt', 'DESC');
      expect(out).toEqual([
        { model_version: 'v2', created_at: '2026-05-17 03:04:05Z' },
        { model_version: 'v1', created_at: '2026-05-10 00:00:00Z' },
      ]);
    });
  });

  describe('compareModels（多版本对照"无串扰"）', () => {
    it('多 model_version：用 = ANY(:arr::text[]) 而非 IN(...)；内存分组保持入参顺序且各组互不混淆', async () => {
      // mock 返回故意打乱顺序，验证分组逻辑会按 model_version 正确拆开（无串扰）
      scoresQb.getMany.mockResolvedValue([
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v2', score: 9.0, rankInDay: 1 },
        { tradeDate: '20260517', tsCode: '600519.SH', modelVersion: 'v1', score: 1.5, rankInDay: 1 },
        { tradeDate: '20260517', tsCode: '300750.SZ', modelVersion: 'v2', score: 8.5, rankInDay: 2 },
        { tradeDate: '20260517', tsCode: '000002.SZ', modelVersion: 'v1', score: 1.4, rankInDay: 2 },
      ] as MlScoreDailyEntity[]);

      const out = await service.compareModels({
        tradeDate: '20260517',
        modelVersions: ['v1', 'v2'],
        topK: 10,
      });

      // 必须使用 ::text[] 强转（CLAUDE.md NOT DO 第 1 条）
      const anyCall = scoresQb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('= ANY(:modelVersions::text[])'),
      );
      expect(anyCall).toBeTruthy();
      expect(anyCall![1]).toEqual({ modelVersions: ['v1', 'v2'] });

      // 分组：v1 / v2 互不混杂；返回顺序锚定入参顺序
      expect(out).toHaveLength(2);
      expect(out[0].model_version).toBe('v1');
      expect(out[0].rows.map((r) => r.ts_code)).toEqual(['600519.SH', '000002.SZ']);
      expect(out[0].rows.every((r) => r.model_version === 'v1')).toBe(true);

      expect(out[1].model_version).toBe('v2');
      expect(out[1].rows.map((r) => r.ts_code)).toEqual(['000001.SZ', '300750.SZ']);
      expect(out[1].rows.every((r) => r.model_version === 'v2')).toBe(true);
    });

    it('空 modelVersions：直接返回 []，不发起 SQL', async () => {
      const out = await service.compareModels({
        tradeDate: '20260517',
        modelVersions: [],
        topK: 10,
      });
      expect(out).toEqual([]);
      expect(scoresRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('某个 model_version 当日无数据：该组 rows 为空，但其它组不受影响（无串扰的另一面）', async () => {
      scoresQb.getMany.mockResolvedValue([
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v1', score: 1.0, rankInDay: 1 },
      ] as MlScoreDailyEntity[]);

      const out = await service.compareModels({
        tradeDate: '20260517',
        modelVersions: ['v1', 'v_missing'],
        topK: 10,
      });
      expect(out[0]).toEqual({
        model_version: 'v1',
        rows: [
          {
            trade_date: '20260517',
            ts_code: '000001.SZ',
            model_version: 'v1',
            score: 1.0,
            rank_in_day: 1,
            name: null,
          },
        ],
      });
      expect(out[1]).toEqual({ model_version: 'v_missing', rows: [] });
    });

    it('compareModels 也补 name：跨模型同一 ts_code 只查一次 a_share_symbols', async () => {
      scoresQb.getMany.mockResolvedValue([
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v1', score: 1.0, rankInDay: 1 },
        { tradeDate: '20260517', tsCode: '000001.SZ', modelVersion: 'v2', score: 9.0, rankInDay: 1 },
        { tradeDate: '20260517', tsCode: '600519.SH', modelVersion: 'v2', score: 8.5, rankInDay: 2 },
      ] as MlScoreDailyEntity[]);
      symbolsRepo.find.mockResolvedValue([
        { tsCode: '000001.SZ', name: '平安银行' },
        { tsCode: '600519.SH', name: '贵州茅台' },
      ]);

      const out = await service.compareModels({
        tradeDate: '20260517',
        modelVersions: ['v1', 'v2'],
        topK: 10,
      });

      expect(out[0].rows[0].name).toBe('平安银行');
      expect(out[1].rows[0].name).toBe('平安银行'); // 同 ts_code 两组都拿到
      expect(out[1].rows[1].name).toBe('贵州茅台');
      // 一批扫描，去重后的 ts_code 集合 → symbolsRepo.find 只调一次
      expect(symbolsRepo.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('getScoresByTsCodes（A 股面板评分列：自动选 prod + 批量按 ts_code 查）', () => {
    it('happy path：prod 存在 + 部分命中 → = ANY(::text[]) 去重数组 + select 三列 + Number(score)', async () => {
      runsQb.getRawOne.mockResolvedValueOnce({ model_version: 'prod-v1' });
      scoresQb.getMany.mockResolvedValueOnce([
        { tsCode: '000001.SZ', score: '1.2345', rankInDay: 51 },
        { tsCode: '600519.SH', score: -0.9876, rankInDay: 52 },
      ] as unknown as MlScoreDailyEntity[]);

      const out = await service.getScoresByTsCodes({
        tradeDate: '20260528',
        tsCodes: ['000001.SZ', '000001.SZ', '600519.SH'],
      });

      // 选 prod：WHERE status='prod' ORDER BY created_at DESC LIMIT 1
      expect(runsQb.where).toHaveBeenCalledWith('r.status = :status', { status: 'prod' });
      expect(runsQb.orderBy).toHaveBeenCalledWith('r.createdAt', 'DESC');
      expect(runsQb.limit).toHaveBeenCalledWith(1);

      // scores 查询：select 用 entity 属性名（getMany 按属性名水合）
      expect(scoresQb.select).toHaveBeenCalledWith(['s.tsCode', 's.score', 's.rankInDay']);
      expect(scoresQb.where).toHaveBeenCalledWith('s.trade_date = :tradeDate', {
        tradeDate: '20260528',
      });
      expect(scoresQb.andWhere).toHaveBeenCalledWith('s.model_version = :modelVersion', {
        modelVersion: 'prod-v1',
      });
      // varchar 列数组参数用 ::text[]，且去重
      const anyCall = scoresQb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('s.ts_code = ANY(:tsCodes::text[])'),
      );
      expect(anyCall).toBeTruthy();
      expect(anyCall![1]).toEqual({ tsCodes: ['000001.SZ', '600519.SH'] });

      expect(out.model_version).toBe('prod-v1');
      expect(out.trade_date).toBe('20260528');
      expect(out.items).toEqual([
        { ts_code: '000001.SZ', score: 1.2345, rank_in_day: 51 },
        { ts_code: '600519.SH', score: -0.9876, rank_in_day: 52 },
      ]);
    });

    it('prod 不存在：不查 scores、model_version=null、items=[]、warn 留痕、不抛 500', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      runsQb.getRawOne.mockResolvedValueOnce(undefined);

      const out = await service.getScoresByTsCodes({
        tradeDate: '20260528',
        tsCodes: ['000001.SZ'],
      });

      expect(scoresRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(out).toEqual({ trade_date: '20260528', model_version: null, items: [] });
      expect(warnSpy).toHaveBeenCalled();
    });

    it('tsCodes 空数组：不查 scores、items=[]、model_version 仍为 prod', async () => {
      runsQb.getRawOne.mockResolvedValueOnce({ model_version: 'prod-v1' });

      const out = await service.getScoresByTsCodes({ tradeDate: '20260528', tsCodes: [] });

      expect(scoresRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(out).toEqual({ trade_date: '20260528', model_version: 'prod-v1', items: [] });
    });

    it('当日该模型无数据：getMany 返回空 → items=[]、model_version 非 null', async () => {
      runsQb.getRawOne.mockResolvedValueOnce({ model_version: 'prod-v1' });
      scoresQb.getMany.mockResolvedValueOnce([]);

      const out = await service.getScoresByTsCodes({
        tradeDate: '20260520',
        tsCodes: ['000001.SZ'],
      });

      expect(out.model_version).toBe('prod-v1');
      expect(out.items).toEqual([]);
    });
  });
});

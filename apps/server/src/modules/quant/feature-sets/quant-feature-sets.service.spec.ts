import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  QuantFeatureSetsService,
  splitIntoCoverageSegments,
  type CoverageSegment,
} from './quant-feature-sets.service';

/**
 * QuantFeatureSetsService 单测
 *
 * 覆盖点：
 *  1. `listMaterialized` 仅返回有 feature_matrix 行的 fs（EXISTS 过滤）
 *  2. `listMaterialized` label_name 来自 label_definitions.name，缺(NULL)→回退 scheme
 *  3. `coverage` 切段正确，使用 trade_cal 交易日序列判断连续性
 *  4. `splitIntoCoverageSegments` 纯函数：空列表、单元素、连续、跨长假不断段、真缺交易日断段
 *
 * DataSource 均使用 jest mock，不连真实 DB。
 */

// ---------------------------------------------------------------------------
// 辅助：构造 mock trade_cal 序列（每日一条，周一到周五）
// 用于纯函数测试——直接传入有序交易日字符串数组
// ---------------------------------------------------------------------------

describe('splitIntoCoverageSegments（纯函数）', () => {
  it('空列表返回空数组', () => {
    expect(splitIntoCoverageSegments([], [])).toEqual([]);
  });

  it('单元素返回单段 start===end', () => {
    expect(splitIntoCoverageSegments(['20240101'], ['20240101'])).toEqual([
      { start: '20240101', end: '20240101' },
    ]);
  });

  it('连续交易日合并为一段', () => {
    // 周一到周五：在 calendar 中位置相邻，应合并
    const dates = ['20240101', '20240102', '20240103', '20240104', '20240105'];
    const calendar = ['20240101', '20240102', '20240103', '20240104', '20240105'];
    expect(splitIntoCoverageSegments(dates, calendar)).toEqual([
      { start: '20240101', end: '20240105' },
    ]);
  });

  it('跨周末（calendar 含跳过休市）不断段', () => {
    // 周五 20240119 → 周一 20240122；calendar 里两者位置相邻（中间是周末，无 is_open=1）
    const dates = ['20240119', '20240122'];
    const calendar = ['20240119', '20240122']; // 只含开市日
    expect(splitIntoCoverageSegments(dates, calendar)).toEqual([
      { start: '20240119', end: '20240122' },
    ]);
  });

  it('跨春节长假（中间无遗漏交易日）→ 不断段', () => {
    // 2024 年春节：节前最后交易日 20240208，节后第一交易日 20240219
    // 自然日差 11 天，但 trade_cal 里两者位置相邻（calendar 里只存 is_open=1 的日子）
    const dates = ['20240207', '20240208', '20240219', '20240220'];
    // calendar 是这段时间内所有 is_open=1 的日子（春节期间无开市日）
    const calendar = ['20240207', '20240208', '20240219', '20240220'];
    const result = splitIntoCoverageSegments(dates, calendar);
    // 位置相邻 → 不断段 → 应合并为一段
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ start: '20240207', end: '20240220' });
  });

  it('跨春节长假（feature_matrix 中间真缺交易日）→ 断段', () => {
    // 2024 年春节：节前最后交易日 20240208，节后第一交易日 20240219
    // feature_matrix 里只有 20240207 和 20240219（缺了 20240208），
    // calendar 里 20240207 位置 0，20240208 位置 1，20240219 位置 2
    // dates 中 20240207→20240219 在 calendar 里差 2 个位置 → 断段
    const dates = ['20240207', '20240219', '20240220'];
    const calendar = ['20240207', '20240208', '20240219', '20240220'];
    const result = splitIntoCoverageSegments(dates, calendar);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ start: '20240207', end: '20240207' });
    expect(result[1]).toEqual({ start: '20240219', end: '20240220' });
  });

  it('中间真空洞（跨月缺失多个交易日）产生两段', () => {
    // dates 里 20240105 到 20240120 之间有 10 个交易日未录入
    const dates = ['20240101', '20240102', '20240103', '20240104', '20240105', '20240120', '20240121'];
    // calendar 包含完整交易日序列
    const calendar = [
      '20240101', '20240102', '20240103', '20240104', '20240105',
      '20240108', '20240109', '20240110', '20240111', '20240112',
      '20240115', '20240116', '20240117', '20240118', '20240119',
      '20240120', '20240121',
    ];
    const result = splitIntoCoverageSegments(dates, calendar);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ start: '20240101', end: '20240105' });
    expect(result[1]).toEqual({ start: '20240120', end: '20240121' });
  });

  it('多个空洞产生多段', () => {
    // 三组各自连续，组间有遗漏交易日
    const dates = [
      '20240101', '20240102', // 段 1
      '20240201', '20240202', // 段 2（2月之间缺大量交易日）
      '20240301',             // 段 3
    ];
    // calendar 包含 1月/2月/3月的连续交易日（中间没有遗漏，但 dates 没覆盖中间部分）
    const calendar = [
      '20240101', '20240102', '20240103', '20240104', '20240105',
      '20240108', '20240109', '20240110',
      // ... 1月其余交易日和2月初
      '20240201', '20240202', '20240205', '20240206',
      // ... 2月其余
      '20240301', '20240304',
    ];
    const result = splitIntoCoverageSegments(dates, calendar);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ start: '20240101', end: '20240102' });
    expect(result[1]).toEqual({ start: '20240201', end: '20240202' });
    expect(result[2]).toEqual({ start: '20240301', end: '20240301' });
  });

  it('tradingCalendar 为空时保守断段（数据异常兜底）', () => {
    // calendar 为空时 calendarIndex 无任何条目，isConsecutive 始终 false → 每相邻对都断
    const dates = ['20240101', '20240102', '20240103'];
    const result = splitIntoCoverageSegments(dates, []);
    // 每对相邻都断段
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Service 单测
// ---------------------------------------------------------------------------

describe('QuantFeatureSetsService', () => {
  let service: QuantFeatureSetsService;
  let mockDataSource: { query: jest.Mock };

  beforeEach(async () => {
    mockDataSource = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuantFeatureSetsService,
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<QuantFeatureSetsService>(QuantFeatureSetsService);
  });

  // -------------------------------------------------------------------------
  // listMaterialized
  // -------------------------------------------------------------------------

  describe('listMaterialized', () => {
    it('无物化 feature_set 时返回空数组', async () => {
      // 第一次 query（fs + LEFT JOIN）返回空
      mockDataSource.query.mockResolvedValueOnce([]);

      const result = await service.listMaterialized();
      expect(result).toEqual([]);
      // coverage 查询和 trade_cal 查询均不应被调用（短路）
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    });

    it('label_id 非 NULL → 使用 label_name', async () => {
      mockDataSource.query
        // 第一次：fs 列表查询
        .mockResolvedValueOnce([
          {
            feature_set_id: 'fs-001',
            factor_version: 'v1',
            scheme: 'scheme_abc',
            new_listing_min_days: '30',
            label_id: 'label-ret',
            label_version: '1',
            label_name: '次日涨跌·横盘±0.5%',
          },
        ])
        // 第二次：coverage 查询（feature_matrix DISTINCT trade_date）
        .mockResolvedValueOnce([
          { feature_set_id: 'fs-001', trade_date: '20240101' },
          { feature_set_id: 'fs-001', trade_date: '20240102' },
        ])
        // 第三次：trade_cal 交易日序列
        .mockResolvedValueOnce([
          { cal_date: '20240101' },
          { cal_date: '20240102' },
        ]);

      const result = await service.listMaterialized();
      expect(result).toHaveLength(1);
      const item = result[0];
      expect(item.feature_set_id).toBe('fs-001');
      expect(item.label_name).toBe('次日涨跌·横盘±0.5%');
      expect(item.label_version).toBe('1');
      expect(item.coverage).toEqual([{ start: '20240101', end: '20240102' }]);
    });

    it('label_id 为 NULL → label_name 回退为 scheme', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            feature_set_id: 'fs-002',
            factor_version: 'v1',
            scheme: 'scheme_legacy',
            new_listing_min_days: 60,
            label_id: null,
            label_version: null,
            label_name: null,
          },
        ])
        .mockResolvedValueOnce([
          { feature_set_id: 'fs-002', trade_date: '20230601' },
        ])
        .mockResolvedValueOnce([
          { cal_date: '20230601' },
        ]);

      const result = await service.listMaterialized();
      expect(result).toHaveLength(1);
      expect(result[0].label_name).toBe('scheme_legacy'); // 回退 scheme
      expect(result[0].label_version).toBeNull();
    });

    it('多个 feature_set，coverage 正确分配到各 fs（跨长假不断段）', async () => {
      // fs-A 跨 20240208→20240219（2024春节），trade_cal 里两者相邻 → 不断段
      // fs-B 连续两天 → 一段
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            feature_set_id: 'fs-A',
            factor_version: 'v2',
            scheme: 'scheme_A',
            new_listing_min_days: 30,
            label_id: null,
            label_version: null,
            label_name: null,
          },
          {
            feature_set_id: 'fs-B',
            factor_version: 'v2',
            scheme: 'scheme_B',
            new_listing_min_days: 30,
            label_id: 'lb',
            label_version: '2',
            label_name: '标签B',
          },
        ])
        .mockResolvedValueOnce([
          // fs-A：节前两天 + 节后两天（中间春节假期 trade_cal 无 is_open=1）
          { feature_set_id: 'fs-A', trade_date: '20240207' },
          { feature_set_id: 'fs-A', trade_date: '20240208' },
          { feature_set_id: 'fs-A', trade_date: '20240219' },
          { feature_set_id: 'fs-A', trade_date: '20240220' },
          { feature_set_id: 'fs-B', trade_date: '20240301' },
          { feature_set_id: 'fs-B', trade_date: '20240302' },
        ])
        // trade_cal：覆盖 20240207~20240302 的所有 is_open=1 日期
        .mockResolvedValueOnce([
          { cal_date: '20240207' },
          { cal_date: '20240208' },
          // 春节期间无 is_open=1
          { cal_date: '20240219' },
          { cal_date: '20240220' },
          { cal_date: '20240221' },
          { cal_date: '20240222' },
          { cal_date: '20240223' },
          { cal_date: '20240226' },
          { cal_date: '20240227' },
          { cal_date: '20240228' },
          { cal_date: '20240229' },
          { cal_date: '20240301' },
          { cal_date: '20240302' },
        ]);

      const result = await service.listMaterialized();
      expect(result).toHaveLength(2);

      const fsA = result.find((r) => r.feature_set_id === 'fs-A')!;
      // 20240208 → 20240219 在 calendar 里位置相邻 → 不断段 → 一段
      expect(fsA.coverage).toHaveLength(1);
      expect(fsA.coverage[0]).toEqual({ start: '20240207', end: '20240220' });

      const fsB = result.find((r) => r.feature_set_id === 'fs-B')!;
      expect(fsB.coverage).toHaveLength(1);
      expect(fsB.label_name).toBe('标签B');
      expect(fsB.label_version).toBe('2');
    });

    it('真缺交易日（中间空洞）→ 断段', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            feature_set_id: 'fs-gap',
            factor_version: 'v1',
            scheme: 'scheme_gap',
            new_listing_min_days: 30,
            label_id: null,
            label_version: null,
            label_name: null,
          },
        ])
        .mockResolvedValueOnce([
          // 20240103 → 20240108 之间缺 20240104、20240105（交易日）
          { feature_set_id: 'fs-gap', trade_date: '20240101' },
          { feature_set_id: 'fs-gap', trade_date: '20240102' },
          { feature_set_id: 'fs-gap', trade_date: '20240103' },
          { feature_set_id: 'fs-gap', trade_date: '20240108' },
          { feature_set_id: 'fs-gap', trade_date: '20240109' },
        ])
        .mockResolvedValueOnce([
          { cal_date: '20240101' },
          { cal_date: '20240102' },
          { cal_date: '20240103' },
          { cal_date: '20240104' }, // 实际交易日，但 feature_matrix 缺
          { cal_date: '20240105' }, // 实际交易日，但 feature_matrix 缺
          { cal_date: '20240108' },
          { cal_date: '20240109' },
        ]);

      const result = await service.listMaterialized();
      expect(result).toHaveLength(1);
      const fsGap = result[0];
      // 20240103 → 20240108 在 calendar 里差 3 位置 → 断段
      expect(fsGap.coverage).toHaveLength(2);
      expect(fsGap.coverage[0]).toEqual({ start: '20240101', end: '20240103' });
      expect(fsGap.coverage[1]).toEqual({ start: '20240108', end: '20240109' });
    });
  });

  // -------------------------------------------------------------------------
  // coverage
  // -------------------------------------------------------------------------

  describe('coverage', () => {
    it('无数据返回空数组', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      const result = await service.coverage('fs-empty');
      expect(result).toEqual([]);
      // 无数据时不应查 trade_cal
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    });

    it('连续日期返回单段', async () => {
      mockDataSource.query
        // feature_matrix DISTINCT
        .mockResolvedValueOnce([
          { trade_date: '20240101' },
          { trade_date: '20240102' },
          { trade_date: '20240103' },
        ])
        // trade_cal
        .mockResolvedValueOnce([
          { cal_date: '20240101' },
          { cal_date: '20240102' },
          { cal_date: '20240103' },
        ]);
      const result = await service.coverage('fs-x');
      expect(result).toEqual([{ start: '20240101', end: '20240103' }]);
    });

    it('跨春节长假（中间无遗漏交易日）→ 不断段', async () => {
      // 2024 春节：节前最后交易日 20240208，节后第一交易日 20240219
      mockDataSource.query
        .mockResolvedValueOnce([
          { trade_date: '20240207' },
          { trade_date: '20240208' },
          { trade_date: '20240219' },
          { trade_date: '20240220' },
        ])
        .mockResolvedValueOnce([
          { cal_date: '20240207' },
          { cal_date: '20240208' },
          // 春节期间 trade_cal 无 is_open=1 → 两者在 calendar 里位置相邻
          { cal_date: '20240219' },
          { cal_date: '20240220' },
        ]);
      const result = await service.coverage('fs-spring-festival');
      // 跨春节但无遗漏交易日 → 不断段 → 一段
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ start: '20240207', end: '20240220' });
    });

    it('中间真缺交易日 → 断段', async () => {
      // feature_matrix 缺了 20240104、20240105（实际有交易）
      mockDataSource.query
        .mockResolvedValueOnce([
          { trade_date: '20240101' },
          { trade_date: '20240102' },
          { trade_date: '20240103' },
          { trade_date: '20240108' },
        ])
        .mockResolvedValueOnce([
          { cal_date: '20240101' },
          { cal_date: '20240102' },
          { cal_date: '20240103' },
          { cal_date: '20240104' }, // 真实交易日，feature_matrix 缺
          { cal_date: '20240105' }, // 真实交易日，feature_matrix 缺
          { cal_date: '20240108' },
        ]);
      const result = await service.coverage('fs-gap');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ start: '20240101', end: '20240103' });
      expect(result[1]).toEqual({ start: '20240108', end: '20240108' });
    });

    it('将正确的 featureSetId 传给 feature_matrix SQL', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      await service.coverage('my-fs-id');
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('feature_matrix'),
        ['my-fs-id'],
      );
    });

    it('trade_cal 查询使用正确的 min/max 日期范围', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          { trade_date: '20240101' },
          { trade_date: '20240105' },
        ])
        .mockResolvedValueOnce([
          { cal_date: '20240101' },
          { cal_date: '20240102' },
          { cal_date: '20240103' },
          { cal_date: '20240104' },
          { cal_date: '20240105' },
        ]);
      await service.coverage('fs-range-check');
      // 第二次调用是 trade_cal 查询，参数应为 [minDate, maxDate]
      expect(mockDataSource.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('trade_cal'),
        ['20240101', '20240105'],
      );
    });
  });
});

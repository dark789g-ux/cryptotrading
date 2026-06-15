/**
 * portfolio-sim.loader.spec.ts
 *
 * fetchOamvSeries 单测（spec §6）：装大盘 0AMV 日序列入 EngineInput.oamvDaily。
 *
 * 关注点（混合列类型）：
 *   - close 是 numeric（pg 返 string）、amv_dif/amv_dea/amv_macd/ma240 是 double（pg 返 number）——
 *     统一过 parseNumericString 对两者都安全（数值会先转 string）。
 *   - NULL 透传（amv 三列不缺，但 ma240 有预热 NULL）。
 *   - Map key = trade_date.trim()。
 *
 * mock DataSource.query（不连真 DB）。
 */

import { PortfolioSimLoader } from './portfolio-sim.loader';

function makeLoader(oamvRows: unknown[]) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('oamv_daily')) return oamvRows;
    return [];
  });
  const ds = { query } as unknown as ConstructorParameters<typeof PortfolioSimLoader>[0];
  return { loader: new PortfolioSimLoader(ds), query };
}

describe('PortfolioSimLoader.fetchOamvSeries', () => {
  it('混合列类型解析：close(string) 与 amv_*/ma240(number) 都过 parseNumericString', async () => {
    const { loader } = makeLoader([
      {
        trade_date: '20240102',
        amv_dif: 1.5, // double → number
        amv_dea: -0.5,
        amv_macd: 2.0,
        close: '3456.78', // numeric → string
        ma240: 3300.12,
      },
    ]);

    const map = await loader.fetchOamvSeries('20240101', '20240131');
    const bar = map.get('20240102');
    expect(bar).toEqual({
      amvDif: 1.5,
      amvDea: -0.5,
      amvMacd: 2.0,
      close: 3456.78,
      ma240: 3300.12,
    });
    // 类型确为 number（string '3456.78' 已解析）。
    expect(typeof bar!.close).toBe('number');
    expect(typeof bar!.amvDif).toBe('number');
  });

  it('NULL 透传（ma240 预热段 null 不伪造）', async () => {
    const { loader } = makeLoader([
      {
        trade_date: '20210901',
        amv_dif: 0.1,
        amv_dea: 0.2,
        amv_macd: -0.1,
        close: '3000.00',
        ma240: null, // 预热段 NULL
      },
    ]);

    const map = await loader.fetchOamvSeries('20210901', '20210930');
    const bar = map.get('20210901');
    expect(bar).toEqual({
      amvDif: 0.1,
      amvDea: 0.2,
      amvMacd: -0.1,
      close: 3000,
      ma240: null,
    });
  });

  it('Map key = trade_date.trim()（防 char padding）', async () => {
    const { loader } = makeLoader([
      {
        trade_date: '20240102 ', // 尾随空格
        amv_dif: 1,
        amv_dea: 1,
        amv_macd: 1,
        close: '100.00',
        ma240: 90,
      },
    ]);

    const map = await loader.fetchOamvSeries('20240101', '20240131');
    expect(map.has('20240102')).toBe(true);
    expect(map.has('20240102 ')).toBe(false);
  });

  it('多行按 trade_date 装成 Map（升序无关，key 唯一）', async () => {
    const { loader } = makeLoader([
      { trade_date: '20240102', amv_dif: 1, amv_dea: 1, amv_macd: 1, close: '100.00', ma240: 90 },
      { trade_date: '20240103', amv_dif: 2, amv_dea: 2, amv_macd: 2, close: '101.00', ma240: 91 },
    ]);
    const map = await loader.fetchOamvSeries('20240101', '20240131');
    expect(map.size).toBe(2);
    expect(map.get('20240102')!.amvDif).toBe(1);
    expect(map.get('20240103')!.amvDif).toBe(2);
  });

  it('空结果 → 空 Map（缺数据由引擎 fail-closed 处理，loader 不伪造）', async () => {
    const { loader } = makeLoader([]);
    const map = await loader.fetchOamvSeries('20240101', '20240131');
    expect(map.size).toBe(0);
  });

  it('SQL 含期望列与 oamv_daily 表，参数为 [start, end]', async () => {
    const { loader, query } = makeLoader([]);
    await loader.fetchOamvSeries('20240101', '20240131');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('oamv_daily');
    expect(sql).toContain('amv_dif');
    expect(sql).toContain('amv_dea');
    expect(sql).toContain('amv_macd');
    expect(sql).toContain('close');
    expect(sql).toContain('ma240');
    expect(params).toEqual(['20240101', '20240131']);
  });
});

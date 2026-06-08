import { SignalRollingIndicatorService } from './signal-rolling-indicator.service';

/** 折叠所有空白便于做不受换行/缩进影响的子串断言。 */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * 聚焦单测：buildWindowUpsertSql 是纯字符串构造，无需 DB。
 * 用 cast 直取私有方法，断言窗口公式与 opts 门控逐字对齐 spec 02。
 */
describe('SignalRollingIndicatorService.buildWindowUpsertSql', () => {
  let service: SignalRollingIndicatorService;
  let build: (opts: { tsCodeFilter: boolean; dateFloor: boolean }) => string;

  beforeEach(() => {
    // DataSource 在该方法里完全不被触碰，传 null 即可。
    service = new SignalRollingIndicatorService(null as never);
    build = (opts) =>
      (
        service as unknown as {
          buildWindowUpsertSql: (o: {
            tsCodeFilter: boolean;
            dateFloor: boolean;
          }) => string;
        }
      ).buildWindowUpsertSql(opts);
  });

  describe('两个 WINDOW 定义（spec 02 窗口）', () => {
    it('含 w120 ROWS BETWEEN 119 PRECEDING AND CURRENT ROW', () => {
      const sql = squash(build({ tsCodeFilter: false, dateFloor: false }));
      expect(sql).toContain(
        'w120 AS (PARTITION BY ts_code ORDER BY trade_date ROWS BETWEEN 119 PRECEDING AND CURRENT ROW)',
      );
    });

    it('含 w60 ROWS BETWEEN 59 PRECEDING AND CURRENT ROW', () => {
      const sql = squash(build({ tsCodeFilter: false, dateFloor: false }));
      expect(sql).toContain(
        'w60 AS (PARTITION BY ts_code ORDER BY trade_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)',
      );
    });
  });

  describe('5 个 CASE 门控（n120=120 / n60=60）', () => {
    let sql: string;
    beforeEach(() => {
      sql = squash(build({ tsCodeFilter: false, dateFloor: false }));
    });

    it('pos_120：n120=120 → (qfq_close - low_120)/(high_120 - low_120 + 1e-10)', () => {
      expect(sql).toContain(
        'CASE WHEN n120 = 120 THEN (qfq_close - low_120) / (high_120 - low_120 + 1e-10) END',
      );
    });

    it('pos_60：n60=60 → (qfq_close - low_60)/(high_60 - low_60 + 1e-10)', () => {
      expect(sql).toContain(
        'CASE WHEN n60 = 60 THEN (qfq_close - low_60) / (high_60 - low_60 + 1e-10) END',
      );
    });

    it('close_ma60_ratio：n60=60 → qfq_close / NULLIF(ma60q, 0)', () => {
      expect(sql).toContain('CASE WHEN n60 = 60 THEN qfq_close / NULLIF(ma60q, 0) END');
    });

    it('vol_ratio_60：n60=60 → vol / (avgvol60 + 1)', () => {
      expect(sql).toContain('CASE WHEN n60 = 60 THEN vol / (avgvol60 + 1) END');
    });

    it('vol_ratio_120：n120=120 → vol / (avgvol120 + 1)', () => {
      expect(sql).toContain('CASE WHEN n120 = 120 THEN vol / (avgvol120 + 1) END');
    });
  });

  it('始终含 ON CONFLICT (ts_code, trade_date) DO UPDATE', () => {
    const sql = squash(build({ tsCodeFilter: false, dateFloor: false }));
    expect(sql).toContain('ON CONFLICT (ts_code, trade_date) DO UPDATE');
  });

  describe('tsCodeFilter 门控内层 WHERE ts_code = ANY', () => {
    it('tsCodeFilter=false → 不含 ts_code = ANY', () => {
      const sql = squash(build({ tsCodeFilter: false, dateFloor: false }));
      expect(sql).not.toContain('ts_code = ANY');
    });

    it('tsCodeFilter=true → 内层含 ts_code = ANY($1::text[])', () => {
      const sql = squash(build({ tsCodeFilter: true, dateFloor: false }));
      expect(sql).toContain('WHERE ts_code = ANY($1::text[])');
    });
  });

  describe('dateFloor 门控外层 WHERE trade_date >=（窗口算完之后）', () => {
    it('dateFloor=false → 不含 trade_date >=', () => {
      const sql = squash(build({ tsCodeFilter: false, dateFloor: false }));
      expect(sql).not.toContain('trade_date >=');
    });

    it('dateFloor=true + 无 tsCodeFilter → 外层 WHERE trade_date >= $1', () => {
      const sql = squash(build({ tsCodeFilter: false, dateFloor: true }));
      expect(sql).toContain('WHERE trade_date >= $1');
    });

    it('dateFloor=true + tsCodeFilter=true → 外层 WHERE trade_date >= $2（占位符顺延）', () => {
      const sql = squash(build({ tsCodeFilter: true, dateFloor: true }));
      expect(sql).toContain('WHERE ts_code = ANY($1::text[])');
      expect(sql).toContain('WHERE trade_date >= $2');
    });

    it('date floor 出现在窗口子查询闭合 ) s 之后（窗口仍看 dirty 前历史）', () => {
      const sql = squash(build({ tsCodeFilter: true, dateFloor: true }));
      const closeIdx = sql.indexOf(') s');
      const floorIdx = sql.indexOf('WHERE trade_date >=');
      expect(closeIdx).toBeGreaterThan(-1);
      expect(floorIdx).toBeGreaterThan(closeIdx);
    });
  });
});

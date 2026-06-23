import {
  classifyNoise,
  classifySingle,
  type NoiseCandidate,
} from './classifyNoise';

describe('classifyNoise', () => {
  describe('classifySingle — 已退市', () => {
    it('exp_date 非空标 delisted', () => {
      const tags = classifySingle({ name: '某退市指数', exp_date: '20200101' });
      expect(tags).toContain('delisted');
    });

    it('exp_date 为空不标 delisted', () => {
      const tags = classifySingle({ name: '某指数', exp_date: null });
      expect(tags).not.toContain('delisted');
    });

    it('exp_date 空串不标 delisted', () => {
      const tags = classifySingle({ name: '某指数', exp_date: '' });
      expect(tags).not.toContain('delisted');
    });
  });

  describe('classifySingle — 跨境/外币/新三板', () => {
    for (const kw of ['USD', 'HKD', '港股', '美股', '三板', '东盟', '中韩']) {
      it(`name 含 ${kw} 标 cross_border`, () => {
        const tags = classifySingle({ name: `测试${kw}指数`, exp_date: null });
        expect(tags).toContain('cross_border');
      });
    }

    it('普通宽基名不标 cross_border', () => {
      const tags = classifySingle({ name: '沪深300', exp_date: null });
      expect(tags).not.toContain('cross_border');
    });
  });

  describe('classifySingle — 收益版（非价格版）', () => {
    for (const kw of ['收益', '净收益']) {
      it(`name 含 ${kw} 标 total_return`, () => {
        const tags = classifySingle({ name: `上证${kw}指数`, exp_date: null });
        expect(tags).toContain('total_return');
      });
    }

    it('裸 R 标 total_return', () => {
      const tags = classifySingle({ name: '上证综指R', exp_date: null });
      expect(tags).toContain('total_return');
    });

    it('普通价格指数不标 total_return', () => {
      const tags = classifySingle({ name: '上证指数', exp_date: null });
      expect(tags).not.toContain('total_return');
    });
  });

  describe('classifySingle — 中小盘（仅提醒）', () => {
    for (const kw of ['上证小盘', '上证中盘', '国证', '巨潮']) {
      it(`name 含 ${kw} 标 small_cap`, () => {
        const tags = classifySingle({ name: `${kw}系列指数`, exp_date: null });
        expect(tags).toContain('small_cap');
      });
    }

    it('大盘宽基不标 small_cap', () => {
      const tags = classifySingle({ name: '沪深300', exp_date: null });
      expect(tags).not.toContain('small_cap');
    });
  });

  describe('classifySingle — 组合标签', () => {
    it('退市 + 跨境同时标', () => {
      const tags = classifySingle({ name: '港股通退市指数', exp_date: '20200101' });
      expect(tags).toContain('delisted');
      expect(tags).toContain('cross_border');
    });

    it('无任何噪声返回空数组', () => {
      const tags = classifySingle({ name: '上证指数', exp_date: null });
      expect(tags).toEqual([]);
    });
  });

  describe('classifyNoise — 多挂牌 duplicate', () => {
    it('同 6 位代码不同交易所标 duplicate，且 .SH 标为主挂牌', () => {
      const cands: NoiseCandidate[] = [
        { ts_code: '000300.SH', name: '沪深300', exp_date: null },
        { ts_code: '399300.SZ', name: '沪深300', exp_date: null },
      ];
      const result = classifyNoise(cands);
      const sh = result.find((r) => r.ts_code === '000300.SH');
      const sz = result.find((r) => r.ts_code === '399300.SZ');
      // 次挂牌（非 .SH）标 duplicate
      expect(sz?.noise_tags).toContain('duplicate');
      // 主挂牌（.SH）不标 duplicate
      expect(sh?.noise_tags).not.toContain('duplicate');
    });

    it('.SZ 无 .SH 兄弟时不标 duplicate（保持 .SZ 主挂牌）', () => {
      const cands: NoiseCandidate[] = [
        { ts_code: '399001.SZ', name: '深证成指', exp_date: null },
      ];
      const result = classifyNoise(cands);
      expect(result[0].noise_tags).not.toContain('duplicate');
    });

    it('三挂牌 000300.SH/399300.SZ/H00300.CSI：.SH 主，其余标 duplicate', () => {
      const cands: NoiseCandidate[] = [
        { ts_code: '000300.SH', name: '沪深300', exp_date: null },
        { ts_code: '399300.SZ', name: '沪深300', exp_date: null },
        { ts_code: 'H00300.CSI', name: '沪深300', exp_date: null },
      ];
      const result = classifyNoise(cands);
      const sh = result.find((r) => r.ts_code === '000300.SH');
      const sz = result.find((r) => r.ts_code === '399300.SZ');
      const csi = result.find((r) => r.ts_code === 'H00300.CSI');
      expect(sh?.noise_tags).not.toContain('duplicate');
      expect(sz?.noise_tags).toContain('duplicate');
      expect(csi?.noise_tags).toContain('duplicate');
    });

    it('代码相同交易所相同不标 duplicate（单条自己）', () => {
      const cands: NoiseCandidate[] = [
        { ts_code: '000300.SH', name: '沪深300', exp_date: null },
      ];
      const result = classifyNoise(cands);
      expect(result[0].noise_tags).not.toContain('duplicate');
    });

    it('无 ts_code 的候选不参与 duplicate 判定（安全降级）', () => {
      const cands: NoiseCandidate[] = [
        { ts_code: '', name: '沪深300', exp_date: null },
      ];
      const result = classifyNoise(cands);
      expect(result[0].noise_tags).not.toContain('duplicate');
    });
  });

  describe('classifyNoise — 端到端组合', () => {
    it('初始 8 个大盘宽基均不被标 delisted/cross_border/total_return/duplicate', () => {
      const initial8: NoiseCandidate[] = [
        { ts_code: '000001.SH', name: '上证指数', exp_date: null },
        { ts_code: '399001.SZ', name: '深证成指', exp_date: null },
        { ts_code: '399006.SZ', name: '创业板指', exp_date: null },
        { ts_code: '000688.SH', name: '科创50', exp_date: null },
        { ts_code: '000300.SH', name: '沪深300', exp_date: null },
        { ts_code: '000016.SH', name: '上证50', exp_date: null },
        { ts_code: '000905.SH', name: '中证500', exp_date: null },
        { ts_code: '000852.SH', name: '中证1000', exp_date: null },
      ];
      const result = classifyNoise(initial8);
      for (const r of result) {
        expect(r.noise_tags).not.toContain('delisted');
        expect(r.noise_tags).not.toContain('cross_border');
        expect(r.noise_tags).not.toContain('total_return');
        expect(r.noise_tags).not.toContain('duplicate');
      }
    });
  });
});

/**
 * market-snapshot.loader.spec.ts
 *
 * 覆盖 MarketSnapshotLoader.load 的「单象限空 match（通配）」路径：
 * 不区分大盘环境，每个 calendar 日期都应填入最小通配 snapshot，
 * 且全程不触碰 dataSource（无需查库）。
 */
import { MarketSnapshotLoader } from './market-snapshot.loader';
import { DataSource } from 'typeorm';
import { RegimeConfigMap } from '../../../../entities/strategy/regime-strategy-config.entity';

function makeWildcardConfig(action: 'trade' | 'flat' = 'trade'): RegimeConfigMap {
  return {
    quadrants: [
      {
        key: 'solo',
        label: '唯一象限',
        action,
        match: [],
      },
    ],
  };
}

describe('MarketSnapshotLoader — 单象限空 match 通配', () => {
  // 通配路径在 extractTargets 之前短路 return，不调用 dataSource；
  // 用一个会在被调用时抛错的 mock 来反向证明「未被触碰」。
  const boom = (): never => {
    throw new Error('dataSource 不应在通配路径被调用');
  };
  const fakeDataSource = { query: boom } as unknown as DataSource;
  const loader = new MarketSnapshotLoader(fakeDataSource);

  it('每个 calendar 日期都填入最小通配 snapshot', async () => {
    const calendar = ['20260101', '20260102', '20260103'];
    const result = await loader.load(makeWildcardConfig(), calendar, calendar);
    expect(result.size).toBe(3);
    for (const d of calendar) {
      const snap = result.get(d);
      expect(snap).toBeDefined();
      expect(snap!.date).toBe(d);
      expect(snap!.targets).toBeInstanceOf(Map);
      expect(snap!.targets.size).toBe(0);
    }
  });

  it('不调用 dataSource（通配短路）', async () => {
    // 若通配分支未生效，下面的 load 会走到 dataSource.query → boom 抛错。
    const result = await loader.load(
      makeWildcardConfig(),
      ['20260101', '20260102'],
      ['20260101', '20260102'],
    );
    expect(result.size).toBe(2);
  });

  it('空 calendar 仍返回空 Map（前置守卫优先于通配）', async () => {
    const result = await loader.load(makeWildcardConfig(), [], []);
    expect(result.size).toBe(0);
  });

  it('多象限配置不走通配路径（仍依赖 dataSource）', async () => {
    // 多象限 + 空 match：非通配，会走到 extractTargets（产出空 targetSet）
    // 随后 targets 全空分支返回空 Map，同样不触 dataSource.query。
    // 这里验证「多象限不触发通配填充」——结果应为空 Map 而非按 calendar 填充。
    const multi: RegimeConfigMap = {
      quadrants: [
        { key: 'a', label: 'a', action: 'flat', match: [] },
        { key: 'b', label: 'b', action: 'flat', match: [] },
      ],
    };
    const result = await loader.load(multi, ['20260101', '20260102'], ['20260101', '20260102']);
    expect(result.size).toBe(0);
  });
});

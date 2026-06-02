import { ThsIndexAmvService } from './industry-amv.service'

/**
 * ThsIndexAmvService.resolveIndexCodes — 按 type 过滤（病根修复）单测。
 *
 * 背景：旧实现 `WHERE m.tsCode LIKE '%.TI'` 不分 type，把行业(I)+概念(N)混算进
 * industry_amv_daily。修复后改为 innerJoin ths_index_catalog + `WHERE c.type=:indexType`。
 *
 * 本测覆盖**可单测的纯 JS 逻辑**：
 *  ① 按 indexType 给 query 传 `c.type=:indexType`（行业/概念互不越界）；
 *  ② 传入 tsCodes 时与解析结果取交集；空数组/不传按"不过滤"。
 * SQL innerJoin 的实际命中正确性由真 DB / 集成验证 —— 按 database-sql 规则，
 * mock QueryBuilder 验不出 join/水合，故此处只断言可单测的逻辑，不假装验证了 SQL。
 */
describe('ThsIndexAmvService.resolveIndexCodes — 按 type 过滤', () => {
  function makeService(rawRows: Array<{ tsCode: string }>) {
    const whereCalls: Array<{ clause: string; params: unknown }> = []
    const qb: Record<string, unknown> = {
      innerJoin: () => qb,
      select: () => qb,
      where: (clause: string, params: unknown) => {
        whereCalls.push({ clause, params })
        return qb
      },
      orderBy: () => qb,
      getRawMany: async () => rawRows,
    }
    // 只有 memberRepo 被 resolveIndexCodes 使用，其余依赖给空 stub 即可。
    const memberRepo = { createQueryBuilder: () => qb } as never
    const stub = {} as never
    const service = new ThsIndexAmvService(memberRepo, stub, stub, stub, stub, stub)
    // resolveIndexCodes 为 private，测试经 any 访问。
    const resolve = (indexType: 'I' | 'N', tsCodes?: string[]) =>
      (service as unknown as {
        resolveIndexCodes: (t: 'I' | 'N', c?: string[]) => Promise<string[]>
      }).resolveIndexCodes(indexType, tsCodes)
    return { resolve, whereCalls }
  }

  it("type='I'：以 c.type=:indexType 过滤、indexType 透传 'I'，返回全部解析代码", async () => {
    const { resolve, whereCalls } = makeService([{ tsCode: '700301.TI' }, { tsCode: '700302.TI' }])
    const result = await resolve('I')
    expect(whereCalls).toHaveLength(1)
    expect(whereCalls[0].clause).toContain('c.type')
    expect(whereCalls[0].params).toEqual({ indexType: 'I' })
    expect(result).toEqual(['700301.TI', '700302.TI'])
  })

  it("type='N'：indexType 透传 'N'（与 I 互不越界）", async () => {
    const { resolve, whereCalls } = makeService([{ tsCode: '885728.TI' }])
    await resolve('N')
    expect(whereCalls[0].params).toEqual({ indexType: 'N' })
  })

  it('传入 tsCodes：与解析结果取交集，丢弃不在结果中的代码', async () => {
    const { resolve } = makeService([
      { tsCode: '700301.TI' },
      { tsCode: '700302.TI' },
      { tsCode: '700303.TI' },
    ])
    const result = await resolve('I', ['700302.TI', '999999.TI'])
    expect(result).toEqual(['700302.TI'])
  })

  it('tsCodes 为空数组：按"不过滤"处理，返回全部', async () => {
    const { resolve } = makeService([{ tsCode: '700301.TI' }])
    const result = await resolve('I', [])
    expect(result).toEqual(['700301.TI'])
  })
})

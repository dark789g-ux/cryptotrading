/**
 * quant jobs 草稿态 API 客户端单测（M2 草稿态前端 / spec 06 §6.4）。
 *
 * 直接 mock 全局 fetch，验证 wire 形态：
 *  - quantApi.dispatchJob(id) → POST /api/quant/jobs/:id/dispatch（无 body）
 *  - quantApi.createJob({ as_draft }) → body 透传 as_draft
 *  - kellySweepApi.createSweepJob(cfg, { asDraft }) → 经 createJob 透传 as_draft + run_type=kelly_sweep
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { quantApi } from '../quant'
import { kellySweepApi, type SweepParams } from '../quant/kellySweep'

function mockFetchOnce(jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(jsonBody)),
  } as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function lastCallBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('quantApi.dispatchJob', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /api/quant/jobs/:id/dispatch（无 body）', async () => {
    const fetchMock = mockFetchOnce({ jobId: 'job-1' })
    const res = await quantApi.dispatchJob('job-1')

    expect(res).toEqual({ jobId: 'job-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/quant/jobs/job-1/dispatch')
    expect((init as RequestInit).method).toBe('POST')
    // dispatch 不带 body
    expect((init as RequestInit).body).toBeUndefined()
  })

  it('id 含特殊字符时被 encodeURIComponent', async () => {
    const fetchMock = mockFetchOnce({ jobId: 'a/b' })
    await quantApi.dispatchJob('a/b')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/quant/jobs/a%2Fb/dispatch')
  })
})

describe('quantApi.createJob as_draft 透传', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('as_draft=true 透传到 body', async () => {
    const fetchMock = mockFetchOnce({ id: 'job-1' })
    await quantApi.createJob({ run_type: 'train', params: {}, as_draft: true })

    const body = lastCallBody(fetchMock)
    expect(body.as_draft).toBe(true)
    expect(body.run_type).toBe('train')
  })

  it('不传 as_draft 时 body 无该键（向后兼容）', async () => {
    const fetchMock = mockFetchOnce({ id: 'job-1' })
    await quantApi.createJob({ run_type: 'train', params: {} })

    const body = lastCallBody(fetchMock)
    expect('as_draft' in body).toBe(false)
  })
})

describe('kellySweepApi.createSweepJob asDraft 透传', () => {
  afterEach(() => vi.unstubAllGlobals())

  const cfg = { base_trigger: { field: 'kdj_j', op: 'lt', value: 0 } } as unknown as SweepParams

  it('asDraft=true → body.as_draft=true + run_type=kelly_sweep', async () => {
    const fetchMock = mockFetchOnce({ id: 'job-1' })
    await kellySweepApi.createSweepJob(cfg, { asDraft: true })

    const body = lastCallBody(fetchMock)
    expect(body.run_type).toBe('kelly_sweep')
    expect(body.as_draft).toBe(true)
  })

  it('不传 opts → as_draft 为 undefined（JSON 序列化时被省略）', async () => {
    const fetchMock = mockFetchOnce({ id: 'job-1' })
    await kellySweepApi.createSweepJob(cfg)

    const body = lastCallBody(fetchMock)
    expect('as_draft' in body).toBe(false)
  })
})

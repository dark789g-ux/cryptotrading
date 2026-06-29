/**
 * AMV worker 线程池（镜像 indicators/indicator-worker-pool.ts）。
 *
 * 新建优于泛化：IndicatorWorkerPool 的 worker 入口写死 calcIndicatorsStreaming，
 * AMV 公式不同；泛化污染面更大。pool 调度（idle/busy/queue/drain/retire/自动重建）几乎照抄。
 *
 * 用法：run(tsCode, rows, seedState) → Promise<AmvWorkerResult>；用完 terminate() 释放线程。
 */
import { cpus } from 'os'
import * as path from 'path'
import { Worker } from 'worker_threads'
import type { AmvCalcState } from '../market-data/active-mv/amv-stream'
import type { AmvWorkerResult, AmvWorkerRow } from './amv-worker'

interface PendingAmvTask {
  tsCode: string
  rows: AmvWorkerRow[]
  seedState: AmvCalcState | null
  resolve: (result: AmvWorkerResult) => void
  reject: (err: Error) => void
}

interface ActiveAmvTask {
  resolve: (result: AmvWorkerResult) => void
  reject: (err: Error) => void
}

export class AmvWorkerPool {
  private readonly idle: Worker[] = []
  private readonly busy = new Map<Worker, ActiveAmvTask>()
  private readonly queue: PendingAmvTask[] = []
  private readonly workers: Worker[] = []
  private readonly retired = new Set<Worker>()
  private closed = false

  constructor(size = Math.min(4, Math.max(1, cpus().length - 1))) {
    for (let index = 0; index < size; index++) {
      const worker = this.createWorker()
      this.workers.push(worker)
      this.idle.push(worker)
    }
  }

  run(
    tsCode: string,
    rows: AmvWorkerRow[],
    seedState: AmvCalcState | null,
  ): Promise<AmvWorkerResult> {
    if (this.closed) {
      return Promise.reject(new Error('amv worker pool is closed'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ tsCode, rows, seedState, resolve, reject })
      this.drain()
    })
  }

  async terminate(): Promise<void> {
    this.closed = true
    const closeError = new Error('amv worker pool terminated')
    while (this.queue.length) {
      this.queue.shift()?.reject(closeError)
    }
    await Promise.all(this.workers.map((worker) => worker.terminate()))
    this.idle.length = 0
    this.busy.clear()
  }

  private createWorker(): Worker {
    const worker = new Worker(this.resolveWorkerPath(), {
      execArgv: this.resolveWorkerExecArgv(),
    })

    worker.on('message', (result: AmvWorkerResult) => {
      const task = this.busy.get(worker)
      if (!task) return
      this.busy.delete(worker)
      this.idle.push(worker)
      task.resolve(result)
      this.drain()
    })

    worker.on('error', (err) => {
      const task = this.busy.get(worker)
      if (task) {
        this.busy.delete(worker)
        task.reject(err)
      }
      this.retireWorker(worker)
      this.drain()
    })

    worker.on('exit', (code) => {
      if (this.closed || code === 0) return
      const task = this.busy.get(worker)
      if (task) {
        this.busy.delete(worker)
        task.reject(new Error(`amv worker exited with code ${code}`))
      }
      this.retireWorker(worker)
      this.drain()
    })

    return worker
  }

  private drain(): void {
    while (!this.closed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()
      const task = this.queue.shift()
      if (!worker || !task) return
      this.busy.set(worker, { resolve: task.resolve, reject: task.reject })
      worker.postMessage({ tsCode: task.tsCode, rows: task.rows, seedState: task.seedState })
    }
  }

  private retireWorker(worker: Worker): void {
    if (this.retired.has(worker)) return
    this.retired.add(worker)

    const index = this.workers.indexOf(worker)
    if (index >= 0) this.workers.splice(index, 1)
    const idleIndex = this.idle.indexOf(worker)
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1)

    if (this.closed) return

    const replacement = this.createWorker()
    this.workers.push(replacement)
    this.idle.push(replacement)
  }

  private resolveWorkerPath(): string {
    const extension = path.extname(__filename) === '.ts' ? '.ts' : '.js'
    return path.join(__dirname, `amv-worker${extension}`)
  }

  private resolveWorkerExecArgv(): string[] {
    return path.extname(__filename) === '.ts' ? ['-r', 'ts-node/register'] : []
  }
}

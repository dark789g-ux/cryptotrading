import { cpus } from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { KlineRow } from './indicators';
import type { IndicatorCalcState, KlineRowWithIndicatorState } from './indicators-stream';

interface PendingIndicatorTask {
  rows: KlineRow[];
  seedState: IndicatorCalcState | null;
  resolve: (result: KlineRowWithIndicatorState[]) => void;
  reject: (err: Error) => void;
}

interface ActiveIndicatorTask {
  resolve: (result: KlineRowWithIndicatorState[]) => void;
  reject: (err: Error) => void;
}

export class IndicatorWorkerPool {
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, ActiveIndicatorTask>();
  private readonly queue: PendingIndicatorTask[] = [];
  private readonly workers: Worker[] = [];
  private readonly retired = new Set<Worker>();
  private closed = false;

  constructor(size = Math.min(4, Math.max(1, cpus().length - 1))) {
    for (let index = 0; index < size; index++) {
      const worker = this.createWorker();
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  run(rows: KlineRow[], seedState: IndicatorCalcState | null): Promise<KlineRowWithIndicatorState[]> {
    if (this.closed) {
      return Promise.reject(new Error('indicator worker pool is closed'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ rows, seedState, resolve, reject });
      this.drain();
    });
  }

  async terminate(): Promise<void> {
    this.closed = true;
    const closeError = new Error('indicator worker pool terminated');
    while (this.queue.length) {
      this.queue.shift()?.reject(closeError);
    }

    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.idle.length = 0;
    this.busy.clear();
  }

  private createWorker(): Worker {
    const worker = new Worker(this.resolveWorkerPath(), {
      execArgv: this.resolveWorkerExecArgv(),
    });

    worker.on('message', (result: KlineRowWithIndicatorState[]) => {
      const task = this.busy.get(worker);
      if (!task) return;
      this.busy.delete(worker);
      this.idle.push(worker);
      task.resolve(result);
      this.drain();
    });

    worker.on('error', (err) => {
      const task = this.busy.get(worker);
      if (task) {
        this.busy.delete(worker);
        task.reject(err);
      }
      this.retireWorker(worker);
      this.drain();
    });

    worker.on('exit', (code) => {
      if (this.closed || code === 0) return;
      const task = this.busy.get(worker);
      if (task) {
        this.busy.delete(worker);
        task.reject(new Error(`indicator worker exited with code ${code}`));
      }
      this.retireWorker(worker);
      this.drain();
    });

    return worker;
  }

  private drain(): void {
    while (!this.closed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const task = this.queue.shift();
      if (!worker || !task) return;

      this.busy.set(worker, { resolve: task.resolve, reject: task.reject });
      worker.postMessage({ rows: task.rows, seedState: task.seedState });
    }
  }

  private retireWorker(worker: Worker): void {
    if (this.retired.has(worker)) return;
    this.retired.add(worker);

    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);

    if (this.closed) return;

    const replacement = this.createWorker();
    this.workers.push(replacement);
    this.idle.push(replacement);
  }

  private resolveWorkerPath(): string {
    const extension = path.extname(__filename) === '.ts' ? '.ts' : '.js';
    return path.join(__dirname, `indicator-worker${extension}`);
  }

  private resolveWorkerExecArgv(): string[] {
    return path.extname(__filename) === '.ts' ? ['-r', 'ts-node/register'] : [];
  }
}

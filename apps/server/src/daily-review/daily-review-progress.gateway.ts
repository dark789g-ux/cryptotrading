import { Injectable, Logger } from '@nestjs/common';
import { ReplaySubject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ProgressEvent } from './daily-review.types';

// 60s 保留窗口的用途：让"完成瞬间用户刚跳转过来"仍能从 ReplaySubject 拿到完整历史
const DISPOSE_DELAY_MS = 60_000;

@Injectable()
export class DailyReviewProgressGateway {
  private readonly logger = new Logger(DailyReviewProgressGateway.name);
  private subjects = new Map<string, ReplaySubject<ProgressEvent>>();
  // completedAt 与 subjects 分离：hasActive 用它判断"是否仍在跑"，而 subjects 还在保留窗口期
  private completedAt = new Map<string, number>();
  private disposers = new Map<string, ReturnType<typeof setTimeout>>();

  emit(tradeDate: string, e: ProgressEvent) {
    const s = this.ensureSubject(tradeDate);
    s.next(e);
    if (e.type === 'completed' || e.type === 'failed') {
      this.completedAt.set(tradeDate, Date.now());
      // 立即 complete 可让新订阅者收到 onCompleted；但 subject 仍在 map 中保留 60s
      s.complete();
      const prev = this.disposers.get(tradeDate);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => this.dispose(tradeDate), DISPOSE_DELAY_MS);
      // unref 让 Node 进程不被回收 timer 阻塞退出（测试与正常关停均受益）
      if (typeof (t as any).unref === 'function') (t as any).unref();
      this.disposers.set(tradeDate, t);
    }
  }

  observe(tradeDate: string, isAdmin: boolean): Observable<ProgressEvent> {
    const s = this.ensureSubject(tradeDate);
    const obs = s.asObservable();
    if (isAdmin) return obs;
    // 非 admin 不应看到 reasoning 文本与 token 用量（与 getDetail 的 admin strip 一致）
    return obs.pipe(filter((e) => e.type !== 'reasoning_delta' && e.type !== 'usage'));
  }

  hasActive(tradeDate: string): boolean {
    // 60s 保留期内同一日期允许重新发起生成，所以 hasActive 必须排除已完成态
    return this.subjects.has(tradeDate) && !this.completedAt.has(tradeDate);
  }

  // 仅供测试：强制立即清理（用于不依赖真实 timer）
  forceDispose(tradeDate: string): void {
    const t = this.disposers.get(tradeDate);
    if (t) clearTimeout(t);
    this.dispose(tradeDate);
  }

  private ensureSubject(tradeDate: string): ReplaySubject<ProgressEvent> {
    let s = this.subjects.get(tradeDate);
    if (!s) {
      s = new ReplaySubject<ProgressEvent>(Infinity, Infinity);
      this.subjects.set(tradeDate, s);
    }
    return s;
  }

  private dispose(tradeDate: string): void {
    this.subjects.delete(tradeDate);
    this.completedAt.delete(tradeDate);
    this.disposers.delete(tradeDate);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ReplaySubject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ProgressEvent } from './types/daily-review.types';

// 60s 保留窗口的用途：让"完成瞬间用户刚跳转过来"仍能从 ReplaySubject 拿到完整历史
const DISPOSE_DELAY_MS = 60_000;
// tool_call.args 可能很大（如 search_news 的长 query 或 lookup_stock 的多字段），
// 序列化后超过该阈值即截断，避免 WebSocket payload 膨胀（与 spec §3 / §7 一致）
const TOOL_CALL_ARGS_MAX_CHARS = 500;

@Injectable()
export class DailyReviewProgressGateway {
  private readonly logger = new Logger(DailyReviewProgressGateway.name);
  private subjects = new Map<string, ReplaySubject<ProgressEvent>>();
  // completedAt 与 subjects 分离：hasActive 用它判断"是否仍在跑"，而 subjects 还在保留窗口期
  private completedAt = new Map<string, number>();
  private disposers = new Map<string, ReturnType<typeof setTimeout>>();

  emit(tradeDate: string, e: ProgressEvent) {
    const s = this.ensureSubject(tradeDate);
    // tool_call 事件：args 体积可能较大，先做序列化截断；其它字段透传
    // 注意 tool_call 不切 stage（嵌在 'investigate' stage 内的子事件），也不影响 active 判定
    const out: ProgressEvent = e.type === 'tool_call' ? this.truncateToolCallArgs(e) : e;
    s.next(out);
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
    // 非 admin 不应看到 reasoning 文本、token 用量与 tool_call（spec §8：tool_call 面板 admin-only）
    return obs.pipe(
      filter((e) => e.type !== 'reasoning_delta' && e.type !== 'usage' && e.type !== 'tool_call'),
    );
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

  /**
   * tool_call.args 可能因 LLM 自由组合参数而体积过大（如 lookup_stock 一次性传大量字段）。
   * 这里只在序列化超过阈值时截断，把超出部分塞回一个 `__truncated` 字符串字段；
   * 序列化失败（含循环引用）兜底为 `{ __unserializable: true }`，避免推到客户端时整条事件失败。
   */
  private truncateToolCallArgs(
    e: Extract<ProgressEvent, { type: 'tool_call' }>,
  ): ProgressEvent {
    let serialized: string;
    try {
      serialized = JSON.stringify(e.args ?? {});
    } catch {
      return { ...e, args: { __unserializable: true } };
    }
    if (serialized.length <= TOOL_CALL_ARGS_MAX_CHARS) return e;
    return {
      ...e,
      args: {
        __truncated: serialized.slice(0, TOOL_CALL_ARGS_MAX_CHARS),
        __originalChars: serialized.length,
      },
    };
  }
}

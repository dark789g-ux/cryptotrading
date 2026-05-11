import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import type { ProgressEvent } from './daily-review.types';

@Injectable()
export class DailyReviewProgressGateway {
  private subjects = new Map<string, Subject<ProgressEvent>>();

  emit(tradeDate: string, e: ProgressEvent) {
    const s = this.subjects.get(tradeDate);
    if (s) s.next(e);
    if (e.stage === 'completed' || e.stage === 'failed') {
      s?.complete();
      this.subjects.delete(tradeDate);
    }
  }

  observe(tradeDate: string): Observable<ProgressEvent> {
    let s = this.subjects.get(tradeDate);
    if (!s) {
      s = new Subject<ProgressEvent>();
      this.subjects.set(tradeDate, s);
    }
    return s.asObservable();
  }

  hasActive(tradeDate: string) {
    return this.subjects.has(tradeDate);
  }
}

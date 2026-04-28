import { parentPort } from 'worker_threads';
import type { KlineRow } from './indicators';
import { calcIndicatorsStreaming, normalizeIndicatorCalcState } from './indicators-stream';

interface IndicatorWorkerMessage {
  rows: KlineRow[];
  seedState: unknown;
}

parentPort?.on('message', ({ rows, seedState }: IndicatorWorkerMessage) => {
  const normalized = normalizeIndicatorCalcState(seedState);
  parentPort?.postMessage(calcIndicatorsStreaming(rows, normalized));
});

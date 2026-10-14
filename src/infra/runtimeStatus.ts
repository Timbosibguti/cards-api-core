import { logger } from './logger.js';

export type PollerKind = 'transactions' | 'cards' | 'otp';

export interface PollerStatus {
  kind: 'poller';
  id: string; // например ecards.transactions
  bank?: string;
  entity: PollerKind;
  lastCycleStartedAt?: string;
  lastCycleFinishedAt?: string;
  lastItemCreatedAt?: string;
  processedInLastCycle?: number;
  totalInLastCycle?: number;
  lastError?: string;
}

export interface WorkerStatus {
  kind: 'worker';
  id: string; // например profileAuthChange
  lastRunAt?: string;
  lastBatchCount?: number;
  lastError?: string;
}

export interface RuntimeStatusSnapshot {
  pollers: PollerStatus[];
  workers: WorkerStatus[];
}

const pollers = new Map<string, PollerStatus>();
const workers = new Map<string, WorkerStatus>();

export function updatePollerStatus(
  id: string,
  patch: Partial<PollerStatus> & Pick<PollerStatus, 'entity'>,
): void {
  const prev: PollerStatus =
    pollers.get(id) ?? {
      kind: 'poller',
      id,
      entity: patch.entity,
    };
  const next: PollerStatus = {
    ...prev,
    ...patch,
    kind: 'poller',
    id,
  };
  pollers.set(id, next);
}

export function updateWorkerStatus(id: string, patch: Partial<WorkerStatus>): void {
  const prev: WorkerStatus = workers.get(id) ?? { kind: 'worker', id };
  const next: WorkerStatus = {
    ...prev,
    ...patch,
    kind: 'worker',
    id,
  };
  workers.set(id, next);
}

export function getRuntimeStatusSnapshot(): RuntimeStatusSnapshot {
  return {
    pollers: Array.from(pollers.values()),
    workers: Array.from(workers.values()),
  };
}

// На случай отладки «ничего не обновляется» можно вызвать из REPL.
export function logRuntimeStatusOnce(): void {
  const snapshot = getRuntimeStatusSnapshot();
  logger.debug('Runtime status snapshot', snapshot);
}


/**
 * In-process typed event bus (DESIGN §1).
 * The bus only carries "something changed" signals: it is never a data source
 * of record. Every consumer re-reads the facts from SQLite (OB-01).
 */
import { EventEmitter } from "node:events";

export type BusEvents = {
  /** Anything that affects the global overview changed. */
  overview: [];
  /** A run produced new events; payload is the run id only. */
  run: [{ runId: string }];
  /** A doubt was opened, answered or closed. */
  doubt: [{ doubtId: string }];
  /** Engine detection/auth state changed. */
  health: [];
};

class TypedBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.emitter.emit(event as string, ...args);
  }

  on<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): () => void {
    this.emitter.on(event as string, listener as (...args: unknown[]) => void);
    return () => {
      this.emitter.off(event as string, listener as (...args: unknown[]) => void);
    };
  }
}

export type Bus = TypedBus;

export function createBus(): Bus {
  return new TypedBus();
}

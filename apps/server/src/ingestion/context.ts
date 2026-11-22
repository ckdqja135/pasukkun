import type { FetchOptions } from '../common/http.js';
import type { AppEnv } from '../config/env.js';
import type { NormalizedAdvisory } from './normalized.js';
import type { UpsertResult } from './upsert.service.js';

export type ScheduledSource = 'GHSA' | 'NVD' | 'KEV' | 'EPSS';

/** 수집 1회 실행 동안 어댑터가 쓰는 도구 모음 */
export interface IngestContext {
  env: AppEnv;
  /** 초기 적재가 끝난 뒤에만 true - 초기 적재분은 알림을 만들지 않는다 */
  emitEvents: boolean;
  fetch(url: string, options?: FetchOptions): Promise<Response>;
  sleep(ms: number): Promise<void>;
  getCheckpoint<T>(stream: string): Promise<T | null>;
  /** 성공적으로 저장을 마친 범위까지만 호출한다 */
  setCheckpoint(stream: string, cursor: object): Promise<void>;
  upsert(advisory: NormalizedAdvisory): Promise<UpsertResult>;
  /** 이미 알고 있는 식별자인지 (다른 출처나 프로젝트 검사로 저장된 취약점) */
  hasIdentifier(value: string): Promise<boolean>;
  setWindow(from: Date | null, to: Date | null): void;
  count(kind: 'fetched' | 'upserted' | 'changed', amount?: number): void;
  /** 오래 걸리는 수집에서 작업 잠금을 연장한다 */
  heartbeat(): Promise<void>;
}

export interface SourceAdapter {
  readonly key: ScheduledSource;
  run(context: IngestContext): Promise<void>;
}

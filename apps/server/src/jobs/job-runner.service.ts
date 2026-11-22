import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { JobService, type ClaimedJob } from './job.service.js';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

interface Registration {
  lane: string;
  handler: JobHandler;
}

const LANE_LEASE_MS: Record<string, number> = {
  /** 수집은 오래 걸릴 수 있다 (NVD 초기 적재). 실행 중 잠금을 연장한다. */
  ingest: 20 * 60_000,
  work: 10 * 60_000,
};
const IDLE_MS = 1500;

/**
 * 작업 유형별 처리기를 등록하고 lane 별로 하나씩 순차 실행한다.
 * lane 을 나눠 긴 수집 작업이 프로젝트 검사를 막지 않게 한다.
 */
@Injectable()
export class JobRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunner.name);
  private readonly registrations = new Map<string, Registration>();
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(private readonly jobs: JobService) {}

  register(type: string, lane: 'ingest' | 'work', handler: JobHandler): void {
    this.registrations.set(type, { lane, handler });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const lanes = new Set([...this.registrations.values()].map((r) => r.lane));
    for (const lane of lanes) this.loops.push(this.loop(lane));
  }

  /** 대기 중인 작업을 한 번에 하나씩 모두 처리한다 (테스트·CLI 용). */
  async drain(maxJobs = 1000): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      const job = await this.jobs.claim([...this.registrations.keys()], LANE_LEASE_MS.work);
      if (!job) break;
      await this.execute(job);
      processed += 1;
    }
    return processed;
  }

  private async loop(lane: string): Promise<void> {
    const types = [...this.registrations.entries()].filter(([, r]) => r.lane === lane).map(([type]) => type);
    while (this.running) {
      let job: ClaimedJob | null = null;
      try {
        job = await this.jobs.claim(types, LANE_LEASE_MS[lane] ?? LANE_LEASE_MS.work);
      } catch (error) {
        this.logger.warn(`작업 선점 실패(${lane}): ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
        continue;
      }
      await this.execute(job);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const registration = this.registrations.get(job.type);
    try {
      if (!registration) throw new Error(`처리기가 없는 작업 유형: ${job.type}`);
      await registration.handler(job);
      await this.jobs.succeed(job.id);
    } catch (error) {
      const outcome = await this.jobs.fail(job, error).catch(() => 'FAILED' as const);
      this.logger.warn(
        `작업 ${job.type}(${job.id}) 실패 → ${outcome === 'RETRY' ? '재시도 예정' : '최종 실패'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await Promise.race([Promise.allSettled(this.loops), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

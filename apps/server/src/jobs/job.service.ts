import { Injectable } from '@nestjs/common';
import { PrismaService, type Db } from '../db/prisma.service.js';

export interface EnqueueOptions {
  /** 같은 키의 대기 중 작업이 있으면 새로 넣지 않는다 */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** SQLite 테이블 기반 작업 큐. Redis 없이 재시도·지연 실행·중단 복구를 처리한다. */
@Injectable()
export class JobService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(type: string, payload: Record<string, unknown>, options: EnqueueOptions = {}, db: Db = this.prisma): Promise<string | null> {
    if (options.dedupeKey) {
      const pending = await db.job.findFirst({ where: { dedupeKey: options.dedupeKey, status: 'QUEUED' }, select: { id: true } });
      if (pending) return null;
    }
    const job = await db.job.create({
      data: {
        type,
        payload: payload as object,
        dedupeKey: options.dedupeKey,
        runAt: options.runAt ?? new Date(),
        maxAttempts: options.maxAttempts ?? 3,
      },
    });
    return job.id;
  }

  /** 실행할 작업 하나를 선점한다. 잠금이 만료된 RUNNING 작업은 중단된 것으로 보고 다시 가져온다. */
  async claim(types: string[], leaseMs: number): Promise<ClaimedJob | null> {
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = await this.prisma.job.findFirst({
        where: {
          type: { in: types },
          OR: [
            { status: 'QUEUED', runAt: { lte: now } },
            { status: 'RUNNING', lockedUntil: { lt: now } },
          ],
        },
        orderBy: { runAt: 'asc' },
      });
      if (!candidate) return null;
      // 조건부 갱신으로 선점 경쟁을 막는다.
      const claimed = await this.prisma.job.updateMany({
        where: { id: candidate.id, status: candidate.status, attempts: candidate.attempts },
        data: { status: 'RUNNING', attempts: { increment: 1 }, lockedUntil: new Date(now.getTime() + leaseMs) },
      });
      if (claimed.count === 1) {
        return {
          id: candidate.id,
          type: candidate.type,
          payload: (candidate.payload ?? {}) as Record<string, unknown>,
          attempts: candidate.attempts + 1,
          maxAttempts: candidate.maxAttempts,
        };
      }
    }
    return null;
  }

  async extendLease(id: string, leaseMs: number): Promise<void> {
    await this.prisma.job.updateMany({ where: { id, status: 'RUNNING' }, data: { lockedUntil: new Date(Date.now() + leaseMs) } });
  }

  async succeed(id: string): Promise<void> {
    await this.prisma.job.update({ where: { id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), lockedUntil: null, lastError: null } });
  }

  /** 재시도 한도 안이면 지수 백오프로 다시 대기시키고, 넘으면 최종 실패로 남긴다. */
  async fail(job: ClaimedJob, error: unknown): Promise<'RETRY' | 'FAILED'> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    if (job.attempts >= job.maxAttempts) {
      await this.prisma.job.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), lockedUntil: null, lastError: message } });
      return 'FAILED';
    }
    const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** (job.attempts - 1));
    await this.prisma.job.update({
      where: { id: job.id },
      data: { status: 'QUEUED', runAt: new Date(Date.now() + delayMs), lockedUntil: null, lastError: message },
    });
    return 'RETRY';
  }

  async purgeFinished(olderThan: Date): Promise<number> {
    const result = await this.prisma.job.deleteMany({ where: { status: { in: ['SUCCEEDED', 'FAILED'] }, finishedAt: { lt: olderThan } } });
    return result.count;
  }
}

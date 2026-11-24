import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { AssessmentService } from './assessment/assessment.service.js';
import type { AppEnv } from './config/env.js';
import { APP_ENV } from './db/db.module.js';
import { PrismaService } from './db/prisma.service.js';
import type { ScheduledSource } from './ingestion/context.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { VulnerabilityUpsertService } from './ingestion/upsert.service.js';
import { JobRunner } from './jobs/job-runner.service.js';
import { JobService } from './jobs/job.service.js';
import { BotListener } from './notification/bot-listener.service.js';
import { ChannelService } from './notification/channel.service.js';
import { DeliveryService } from './notification/delivery.service.js';
import { BriefingService } from './notification/briefing.service.js';
import { GithubLinkService } from './github/github-link.service.js';
import { GithubSyncService } from './github/github-sync.service.js';
import { ProjectService } from './project/project.service.js';
import { ScanService } from './scan/scan.service.js';

const SCHEDULER_INTERVAL_MS = 60_000;
const NOTIFY_INTERVAL_MS = 1500;
const DAY_MS = 86_400_000;

@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private timers: NodeJS.Timeout[] = [];
  private notifying = false;
  private scheduling = false;

  constructor(
    private readonly runner: JobRunner,
    private readonly jobs: JobService,
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly upserts: VulnerabilityUpsertService,
    private readonly scans: ScanService,
    private readonly assessment: AssessmentService,
    private readonly projects: ProjectService,
    private readonly deliveries: DeliveryService,
    private readonly briefings: BriefingService,
    private readonly bots: BotListener,
    private readonly channels: ChannelService,
    private readonly githubSync: GithubSyncService,
    private readonly githubLinks: GithubLinkService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** 작업 유형별 처리기를 등록한다. 테스트에서도 같은 등록을 쓴다. */
  registerHandlers(): void {
    this.runner.register('ingest', 'ingest', (job) => this.ingestion.run(job.payload.source as ScheduledSource, job.id));
    this.runner.register('retag-all', 'ingest', async () => {
      this.logger.log(`기술 태그 재계산: ${await this.upserts.retagAll()}건`);
    });
    this.runner.register('scan', 'work', (job) => this.scans.run(job.payload.scanId as string, job.id));
    this.runner.register('briefing', 'work', (job) =>
      this.briefings.build(job.payload.ruleId as string, new Date(job.payload.slotAt as string), new Date(job.payload.fromAt as string)),
    );
    this.runner.register('github-sync', 'work', async (job) => {
      await this.githubSync.sync(job.payload.projectId as string);
    });
    this.runner.register('reassess-vulnerability', 'work', async (job) => {
      await this.assessment.reassessVulnerability(job.payload.vulnerabilityId as string, job.payload.silent === true);
    });
    this.runner.register('reprioritize-project', 'work', (job) =>
      this.assessment.reprioritizeProject(job.payload.projectId as string, (job.payload.reason as string) ?? '프로젝트 환경 정보가 변경됨'),
    );
  }

  start(): void {
    this.registerHandlers();
    // 이전 프로세스가 중단되면서 "실행 중"으로 남은 수집 기록을 정리한다. (체크포인트는 저장을 마친 범위까지만 전진해 있다.)
    void this.prisma.ingestionRun
      .updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', error: '프로세스가 중단되어 완료되지 않음', finishedAt: new Date() } })
      .catch(() => undefined);
    // Worker 는 한 개만 실행하므로, 시작 시점에 "실행 중"으로 남아 있는 작업은 중단된 것이다.
    // 잠금 만료를 기다리지 않고 바로 다시 가져가 체크포인트에서 이어 간다.
    void this.prisma.job.updateMany({ where: { status: 'RUNNING' }, data: { lockedUntil: new Date(0) } }).catch(() => undefined);
    this.runner.start();
    this.bots.start();
    this.timers.push(setInterval(() => void this.notifyTick(), NOTIFY_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.schedulerTick(), SCHEDULER_INTERVAL_MS));
    void this.schedulerTick();
    this.logger.log('Worker 시작: 수집·검사·알림 처리 대기 중');
  }

  /** Outbox 중계와 발송. 한 번에 하나만 돌게 한다. */
  async notifyTick(): Promise<void> {
    if (this.notifying) return;
    this.notifying = true;
    try {
      await this.deliveries.relayPending();
      await this.deliveries.processDue();
    } catch (error) {
      this.logger.warn(`알림 처리 오류: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.notifying = false;
    }
  }

  /** 정기 수집·재검사·일일 요약·정리 작업을 예약한다. */
  async schedulerTick(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      const queued = await this.ingestion.enqueueDue();
      if (queued.length > 0) this.logger.log(`수집 예약: ${queued.join(', ')}`);
      if (!this.env.disableIngestion) {
        await this.scans.enqueueDueRescans(this.env.rescanMinutes, (projectId, snapshotId) =>
          this.prisma.$transaction((tx) => this.projects.createScan(tx, projectId, snapshotId, 'SCHEDULED')),
        );
      }
      await this.githubSync.enqueueDue();
      await this.deliveries.createDueDigests();
      await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await this.jobs.purgeFinished(new Date(Date.now() - 7 * DAY_MS));
      await this.deliveries.purge(new Date(Date.now() - 180 * DAY_MS));
      await this.briefings.purge(new Date(Date.now() - 180 * DAY_MS));
      await this.channels.purgeLinkRequests(new Date(Date.now() - DAY_MS));
      await this.githubLinks.purgeLinkRequests(new Date(Date.now() - DAY_MS));
      await this.prisma.ingestionRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - 30 * DAY_MS) } } });
    } catch (error) {
      this.logger.warn(`스케줄러 오류: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.scheduling = false;
    }
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

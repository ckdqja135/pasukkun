import { gunzipSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { JobService } from '../../jobs/job.service.js';
import type { IngestContext, SourceAdapter } from '../context.js';

/**
 * FIRST EPSS - 공식 일별 전체 CSV.
 * 역할: 향후 30일 내 악용 활동이 관측될 확률 추정치 보완.
 * (심각도 점수가 아니며, 우리 프로젝트가 공격받을 확률도 아니다.)
 * 출처: https://www.first.org/epss/data - 대량 동기화는 API 가 아닌 일별 파일을 쓰도록 안내되어 있다.
 */
const DAILY_CSV = 'https://epss.empiricalsecurity.com/epss_scores-current.csv.gz';
const BATCH = 500;

export interface EpssFile {
  scoreDate: string | null;
  modelVersion: string | null;
  rows: Map<string, { score: number; percentile: number }>;
}

/** CSV 를 해석한다. wanted 가 주어지면 그 CVE 만 남긴다. */
export function parseEpssCsv(text: string, wanted?: Set<string>): EpssFile {
  const file: EpssFile = { scoreDate: null, modelVersion: null, rows: new Map() };
  let headerSeen = false;
  let position = 0;
  while (position < text.length) {
    let end = text.indexOf('\n', position);
    if (end === -1) end = text.length;
    const line = text.slice(position, end).trim();
    position = end + 1;
    if (line === '') continue;
    if (line.startsWith('#')) {
      file.modelVersion = /model_version:([^,]+)/.exec(line)?.[1] ?? null;
      file.scoreDate = /score_date:(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? null;
      continue;
    }
    if (!headerSeen) {
      headerSeen = true;
      if (line.toLowerCase() !== 'cve,epss,percentile') throw new Error(`EPSS CSV 헤더가 예상과 다릅니다: ${line.slice(0, 80)}`);
      continue;
    }
    const [cve, score, percentile] = line.split(',');
    if (!cve || (wanted && !wanted.has(cve))) continue;
    const scoreValue = Number(score);
    const percentileValue = Number(percentile);
    if (!Number.isFinite(scoreValue) || !Number.isFinite(percentileValue)) continue;
    file.rows.set(cve, { score: scoreValue, percentile: percentileValue });
  }
  if (!headerSeen) throw new Error('EPSS CSV 에 헤더가 없습니다.');
  return file;
}

@Injectable()
export class EpssAdapter implements SourceAdapter {
  readonly key = 'EPSS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobService,
  ) {}

  async run(context: IngestContext): Promise<void> {
    const response = await context.fetch(DAILY_CSV, { timeoutMs: 120_000, redirect: 'follow' });
    // 공식 주소는 같은 호스트의 날짜별 파일로 리다이렉트한다. 다른 호스트로 넘어갔다면 받지 않는다.
    if (response.url && new URL(response.url).hostname !== new URL(DAILY_CSV).hostname) {
      throw new Error(`EPSS 파일이 예상하지 않은 호스트로 리다이렉트되었습니다: ${new URL(response.url).hostname}`);
    }
    // 압축을 풀었을 때의 크기에 상한을 둔다 (현재 파일은 약 15MB).
    const text = gunzipSync(Buffer.from(await response.arrayBuffer()), { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8');

    const identifiers = await this.prisma.vulnerabilityIdentifier.findMany({
      where: { type: 'CVE' },
      select: { value: true, vulnerabilityId: true },
    });
    const file = parseEpssCsv(text, new Set(identifiers.map((row) => row.value)));
    context.setWindow(null, new Date());
    context.count('fetched', file.rows.size);
    if (!file.scoreDate) throw new Error('EPSS 파일에서 기준일(score_date)을 찾지 못했습니다.');

    // 한 취약점에 CVE 가 여럿이면 가장 높은 점수를 쓴다.
    const best = new Map<string, { score: number; percentile: number }>();
    for (const identifier of identifiers) {
      const row = file.rows.get(identifier.value);
      if (!row) continue;
      const current = best.get(identifier.vulnerabilityId);
      if (!current || row.score > current.score) best.set(identifier.vulnerabilityId, row);
    }

    const existing = new Map(
      (
        await this.prisma.vulnerability.findMany({
          where: { id: { in: [...best.keys()] } },
          select: { id: true, epssScore: true, epssDate: true },
        })
      ).map((row) => [row.id, row]),
    );
    const threshold = context.env.epssThreshold;
    const crossed: string[] = [];
    const pending = [...best.entries()].filter(([id, row]) => {
      const before = existing.get(id);
      return !before || before.epssScore !== row.score || before.epssDate !== file.scoreDate;
    });

    for (let offset = 0; offset < pending.length; offset += BATCH) {
      const slice = pending.slice(offset, offset + BATCH);
      await this.prisma.$transaction(
        slice.map(([id, row]) =>
          this.prisma.vulnerability.update({
            where: { id },
            data: { epssScore: row.score, epssPercentile: row.percentile, epssDate: file.scoreDate },
          }),
        ),
      );
      for (const [id, row] of slice) {
        const before = existing.get(id)?.epssScore ?? null;
        if (before !== row.score) context.count('changed');
        // 임계값을 새로 넘은 경우에만 우선순위가 달라질 수 있다.
        if ((before === null || before < threshold) && row.score >= threshold) crossed.push(id);
      }
      context.count('upserted', slice.length);
      await context.heartbeat();
    }

    if (crossed.length > 0) {
      const withFindings = await this.prisma.finding.findMany({
        where: { vulnerabilityId: { in: crossed }, resolvedAt: null },
        select: { vulnerabilityId: true },
        distinct: ['vulnerabilityId'],
      });
      for (const row of withFindings) {
        await this.jobs.enqueue(
          'reassess-vulnerability',
          { vulnerabilityId: row.vulnerabilityId, silent: !context.emitEvents },
          { dedupeKey: `reassess:${row.vulnerabilityId}:${context.emitEvents ? 'loud' : 'silent'}` },
        );
      }
    }
    await context.setCheckpoint('daily', { scoreDate: file.scoreDate, modelVersion: file.modelVersion });
  }
}

import { FindingListItemDto } from '../assessment/finding.dto.js';
import { VulnerabilityListItemDto } from '../vulnerability/vulnerability.dto.js';

export class SourceStatusDto {
  /** GHSA, OSV, NVD, KEV, EPSS */
  key: string;
  /** 이 소스가 맡는 역할 */
  role: string;
  enabled: boolean;
  intervalMinutes: number;
  /** NEVER_RUN: 아직 실행 전 / OK / FAILING: 최근 수집 실패 */
  status: 'NEVER_RUN' | 'OK' | 'FAILING';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** 초기 적재 완료 여부 */
  backfillDone: boolean;
  /** 마지막 성공이 주기의 2배보다 오래됨 */
  lagging: boolean;
  /** 지금 수집이 진행 중인지 */
  running: boolean;
  /** 마지막으로 끝난 수집에서 새로 들어오거나 바뀐 항목 수 */
  recentChanged: number | null;
  /** 이 출처에서 받아 둔 항목 수 */
  totalItems: number;
}

export class IngestionRunDto {
  id: string;
  source: string;
  status: string;
  windowFrom: string | null;
  windowTo: string | null;
  fetched: number;
  upserted: number;
  changed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class IngestionStatusDto {
  sources: SourceStatusDto[];
  recentRuns: IngestionRunDto[];
  /** 수집된 취약점 수 (피드의 "전체" 범위) */
  vulnerabilityCount: number;
  /** 최초 피드 적재 범위(일) */
  initialFeedDays: number;
  /** 대기·실행 중인 백그라운드 작업 수 */
  pendingJobs: number;
}

export class DashboardCardDto {
  key: string;
  label: string;
  description: string;
  count: number;
  /** 이 숫자를 만든 필터. 목록 화면이 같은 필터를 그대로 쓴다. */
  query: object;
}

export class DashboardProjectDto {
  id: string;
  name: string;
  lastScanStatus: string | null;
  lastScanAt: string | null;
  hasSnapshot: boolean;
  urgent: number;
  open: number;
}

export class DashboardDto {
  cards: DashboardCardDto[];
  /** 긴급 검토 항목 (cards 의 urgent 와 같은 필터) */
  urgentFindings: FindingListItemDto[];
  /** 최근 공개 취약점. 저장된 관심 기술이 있으면 그 기준, 없으면 수집된 전체 */
  recentVulnerabilities: VulnerabilityListItemDto[];
  recentQuery: object;
  /** 최근 공개 목록이 저장된 관심 기술로 걸러졌는지 */
  recentUsesInterests: boolean;
  projects: DashboardProjectDto[];
  sources: SourceStatusDto[];
  activeScans: number;
}

export class PriorityRuleDto {
  id: string;
  condition: string;
  result: string;
}

export class PriorityRulesDto {
  version: string;
  /** 위에서부터 첫 일치를 적용한다 */
  rules: PriorityRuleDto[];
  /** 기본 등급에 더해지는 보정 */
  adjustments: PriorityRuleDto[];
  epssThreshold: number;
  notes: string[];
}

export class StatusSummaryDto {
  /** 정기 수집 출처 수 (OSV 제외) */
  total: number;
  failing: number;
  /** 마지막 성공이 주기의 2배보다 오래된 출처 (실패로 기록되지 않았어도 멈췄을 수 있음) */
  stale: number;
  neverRun: number;
  lastSuccessAt: string | null;
}

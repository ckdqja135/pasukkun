/**
 * 대응 우선순위 규칙 (설명 가능한 규칙 기반).
 * 취약점 자체의 심각도와 별개로, 프로젝트 관점에서 얼마나 먼저 볼지를 정한다.
 * 규칙은 위에서부터 첫 일치를 적용하고, 그 뒤에 보정을 적용한다.
 */
export const PRIORITY_RULE_VERSION = '2026-11-22.1';

export type PriorityLevel = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NEEDS_CHECK';

/** 정렬용 순위. 판단 불가(확인 필요)는 보통보다 먼저 보이게 둔다. */
export const PRIORITY_RANK: Record<PriorityLevel, number> = {
  URGENT: 5,
  HIGH: 4,
  NEEDS_CHECK: 3,
  MEDIUM: 2,
  LOW: 1,
};

export interface PriorityInput {
  versionMatch: 'AFFECTED' | 'NOT_AFFECTED' | 'UNKNOWN';
  exploitCondition: 'MET' | 'NOT_MET' | 'NEEDS_CHECK' | 'NOT_ANALYZED';
  /** 검토 이후 구성·공지가 바뀌어 재확인이 필요한 상태 */
  needsRecheck: boolean;
  kevListed: boolean;
  /** 출처별 CVSS 중 최고 점수. 없으면 null */
  cvssScore: number | null;
  /** CVSS 점수가 없을 때 출처가 준 심각도 라벨 */
  severityLabel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  epssScore: number | null;
  exposure: 'PUBLIC' | 'INTERNAL' | 'UNKNOWN';
  environments: string[];
  patchAvailable: boolean;
}

export interface PriorityConfig {
  epssThreshold: number;
}

export interface PriorityRuleDoc {
  id: string;
  condition: string;
  result: string;
}

export const PRIORITY_RULES: PriorityRuleDoc[] = [
  { id: 'RU', condition: '버전 매칭이 판단 불가', result: '확인 필요' },
  { id: 'R0', condition: '수동 검토로 악용 조건 불충족이 확정되고 재확인이 필요하지 않음', result: '낮음' },
  { id: 'R1', condition: 'CISA KEV 등재', result: '긴급' },
  { id: 'R2', condition: 'CVSS 9.0 이상이고 운영 환경을 포함하며 노출이 공개 또는 알 수 없음', result: '긴급' },
  { id: 'R3', condition: 'CVSS 7.0 이상 또는 EPSS 가 임계값 이상', result: '높음' },
  { id: 'R4', condition: 'CVSS 와 심각도 라벨이 모두 미제공', result: '높음 (심각도 미제공 - 검토 필요)' },
  { id: 'R5', condition: 'CVSS 4.0 이상 7.0 미만', result: '보통' },
  { id: 'R6', condition: '그 외', result: '낮음' },
];

export const PRIORITY_ADJUSTMENTS: PriorityRuleDoc[] = [
  { id: 'A1', condition: '수동 검토로 악용 조건 충족이 확정됨', result: '한 단계 상승' },
  { id: 'A2', condition: '내부 전용이고 운영 환경을 포함하지 않음 (R1 제외)', result: '한 단계 하강' },
];

export interface PriorityResult {
  priority: PriorityLevel;
  rank: number;
  ruleId: string;
  adjustments: string[];
  explanation: string[];
  /** 패치 여부는 등급이 아니라 조치 유형으로 표시한다 */
  action: 'UPDATE_AVAILABLE' | 'MITIGATION_NEEDED';
  ruleVersion: string;
  inputs: PriorityInput & { epssThreshold: number; effectiveScore: number | null };
}

const LABEL_SCORE: Record<string, number | null> = {
  CRITICAL: 9.0,
  HIGH: 7.0,
  MEDIUM: 4.0,
  LOW: 0.1,
  UNKNOWN: null,
};

const ORDER: PriorityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function shift(level: PriorityLevel, delta: number): PriorityLevel {
  const index = ORDER.indexOf(level);
  if (index === -1) return level;
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, index + delta))];
}

export function computePriority(input: PriorityInput, config: PriorityConfig): PriorityResult {
  const effectiveScore = input.cvssScore ?? LABEL_SCORE[input.severityLabel] ?? null;
  const explanation: string[] = [];
  const adjustments: string[] = [];
  // CVSS 점수가 없어 출처의 심각도 라벨로 판단한 경우, 숫자를 지어내 보여주지 않는다.
  const LABEL_KO: Record<string, string> = { CRITICAL: '치명적', HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };
  const scoreText = (band: string) =>
    input.cvssScore !== null
      ? `심각도 ${input.cvssScore.toFixed(1)} (${band})`
      : `CVSS 점수 미제공 - 출처의 심각도 라벨 '${LABEL_KO[input.severityLabel] ?? input.severityLabel}' 기준 (${band} 으로 취급)`;
  const finish = (priority: PriorityLevel, ruleId: string): PriorityResult => ({
    priority,
    rank: PRIORITY_RANK[priority],
    ruleId,
    adjustments,
    explanation,
    action: input.patchAvailable ? 'UPDATE_AVAILABLE' : 'MITIGATION_NEEDED',
    ruleVersion: PRIORITY_RULE_VERSION,
    inputs: { ...input, epssThreshold: config.epssThreshold, effectiveScore },
  });

  if (input.versionMatch === 'UNKNOWN') {
    explanation.push('버전 매칭을 확정할 수 없어 영향 여부 확인이 먼저 필요합니다.');
    return finish('NEEDS_CHECK', 'RU');
  }
  if (input.versionMatch === 'NOT_AFFECTED') {
    explanation.push('확인된 영향 범위에 포함되지 않습니다.');
    return finish('LOW', 'R6');
  }

  if (input.exploitCondition === 'NOT_MET' && !input.needsRecheck) {
    explanation.push('수동 검토에서 악용 조건이 충족되지 않는 것으로 기록되었습니다.');
    return finish('LOW', 'R0');
  }
  if (input.exploitCondition === 'NOT_MET' && input.needsRecheck) {
    explanation.push('이전 검토(조건 불충족)는 구성 또는 공지가 바뀌어 재확인이 필요하므로 반영하지 않았습니다.');
  }

  // 환경 정보가 없으면 운영 환경을 포함하는 것으로 보수적으로 본다.
  const includesProduction = input.environments.length === 0 || input.environments.includes('PRODUCTION');
  const exposedOrUnknown = input.exposure !== 'INTERNAL';

  let base: PriorityLevel;
  let ruleId: string;
  if (input.kevListed) {
    base = 'URGENT';
    ruleId = 'R1';
    explanation.push('CISA KEV 에 등재되어 실제 악용이 확인된 취약점입니다.');
  } else if (effectiveScore !== null && effectiveScore >= 9.0 && includesProduction && exposedOrUnknown) {
    base = 'URGENT';
    ruleId = 'R2';
    explanation.push(
      `${scoreText('9.0 이상')}, 운영 환경 포함, 인터넷 노출 ${
        input.exposure === 'UNKNOWN' ? '알 수 없음(공개와 동일하게 취급)' : '공개'
      }.`,
    );
  } else if (
    (effectiveScore !== null && effectiveScore >= 7.0) ||
    (input.epssScore !== null && input.epssScore >= config.epssThreshold)
  ) {
    base = 'HIGH';
    ruleId = 'R3';
    if (effectiveScore !== null && effectiveScore >= 7.0) explanation.push(`${scoreText('7.0 이상')}.`);
    if (input.epssScore !== null && input.epssScore >= config.epssThreshold) {
      explanation.push(`EPSS ${input.epssScore.toFixed(3)} 이 임계값 ${config.epssThreshold} 이상.`);
    }
  } else if (effectiveScore === null) {
    base = 'HIGH';
    ruleId = 'R4';
    explanation.push('심각도 점수가 제공되지 않았습니다. 낮은 위험으로 취급하지 않고 검토 대상으로 둡니다.');
  } else if (effectiveScore >= 4.0) {
    base = 'MEDIUM';
    ruleId = 'R5';
    explanation.push(`${scoreText('4.0 이상 7.0 미만')}.`);
  } else {
    base = 'LOW';
    ruleId = 'R6';
    explanation.push(`${scoreText('4.0 미만')}, KEV 미등재.`);
  }

  let result: PriorityLevel = base;
  if (input.exploitCondition === 'MET') {
    const raised = shift(result, 1);
    if (raised !== result) adjustments.push('A1');
    result = raised;
    explanation.push('수동 검토에서 악용 조건 충족이 확인되어 한 단계 올렸습니다.');
  }
  if (ruleId !== 'R1' && input.exposure === 'INTERNAL' && input.environments.length > 0 && !includesProduction) {
    const lowered = shift(result, -1);
    if (lowered !== result) adjustments.push('A2');
    result = lowered;
    explanation.push('내부 전용이고 운영 환경이 아니어서 한 단계 내렸습니다.');
  }
  if (input.exploitCondition === 'NOT_ANALYZED' || input.exploitCondition === 'NEEDS_CHECK') {
    explanation.push('악용 조건은 아직 확인되지 않았습니다. 버전 일치만으로 실제 악용 가능성을 확정하지 않습니다.');
  }
  if (!input.patchAvailable) explanation.push('확인된 수정 버전이 없어 완화책 검토가 필요합니다.');
  return finish(result, ruleId);
}

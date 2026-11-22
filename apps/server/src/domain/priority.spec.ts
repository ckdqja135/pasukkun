import { computePriority, type PriorityInput } from './priority.js';

const config = { epssThreshold: 0.1 };
const base: PriorityInput = {
  versionMatch: 'AFFECTED',
  exploitCondition: 'NOT_ANALYZED',
  needsRecheck: false,
  kevListed: false,
  cvssScore: 5.0,
  severityLabel: 'MEDIUM',
  epssScore: 0.001,
  exposure: 'PUBLIC',
  environments: ['PRODUCTION'],
  patchAvailable: true,
};
const run = (patch: Partial<PriorityInput>) => computePriority({ ...base, ...patch }, config);

describe('우선순위 규칙', () => {
  it.each([
    ['R1 KEV 등재는 긴급', { kevListed: true, cvssScore: 3.1 }, 'URGENT', 'R1'],
    ['R2 9.0 이상 + 운영 + 공개', { cvssScore: 9.8 }, 'URGENT', 'R2'],
    ['R2 노출 알 수 없음은 공개와 같게 본다', { cvssScore: 9.1, exposure: 'UNKNOWN' as const }, 'URGENT', 'R2'],
    ['9.0 이상이어도 내부 전용이면 R3', { cvssScore: 9.8, exposure: 'INTERNAL' as const }, 'HIGH', 'R3'],
    ['R3 7.0 이상', { cvssScore: 7.0 }, 'HIGH', 'R3'],
    ['R3 EPSS 임계값 이상', { cvssScore: 4.2, epssScore: 0.1 }, 'HIGH', 'R3'],
    ['R5 4.0-6.9', { cvssScore: 6.9 }, 'MEDIUM', 'R5'],
    ['R6 4.0 미만', { cvssScore: 3.9 }, 'LOW', 'R6'],
  ])('%s', (_name, patch, priority, ruleId) => {
    const result = run(patch);
    expect(result.priority).toBe(priority);
    expect(result.ruleId).toBe(ruleId);
  });

  it('CVSS 미제공을 낮은 위험으로 처리하지 않는다 (R4)', () => {
    const result = run({ cvssScore: null, severityLabel: 'UNKNOWN', epssScore: null });
    expect(result.priority).toBe('HIGH');
    expect(result.ruleId).toBe('R4');
  });

  it('CVSS 점수가 없으면 출처 심각도 라벨을 대신 쓴다', () => {
    expect(run({ cvssScore: null, severityLabel: 'CRITICAL' }).priority).toBe('URGENT');
    expect(run({ cvssScore: null, severityLabel: 'LOW' }).priority).toBe('LOW');
  });

  it('버전 매칭이 판단 불가면 확인 필요 등급으로 남긴다', () => {
    const result = run({ versionMatch: 'UNKNOWN', kevListed: true });
    expect(result.priority).toBe('NEEDS_CHECK');
    expect(result.ruleId).toBe('RU');
  });

  it('R0: 조건 불충족이 확정되면 낮음, 재확인이 필요하면 원래 규칙으로 돌아간다', () => {
    expect(run({ kevListed: true, exploitCondition: 'NOT_MET' }).priority).toBe('LOW');
    const recheck = run({ kevListed: true, exploitCondition: 'NOT_MET', needsRecheck: true });
    expect(recheck.priority).toBe('URGENT');
    expect(recheck.ruleId).toBe('R1');
  });

  it('A1: 조건 충족이 확정되면 한 단계 올린다', () => {
    const result = run({ cvssScore: 5.0, exploitCondition: 'MET' });
    expect(result.priority).toBe('HIGH');
    expect(result.adjustments).toEqual(['A1']);
  });

  it('A2: 내부 전용 + 비운영이면 한 단계 내리지만 KEV 는 내리지 않는다', () => {
    const lowered = run({ cvssScore: 7.5, exposure: 'INTERNAL', environments: ['DEVELOPMENT'] });
    expect(lowered.priority).toBe('MEDIUM');
    expect(lowered.adjustments).toEqual(['A2']);
    const kev = run({ kevListed: true, exposure: 'INTERNAL', environments: ['TEST'] });
    expect(kev.priority).toBe('URGENT');
    expect(kev.adjustments).toEqual([]);
  });

  it('환경 정보가 비어 있으면 운영 포함으로 보수적으로 본다', () => {
    expect(run({ cvssScore: 9.8, environments: [] }).ruleId).toBe('R2');
    expect(run({ cvssScore: 7.5, exposure: 'INTERNAL', environments: [] }).adjustments).toEqual([]);
  });

  it('악용 조건 미확인 항목도 등급을 유지하고 그 사실을 설명에 남긴다', () => {
    const result = run({ cvssScore: 8.1, exploitCondition: 'NEEDS_CHECK' });
    expect(result.priority).toBe('HIGH');
    expect(result.explanation.join(' ')).toContain('악용 조건은 아직 확인되지 않았습니다');
  });

  it('패치 여부는 등급이 아니라 조치 유형으로 반영한다', () => {
    const withPatch = run({ cvssScore: 8.1, patchAvailable: true });
    const noPatch = run({ cvssScore: 8.1, patchAvailable: false });
    expect(withPatch.priority).toBe(noPatch.priority);
    expect(withPatch.action).toBe('UPDATE_AVAILABLE');
    expect(noPatch.action).toBe('MITIGATION_NEEDED');
  });
});

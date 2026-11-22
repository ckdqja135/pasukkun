/**
 * 공지의 구조화된 데이터(CVSS 벡터, 출처가 명시한 취약 함수)에서 "확인해야 할 조건"을 뽑는다.
 * 여기서 조건의 충족 여부를 판정하지는 않는다. 충족/불충족은 사람의 수동 검토로만 기록된다.
 */
export interface ConditionCheck {
  key: string;
  label: string;
  detail: string;
  /** 근거 */
  basis: 'CVSS' | 'ADVISORY';
}

export interface DerivedConditions {
  checks: ConditionCheck[];
  /** 기본값이 아닌 전제 조건이 있어 확인이 필요한지 */
  needsCheck: boolean;
}

function parseVector(vector: string | null | undefined): Record<string, string> {
  if (!vector) return {};
  return Object.fromEntries(
    vector
      .split('/')
      .map((part) => part.split(':'))
      .filter((pair) => pair.length === 2 && pair[0] !== 'CVSS') as [string, string][],
  );
}

export function deriveConditions(cvssVector: string | null | undefined, functions: string[]): DerivedConditions {
  const metrics = parseVector(cvssVector);
  const checks: ConditionCheck[] = [];
  let needsCheck = false;

  if (functions.length > 0) {
    needsCheck = true;
    checks.push({
      key: 'functions',
      label: '취약 기능 사용 여부',
      detail: `공지에 명시된 취약 함수·심볼을 프로젝트가 호출하는지 확인: ${functions.slice(0, 10).join(', ')}${functions.length > 10 ? ' 외' : ''}`,
      basis: 'ADVISORY',
    });
  }

  const av = metrics.AV;
  if (av === 'N') {
    checks.push({ key: 'AV', label: '공격 경로: 네트워크', detail: '원격에서 공격 가능한 유형입니다. 해당 구성 요소가 외부 요청을 처리하는지 확인하세요.', basis: 'CVSS' });
  } else if (av === 'A') {
    needsCheck = true;
    checks.push({ key: 'AV', label: '공격 경로: 인접 네트워크', detail: '같은 네트워크 구간에서의 접근이 필요합니다. 공격자가 그 구간에 들어올 수 있는지 확인하세요.', basis: 'CVSS' });
  } else if (av === 'L') {
    needsCheck = true;
    checks.push({ key: 'AV', label: '공격 경로: 로컬', detail: '시스템에 대한 로컬 접근(또는 사용자가 여는 파일 등)이 필요합니다.', basis: 'CVSS' });
  } else if (av === 'P') {
    needsCheck = true;
    checks.push({ key: 'AV', label: '공격 경로: 물리적 접근', detail: '장비에 대한 물리적 접근이 필요합니다.', basis: 'CVSS' });
  }

  if (metrics.AC === 'H') {
    needsCheck = true;
    checks.push({ key: 'AC', label: '공격 복잡도: 높음', detail: '특정 설정·타이밍 등 공격자가 통제하기 어려운 조건이 필요합니다. 공지 원문의 조건이 우리 환경에 해당하는지 확인하세요.', basis: 'CVSS' });
  }
  if (metrics.AT === 'P') {
    needsCheck = true;
    checks.push({ key: 'AT', label: '공격 전제 조건 있음', detail: '특정 배포·실행 조건이 갖춰져야 합니다. 공지 원문의 전제 조건을 확인하세요.', basis: 'CVSS' });
  }
  if (metrics.PR === 'L' || metrics.PR === 'H') {
    needsCheck = true;
    checks.push({
      key: 'PR',
      label: `필요 권한: ${metrics.PR === 'L' ? '낮음' : '높음'}`,
      detail: '공격자가 인증된 계정이나 권한을 먼저 가져야 합니다. 해당 권한을 누가 가질 수 있는지 확인하세요.',
      basis: 'CVSS',
    });
  }
  if (metrics.UI && metrics.UI !== 'N') {
    needsCheck = true;
    checks.push({ key: 'UI', label: '사용자 상호작용 필요', detail: '피해자가 링크 클릭, 파일 열기 등 특정 행동을 해야 합니다.', basis: 'CVSS' });
  }
  return { checks, needsCheck };
}

/**
 * 사용자가 정하는 알림 문구 틀.
 * {제목} 같은 자리표시자를 실제 값으로 바꾼다. 알 수 없는 자리표시자는 저장할 때 거부한다.
 * 값의 이스케이프(텔레그램 HTML, 디스코드 멘션 등)는 채널별 Provider 가 맡는다.
 */
export const PLACEHOLDERS = [
  { key: '이벤트', description: '알림 종류 (예: 신규 영향 버전 일치)' },
  { key: '제목', description: '취약점 제목' },
  { key: '식별자', description: 'CVE · GHSA 식별자' },
  { key: '심각도', description: '취약점 심각도 (치명적/높음/보통/낮음/미제공)' },
  { key: 'CVSS', description: 'CVSS 점수 (없으면 미제공)' },
  { key: '우선순위', description: '대응 우선순위 (프로젝트 알림)' },
  { key: '프로젝트', description: '프로젝트 이름 (프로젝트 알림)' },
  { key: '패키지', description: '영향받는 패키지 이름 (첫 번째)' },
  { key: '현재버전', description: '설치된 버전 (첫 번째 패키지)' },
  { key: '수정버전', description: '확인된 수정 버전 (없으면 패치 미확인)' },
  { key: '영향패키지', description: '영향받는 패키지 전체 목록 (여러 줄)' },
  { key: '판단', description: '판단 근거' },
  { key: '악용조건', description: '악용 조건 확인 상태' },
  { key: '확인할조건', description: '확인해야 할 조건' },
  { key: '관련기술', description: '관련 기술 (관심 기술 알림)' },
  { key: 'KEV', description: 'CISA KEV 등재 여부' },
  { key: 'EPSS', description: 'EPSS (30일 내 악용 활동 관측 확률 추정)' },
  { key: '링크', description: '이 서비스의 상세 화면 주소' },
  { key: '원문', description: '공지 원문 주소' },
] as const;

export type PlaceholderKey = (typeof PLACEHOLDERS)[number]['key'];
export type TemplateValues = Partial<Record<PlaceholderKey, string>>;

export const MAX_TEMPLATE_LENGTH = 1500;
const KEYS = new Set<string>(PLACEHOLDERS.map((p) => p.key));
const TOKEN = /\{([^{}\n]{1,20})\}/g;

export const DEFAULT_TEMPLATES = {
  PROJECT_IMPACT: ['[{우선순위}] {제목}', '{식별자}', '프로젝트: {프로젝트}', '{영향패키지}', '심각도: {심각도} (CVSS {CVSS}) · KEV {KEV}', '판단 근거: {판단}', '악용 조건: {악용조건}', '{링크}'].join('\n'),
  TECH_INTEREST: ['[{이벤트}] {제목}', '{식별자}', '관련 기술: {관련기술}', '심각도: {심각도} (CVSS {CVSS}) · KEV {KEV}', '{영향패키지}', '{링크}'].join('\n'),
} as const;

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly unknown: string[] = [],
  ) {
    super(message);
  }
}

/** 저장 전 검사. 정규화한 문구를 돌려준다 (비어 있으면 null = 기본 형식 사용). */
export function validateTemplate(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const text = input.replace(/\r\n/g, '\n').trim();
  if (text === '') return null;
  if (text.length > MAX_TEMPLATE_LENGTH) throw new TemplateError(`알림 문구는 ${MAX_TEMPLATE_LENGTH}자까지 쓸 수 있습니다.`);
  const unknown = [...new Set([...text.matchAll(TOKEN)].map((match) => match[1]).filter((key) => !KEYS.has(key)))];
  if (unknown.length > 0) {
    throw new TemplateError(`알 수 없는 자리표시자가 있습니다: ${unknown.map((key) => `{${key}}`).join(', ')}`, unknown);
  }
  return text;
}

/** 자리표시자를 값으로 바꾼다. 값이 없으면 "-" 로 채운다. */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template
    .replace(TOKEN, (whole, key: string) => (KEYS.has(key) ? (values[key as PlaceholderKey]?.trim() || '-') : whole))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

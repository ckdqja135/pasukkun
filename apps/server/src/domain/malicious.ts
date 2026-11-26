/**
 * 악성 패키지 공지 판별.
 * OSV 의 MAL- 식별자는 OpenSSF 악성 패키지 DB 항목이다. 취약점이 아니라 악성 코드가 들어 있는 버전이라는 공지다.
 */
export function isMaliciousAdvisory(identifiers: Array<{ value: string }>): boolean {
  return identifiers.some((identifier) => identifier.value.startsWith('MAL-'));
}

import { parseAllDocuments } from 'yaml';
import { LockfileError } from './lockfile-common.js';

/**
 * pnpm-lock.yaml / Yarn Berry yarn.lock 을 데이터로만 읽는다.
 * - failsafe 스키마: 모든 값을 문자열로 읽는다 (버전 "1.10" 이 숫자 1.1 로 바뀌지 않게, 사용자 정의 태그 없음).
 * - 별칭(앵커 참조)은 해석하지 않는다. lockfile 은 별칭을 쓰지 않으며, 별칭 폭증 공격을 막는다.
 * - 같은 키가 두 번 나오면 거부한다.
 * 한 파일에 문서가 여러 개일 수 있다 (pnpm 은 환경 정보 문서를 앞에 둔다).
 */
export function loadYamlDocuments(content: string): unknown[] {
  try {
    const docs = parseAllDocuments(content, { schema: 'failsafe', uniqueKeys: true, prettyErrors: false, keepSourceTokens: false });
    if (!Array.isArray(docs)) return [];
    return docs.map((doc) => {
      if (doc.errors.length > 0) throw new Error('yaml');
      return doc.toJS({ maxAliasCount: 0 }) as unknown;
    });
  } catch {
    // RangeError(지나친 중첩) 포함, 어떤 실패든 같은 메시지로 거부한다.
    throw new LockfileError('INVALID_FORMAT', 'YAML 로 해석할 수 없는 파일입니다. lockfile 이 손상되었는지 확인해 주세요.');
  }
}

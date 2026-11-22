import semver from 'semver';
import { LockfileError, checkSize, type LockfileFormat, type LockfileLimits, type ParsedLockfile, type ParsedPackage } from './lockfile-common.js';
import { parseNpmLockfile } from './lockfile-npm.js';
import { parsePnpmLockfile } from './lockfile-pnpm.js';
import { parseYarnLockfile } from './lockfile-yarn.js';

/**
 * lockfile 해석 진입점. 내용으로 형식(npm / pnpm / Yarn)을 판별해 각 파서로 보낸다.
 * - 입력을 데이터로만 해석한다. 파일을 실행하거나 설치 명령을 실행하지 않는다.
 * - package.json 의 버전 범위는 설치 버전으로 쓰지 않는다.
 */

export {
  LockfileError,
  type LockfileErrorCode,
  type LockfileFormat,
  type LockfileLimits,
  type LockfileWarning,
  type ParsedLockfile,
  type ParsedPackage,
  type RefKind,
} from './lockfile-common.js';

export const LOCKFILE_NAMES: Record<LockfileFormat, string> = {
  NPM: 'package-lock.json',
  PNPM: 'pnpm-lock.yaml',
  YARN: 'yarn.lock',
};

/** 파일 이름으로 형식을 추정한다 (경로 포함 가능). */
export function formatFromFileName(fileName: string | null | undefined): LockfileFormat | null {
  const base = (fileName ?? '').split('/').pop() ?? '';
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'NPM';
  if (base === 'pnpm-lock.yaml') return 'PNPM';
  if (base === 'yarn.lock') return 'YARN';
  return null;
}

/** 내용으로 형식을 판별한다. 판별할 수 없으면 파일 이름을 참고한다. */
export function detectLockfileFormat(content: string, fileName?: string | null): LockfileFormat | null {
  const head = content.slice(0, 4096).replace(/^\uFEFF/, '');
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'NPM';
  if (/^# yarn lockfile v1/m.test(head) || /^"?__metadata"?:/m.test(head)) return 'YARN';
  if (/^lockfileVersion:/m.test(head)) return 'PNPM';
  return formatFromFileName(fileName);
}

export function parseLockfile(
  content: string,
  limits: LockfileLimits,
  packageJsonContent?: string | null,
  fileName?: string | null,
): ParsedLockfile {
  checkSize(content, limits);
  switch (detectLockfileFormat(content, fileName)) {
    case 'NPM':
      return parseNpmLockfile(content, limits, packageJsonContent);
    case 'PNPM':
      return parsePnpmLockfile(content, limits, packageJsonContent);
    case 'YARN':
      return parseYarnLockfile(content, limits, packageJsonContent);
    default:
      throw new LockfileError(
        'UNSUPPORTED_FORMAT',
        '지원하는 lockfile 형식이 아닙니다. package-lock.json, pnpm-lock.yaml, yarn.lock 중 하나를 올려 주세요.',
      );
  }
}

export interface ManualPackageInput {
  name: string;
  version: string;
}

const NPM_NAME_STRICT = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** 수동 등록: 정확한 버전만 받는다. 범위(^, ~, x)는 설치 버전이 아니므로 거부한다. */
export function validateManualPackages(input: ManualPackageInput[], maxPackages: number): ParsedPackage[] {
  if (input.length === 0) throw new LockfileError('NOT_A_LOCKFILE', '패키지를 하나 이상 입력해 주세요.');
  if (input.length > maxPackages) {
    throw new LockfileError('TOO_MANY_PACKAGES', `패키지 수가 제한(${maxPackages})을 넘습니다.`);
  }
  const seen = new Set<string>();
  const out: ParsedPackage[] = [];
  for (const item of input) {
    const name = item.name.trim();
    const version = item.version.trim();
    if (name.length > 214 || !NPM_NAME_STRICT.test(name)) {
      throw new LockfileError('NOT_A_LOCKFILE', `패키지명이 올바르지 않습니다: "${name}"`);
    }
    if (!semver.valid(version)) {
      throw new LockfileError(
        'NOT_A_LOCKFILE',
        `"${name}" 의 버전 "${version}" 은 정확한 버전이 아닙니다. 범위(^1.2.0, ~1.2, 1.x)가 아닌 설치된 버전(예: 1.2.3)을 입력해 주세요.`,
      );
    }
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      version,
      installPath: `manual:${key}`,
      isDirect: true,
      isDev: false,
      isOptional: false,
      dependencyPath: [key],
      refKind: 'REGISTRY',
      scannable: true,
      unsupportedReason: null,
    });
  }
  return out;
}

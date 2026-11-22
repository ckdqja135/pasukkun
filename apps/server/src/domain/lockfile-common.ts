import semver from 'semver';

/**
 * lockfile 파서들이 함께 쓰는 형식, 상한, 분류 규칙.
 * - 입력은 데이터로만 해석한다. 파일을 실행하거나 설치 명령을 실행하지 않는다.
 * - package.json 의 버전 범위는 설치 버전으로 쓰지 않는다.
 */

export type LockfileFormat = 'NPM' | 'PNPM' | 'YARN';

export type RefKind = 'REGISTRY' | 'ALIAS' | 'GIT' | 'FILE' | 'LINK' | 'REMOTE_TARBALL' | 'UNKNOWN';

export interface ParsedPackage {
  name: string;
  version: string;
  installPath: string;
  isDirect: boolean;
  isDev: boolean;
  isOptional: boolean;
  dependencyPath: string[];
  refKind: RefKind;
  scannable: boolean;
  unsupportedReason: string | null;
}

export interface LockfileWarning {
  code:
    | 'UNSUPPORTED_REFERENCE'
    | 'MISSING_VERSION'
    | 'LOCAL_PACKAGE'
    | 'NON_SEMVER_VERSION'
    | 'PACKAGE_JSON_MISMATCH'
    | 'DIRECT_UNKNOWN'
    | 'EXTRANEOUS'
    | 'BUNDLED';
  message: string;
  count: number;
  examples: string[];
}

export interface ParsedLockfile {
  format: LockfileFormat;
  lockfileVersion: number;
  rootName: string | null;
  packages: ParsedPackage[];
  warnings: LockfileWarning[];
}

export type LockfileErrorCode =
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_FORMAT'
  | 'NOT_A_LOCKFILE'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'TOO_MANY_PACKAGES'
  | 'TOO_COMPLEX';

export class LockfileError extends Error {
  constructor(
    readonly code: LockfileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LockfileLimits {
  maxBytes: number;
  maxPackages: number;
}

/**
 * 악의적으로 만든 입력이 서버를 붙잡아 두지 못하게 하는 상한.
 * 실제 프로젝트의 lockfile 은 이 값들에 한참 못 미친다.
 */
export const MAX_KEY_LENGTH = 1024;
export const MAX_NESTING = 40;
export const MAX_NAME_LENGTH = 214;
export const MAX_VERSION_LENGTH = 256;
export const MAX_DEPS_PER_ENTRY = 2000;
/** 워크스페이스(importer) 수 상한 */
export const MAX_ROOTS = 2000;
/** 의존성 경로 계산에 쓸 수 있는 총 작업량 (해석 1단계 = 1) */
export const WORK_BUDGET = 3_000_000;
export const MAX_PATH_DEPTH = 12;
export const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 자기 소유 키만 읽는다 (__proto__, constructor 같은 상속 값을 항목으로 보지 않는다). */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function depNames(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const names = Object.keys(value);
  if (names.length > MAX_DEPS_PER_ENTRY) {
    throw new LockfileError('TOO_COMPLEX', `한 패키지의 의존성 수가 제한(${MAX_DEPS_PER_ENTRY})을 넘습니다.`);
  }
  return names;
}

/** { 이름: 값 } 목록을 [이름, 값] 으로. 값은 문자열 또는 { version } 객체를 받는다 (pnpm importer). */
export function depEntries(value: unknown): Array<[string, string]> {
  if (!isPlainObject(value)) return [];
  const out: Array<[string, string]> = [];
  for (const name of depNames(value)) {
    const raw = value[name];
    const ref = typeof raw === 'string' ? raw : isPlainObject(raw) && typeof raw.version === 'string' ? raw.version : null;
    if (ref !== null && name.length <= MAX_NAME_LENGTH && ref.length <= MAX_KEY_LENGTH) out.push([name, ref]);
  }
  return out;
}

export function checkKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new LockfileError('TOO_COMPLEX', '항목 이름이 비정상적으로 긴 lockfile 은 처리하지 않습니다.');
  }
}

export function checkSize(content: string, limits: LockfileLimits): void {
  if (Buffer.byteLength(content, 'utf8') > limits.maxBytes) {
    throw new LockfileError('TOO_LARGE', `파일이 너무 큽니다 (최대 ${Math.floor(limits.maxBytes / 1024 / 1024)}MB).`);
  }
}

export function checkCount(count: number, limits: LockfileLimits): void {
  if (count > limits.maxPackages + 1) {
    throw new LockfileError('TOO_MANY_PACKAGES', `패키지 수가 제한(${limits.maxPackages})을 넘습니다.`);
  }
}

/** 작업량 상한. 상한을 넘으면 입력 크기에 비해 과도한 계산을 요구하는 파일로 보고 중단한다. */
export class WorkBudget {
  private used = 0;
  spend(amount = 1): void {
    this.used += amount;
    if (this.used > WORK_BUDGET) throw new LockfileError('TOO_COMPLEX', '의존성 구조가 비정상적으로 복잡해 처리하지 않습니다.');
  }
}

/** 설치 출처 URL/참조를 분류한다. 레지스트리 tarball 은 /-/ 구분자를 가진다. */
export function classifyResolved(resolved: unknown): RefKind {
  if (typeof resolved !== 'string' || resolved === '') return 'REGISTRY';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(resolved) || /^git@/.test(resolved)) return 'GIT';
  if (resolved.startsWith('file:')) return 'FILE';
  if (resolved.startsWith('link:') || resolved.startsWith('portal:') || resolved.startsWith('workspace:')) return 'LINK';
  if (/^https?:\/\//.test(resolved)) {
    const withoutHash = resolved.split('#')[0];
    return /\/-\/[^/]+\.tgz(\?.*)?$/.test(withoutHash) ? 'REGISTRY' : 'REMOTE_TARBALL';
  }
  return 'UNKNOWN';
}

export const UNSUPPORTED_REASON: Record<Exclude<RefKind, 'REGISTRY' | 'ALIAS'>, string> = {
  GIT: 'Git 참조 - 레지스트리 버전으로 조회할 수 없음',
  FILE: '로컬 파일 참조 - 공개 취약점 데이터로 조회할 수 없음',
  LINK: '로컬 링크(워크스페이스) - 외부 패키지가 아님',
  REMOTE_TARBALL: '임의 URL tarball - 레지스트리 버전으로 확인할 수 없음',
  UNKNOWN: '해석할 수 없는 참조',
};

export class WarningCollector {
  private readonly map = new Map<string, LockfileWarning>();
  add(code: LockfileWarning['code'], message: string, example: string) {
    const key = `${code}:${message}`;
    const existing = this.map.get(key) ?? { code, message, count: 0, examples: [] };
    existing.count += 1;
    if (existing.examples.length < 5) existing.examples.push(example.slice(0, 120));
    this.map.set(key, existing);
  }
  list(): LockfileWarning[] {
    return [...this.map.values()];
  }
}

/** 이름·버전·출처로 외부 조회(검사) 가능 여부를 정한다. 세 파서가 같은 규칙을 쓴다. */
export function classifyPackage(
  name: string,
  version: string,
  refKind: RefKind,
  warnings: WarningCollector,
  example: string,
): { scannable: boolean; unsupportedReason: string | null } {
  if (refKind !== 'REGISTRY' && refKind !== 'ALIAS') {
    const reason = UNSUPPORTED_REASON[refKind];
    warnings.add(refKind === 'LINK' ? 'LOCAL_PACKAGE' : 'UNSUPPORTED_REFERENCE', reason, example);
    return { scannable: false, unsupportedReason: reason };
  }
  if (!NPM_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    // npm 이름 규칙에 맞지 않는 값은 외부로 조회하지 않는다.
    const reason = '패키지명이 npm 이름 형식이 아님';
    warnings.add('UNSUPPORTED_REFERENCE', reason, example.slice(0, 80));
    return { scannable: false, unsupportedReason: reason };
  }
  if (version === '') {
    const reason = 'lockfile 에 설치 버전이 기록되어 있지 않음';
    warnings.add('MISSING_VERSION', reason, example);
    return { scannable: false, unsupportedReason: reason };
  }
  if (!semver.valid(version)) {
    warnings.add('NON_SEMVER_VERSION', '설치 버전이 semver 형식이 아니어서 비교할 수 없음', `${name}@${version}`);
    return { scannable: false, unsupportedReason: `설치 버전 "${version}" 이 semver 형식이 아님` };
  }
  return { scannable: true, unsupportedReason: null };
}

/**
 * 노드 그래프에서 루트부터 너비 우선 탐색으로 최단 의존성 경로를 구한다.
 * roots 는 순서대로 탐색하므로, 운영 의존성 루트를 먼저 넣으면 운영 경로가 우선 기록된다.
 */
export function shortestPaths(
  roots: string[],
  edges: (node: string) => string[],
  budget: WorkBudget,
): { parentOf: Map<string, string | null>; reached: Set<string> } {
  const parentOf = new Map<string, string | null>();
  const queue: string[] = [];
  for (const root of roots) {
    if (parentOf.has(root)) continue;
    parentOf.set(root, null);
    queue.push(root);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const next of edges(current)) {
      budget.spend();
      if (parentOf.has(next)) continue;
      parentOf.set(next, current);
      queue.push(next);
    }
  }
  return { parentOf, reached: new Set(parentOf.keys()) };
}

/** 루트부터 도달 가능한 노드 집합 (경로는 필요 없을 때) */
export function reachable(roots: string[], edges: (node: string) => string[], budget: WorkBudget): Set<string> {
  return shortestPaths(roots, edges, budget).reached;
}

export function pathTo(key: string, parentOf: Map<string, string | null>, label: (key: string) => string): string[] {
  if (!parentOf.has(key)) return [];
  const chain: string[] = [];
  let cursor: string | null | undefined = key;
  let guard = 0;
  while (cursor != null && guard < MAX_PATH_DEPTH) {
    chain.unshift(label(cursor));
    cursor = parentOf.get(cursor);
    guard += 1;
  }
  if (cursor != null) chain.unshift('…');
  return chain;
}

export interface PackageJsonDeps {
  name: string | null;
  dependencies: Array<[string, string]>;
  devDependencies: Array<[string, string]>;
  optionalDependencies: Array<[string, string]>;
  hasWorkspaces: boolean;
}

/** package.json 에서 의존성 선언만 읽는다. 해석할 수 없으면 null. */
export function readPackageJson(content: string | null | undefined): PackageJsonDeps | null {
  if (!content) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isPlainObject(pkg)) return null;
  return {
    name: typeof pkg.name === 'string' ? pkg.name.slice(0, MAX_NAME_LENGTH) : null,
    dependencies: depEntries(pkg.dependencies),
    devDependencies: depEntries(pkg.devDependencies),
    optionalDependencies: depEntries(pkg.optionalDependencies),
    hasWorkspaces: pkg.workspaces !== undefined,
  };
}

/** 같은 이름·버전이 여러 번 나오면(peer 조합만 다른 경우 등) 하나로 합친다. */
export function mergeDuplicates(packages: ParsedPackage[]): ParsedPackage[] {
  const byKey = new Map<string, ParsedPackage>();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}\u0000${pkg.refKind}\u0000${pkg.installPath}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...pkg });
      continue;
    }
    existing.isDirect ||= pkg.isDirect;
    existing.isDev &&= pkg.isDev;
    existing.isOptional &&= pkg.isOptional;
    if (pkg.dependencyPath.length > 0 && (existing.dependencyPath.length === 0 || pkg.dependencyPath.length < existing.dependencyPath.length)) {
      existing.dependencyPath = pkg.dependencyPath;
    }
  }
  return [...byKey.values()];
}

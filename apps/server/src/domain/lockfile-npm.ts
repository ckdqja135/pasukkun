import {
  LockfileError,
  MAX_NAME_LENGTH,
  MAX_NESTING,
  MAX_KEY_LENGTH,
  MAX_VERSION_LENGTH,
  WarningCollector,
  WorkBudget,
  checkCount,
  classifyPackage,
  classifyResolved,
  depNames,
  isPlainObject,
  pathTo,
  type LockfileLimits,
  type ParsedLockfile,
  type ParsedPackage,
  type RefKind,
} from './lockfile-common.js';

/** npm package-lock.json (lockfileVersion 2/3) 파서. JSON 으로만 해석한다. */

interface RawEntry {
  name?: unknown;
  version?: unknown;
  resolved?: unknown;
  link?: unknown;
  dev?: unknown;
  optional?: unknown;
  devOptional?: unknown;
  inBundle?: unknown;
  extraneous?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

const NODE_MODULES = 'node_modules/';

function nestingDepth(key: string): number {
  let depth = 0;
  for (let index = key.indexOf(NODE_MODULES); index !== -1; index = key.indexOf(NODE_MODULES, index + NODE_MODULES.length)) depth += 1;
  return depth;
}

/** "a/node_modules/@s/b" → "@s/b" */
function nameFromPath(installPath: string): string {
  const index = installPath.lastIndexOf(NODE_MODULES);
  return index === -1 ? installPath : installPath.slice(index + NODE_MODULES.length);
}

export function parseNpmLockfile(content: string, limits: LockfileLimits, packageJsonContent?: string | null): ParsedLockfile {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    throw new LockfileError('INVALID_JSON', 'JSON 으로 해석할 수 없는 파일입니다.');
  }
  if (!isPlainObject(doc)) throw new LockfileError('NOT_A_LOCKFILE', 'package-lock.json 형식이 아닙니다.');

  const lockfileVersion = doc.lockfileVersion;
  if (typeof lockfileVersion !== 'number') {
    throw new LockfileError(
      'NOT_A_LOCKFILE',
      'lockfileVersion 이 없습니다. package.json 이 아니라 lockfile(package-lock.json, pnpm-lock.yaml, yarn.lock)을 올려 주세요.',
    );
  }
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    throw new LockfileError(
      'UNSUPPORTED_VERSION',
      lockfileVersion === 1
        ? 'lockfileVersion 1 (npm 5/6) 은 지원하지 않습니다. 최신 npm 으로 lockfile 을 다시 생성해 주세요.'
        : `package-lock.json 의 lockfileVersion ${lockfileVersion} 은 지원하지 않습니다 (지원: 2, 3).`,
    );
  }
  if (!isPlainObject(doc.packages)) {
    throw new LockfileError('NOT_A_LOCKFILE', 'packages 항목이 없어 설치 버전을 확인할 수 없습니다.');
  }

  const entries = doc.packages as Record<string, unknown>;
  const keys = Object.keys(entries);
  checkCount(keys.length, limits);

  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH || nestingDepth(key) > MAX_NESTING) {
      throw new LockfileError('TOO_COMPLEX', '설치 경로가 비정상적으로 길거나 깊은 항목이 있어 처리하지 않습니다.');
    }
  }

  const warnings = new WarningCollector();
  const budget = new WorkBudget();
  const resolveCache = new Map<string, string | null>();
  const get = (key: string): RawEntry | null =>
    Object.prototype.hasOwnProperty.call(entries, key) && isPlainObject(entries[key]) ? (entries[key] as RawEntry) : null;

  /** node 해석 규칙: fromPath 에서 위로 올라가며 node_modules/<name> 을 찾는다. */
  const resolve = (fromPath: string, depName: string): string | null => {
    if (depName.length > MAX_NAME_LENGTH) return null;
    const cacheKey = `${fromPath}\u0000${depName}`;
    const cached = resolveCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let base = fromPath;
    let found: string | null = null;
    for (;;) {
      budget.spend();
      const candidate = base === '' ? `${NODE_MODULES}${depName}` : `${base}/${NODE_MODULES}${depName}`;
      if (Object.prototype.hasOwnProperty.call(entries, candidate)) {
        found = candidate;
        break;
      }
      if (base === '') break;
      const index = base.lastIndexOf(`/${NODE_MODULES}`);
      if (index !== -1) base = base.slice(0, index);
      else base = ''; // 최상위 node_modules 또는 워크스페이스 경로 → 루트
    }
    resolveCache.set(cacheKey, found);
    return found;
  };

  // 루트와 워크스페이스 멤버가 "직접 의존성"의 출발점이다.
  const rootKeys = keys.filter((key) => key === '' || !key.includes(NODE_MODULES));
  const directPaths = new Set<string>();
  const parentOf = new Map<string, string | null>();
  const queue: string[] = [];

  for (const rootKey of rootKeys) {
    const root = get(rootKey);
    if (!root) continue;
    const names = [
      ...depNames(root.dependencies),
      ...depNames(root.devDependencies),
      ...depNames(root.optionalDependencies),
      ...depNames(root.peerDependencies),
    ];
    for (const depName of names) {
      const target = resolve(rootKey, depName);
      if (!target) continue;
      directPaths.add(target);
      if (!parentOf.has(target)) {
        parentOf.set(target, null);
        queue.push(target);
      }
    }
  }

  // 너비 우선 탐색으로 각 설치 위치까지의 최단 의존성 경로를 구한다.
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    let entry = get(current);
    let fromPath = current;
    if (entry?.link === true && typeof entry.resolved === 'string') {
      // 링크는 실제 위치의 의존성을 따른다. 대상은 이 파일 안에 실제로 있는 항목이어야 한다.
      const target = get(entry.resolved);
      if (!target) continue;
      fromPath = entry.resolved;
      entry = target;
    }
    if (!entry) continue;
    const names = [...depNames(entry.dependencies), ...depNames(entry.optionalDependencies), ...depNames(entry.peerDependencies)];
    for (const depName of names) {
      const target = resolve(fromPath, depName);
      if (!target || parentOf.has(target)) continue;
      parentOf.set(target, current);
      queue.push(target);
    }
  }

  const label = (key: string): string => {
    const entry = get(key);
    const name = typeof entry?.name === 'string' ? entry.name : nameFromPath(key);
    return typeof entry?.version === 'string' ? `${name}@${entry.version}` : name;
  };

  const packages: ParsedPackage[] = [];
  for (const key of keys) {
    if (!key.includes(NODE_MODULES)) continue; // 루트·워크스페이스 멤버 자체는 검사 대상이 아니다
    const entry = get(key);
    if (!entry) continue;

    const pathName = nameFromPath(key);
    const realName = (typeof entry.name === 'string' && entry.name !== '' ? entry.name : pathName).slice(0, MAX_NAME_LENGTH);
    const version = (typeof entry.version === 'string' ? entry.version : '').slice(0, MAX_VERSION_LENGTH);
    const isAlias = realName !== pathName;

    let refKind: RefKind = entry.link === true ? 'LINK' : classifyResolved(entry.resolved);
    if (refKind === 'REGISTRY' && isAlias) refKind = 'ALIAS';
    const { scannable, unsupportedReason } = classifyPackage(realName, version, refKind, warnings, pathName);

    if (entry.extraneous === true) {
      warnings.add('EXTRANEOUS', 'package.json 에 선언되지 않은(extraneous) 설치 항목 - 그대로 검사함', pathName);
    }
    if (entry.inBundle === true) {
      warnings.add('BUNDLED', '다른 패키지에 번들된 의존성 - 기록된 버전으로 검사함', pathName);
    }

    packages.push({
      name: realName,
      version,
      installPath: key,
      isDirect: directPaths.has(key),
      isDev: entry.dev === true,
      isOptional: entry.optional === true || entry.devOptional === true,
      dependencyPath: pathTo(key, parentOf, label),
      refKind,
      scannable,
      unsupportedReason,
    });
  }

  if (packageJsonContent) {
    try {
      const pkg = JSON.parse(packageJsonContent) as unknown;
      if (isPlainObject(pkg)) {
        const declared = new Set([...depNames(pkg.dependencies), ...depNames(pkg.devDependencies), ...depNames(pkg.optionalDependencies)]);
        const root = get('');
        const locked = new Set([...depNames(root?.dependencies), ...depNames(root?.devDependencies), ...depNames(root?.optionalDependencies)]);
        for (const name of declared) {
          if (!locked.has(name)) {
            warnings.add('PACKAGE_JSON_MISMATCH', 'package.json 에는 있으나 lockfile 루트에 없는 의존성 - lockfile 이 최신이 아닐 수 있음', name);
          }
        }
        for (const name of locked) {
          if (!declared.has(name)) {
            warnings.add('PACKAGE_JSON_MISMATCH', 'lockfile 루트에는 있으나 package.json 에 없는 의존성 - 두 파일이 서로 다른 시점의 것일 수 있음', name);
          }
        }
      }
    } catch {
      warnings.add('PACKAGE_JSON_MISMATCH', 'package.json 을 JSON 으로 해석할 수 없어 비교를 건너뜀', 'package.json');
    }
  }

  const root = get('');
  return {
    format: 'NPM',
    lockfileVersion,
    rootName: typeof root?.name === 'string' ? root.name : typeof doc.name === 'string' ? doc.name : null,
    packages,
    warnings: warnings.list(),
  };
}

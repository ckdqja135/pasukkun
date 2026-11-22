import {
  LockfileError,
  MAX_ROOTS,
  MAX_VERSION_LENGTH,
  WarningCollector,
  WorkBudget,
  checkCount,
  checkKey,
  classifyPackage,
  classifyResolved,
  depEntries,
  isPlainObject,
  mergeDuplicates,
  own,
  pathTo,
  readPackageJson,
  shortestPaths,
  type LockfileLimits,
  type ParsedLockfile,
  type ParsedPackage,
  type RefKind,
} from './lockfile-common.js';
import { loadYamlDocuments } from './lockfile-yaml.js';

/**
 * pnpm-lock.yaml 파서 (lockfileVersion 5.x, 6.x, 9.x).
 * - importers(워크스페이스)의 dependencies/optionalDependencies 가 운영 루트, devDependencies 가 개발 루트다.
 * - v9 는 snapshots, v5/v6 은 packages 가 의존성 그래프다. 키의 "(peer…)" / "_peer" 부분은 버전이 아니다.
 * - link: 는 워크스페이스 내부 패키지라 외부 조회 대상이 아니다.
 */

type Raw = Record<string, unknown>;

const isTrue = (value: unknown) => value === true || value === 'true';

interface KeyParts {
  name: string;
  version: string;
}

function parseKey(key: string, major: number): KeyParts | null {
  let k = key;
  if (major < 9 && k.startsWith('/')) k = k.slice(1);
  if (major <= 5) {
    // /name/version_peers  ·  /@scope/name/version_peers
    const parts = k.split('/');
    const scoped = parts[0].startsWith('@');
    const nameParts = scoped ? 2 : 1;
    if (parts.length <= nameParts) return null;
    const name = parts.slice(0, nameParts).join('/');
    const rest = parts.slice(nameParts).join('/');
    return { name, version: rest.split('_')[0] };
  }
  // name@version(peers)  ·  v6 은 앞에 "/"
  const paren = k.indexOf('(');
  const base = paren === -1 ? k : k.slice(0, paren);
  const at = base.indexOf('@', 1);
  if (at <= 0) return null;
  return { name: base.slice(0, at), version: base.slice(at + 1) };
}

function refKindOf(meta: Raw | null, version: string): RefKind {
  const resolution = meta && isPlainObject(meta.resolution) ? meta.resolution : null;
  if (resolution) {
    if (resolution.type === 'git' || typeof resolution.repo === 'string' || typeof resolution.commit === 'string') return 'GIT';
    if (resolution.type === 'directory' || typeof resolution.directory === 'string') return 'FILE';
    if (typeof resolution.tarball === 'string') return classifyResolved(resolution.tarball);
    if (typeof resolution.integrity === 'string') return 'REGISTRY';
  }
  if (version.startsWith('link:')) return 'LINK';
  if (version.startsWith('file:')) return 'FILE';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|github\.com\/)/.test(version)) return 'GIT';
  if (/^https?:\/\//.test(version)) return classifyResolved(version);
  return 'REGISTRY';
}

export function parsePnpmLockfile(content: string, limits: LockfileLimits, packageJsonContent?: string | null): ParsedLockfile {
  const docs = loadYamlDocuments(content);
  // pnpm 은 한 파일 앞쪽에 환경 정보 문서를 둘 수 있다. 실제 lockfile 은 lockfileVersion 을 가진 마지막 문서다.
  const doc = [...docs].reverse().find((d): d is Raw => isPlainObject(d) && typeof d.lockfileVersion === 'string');
  if (!doc) throw new LockfileError('NOT_A_LOCKFILE', 'pnpm-lock.yaml 형식이 아닙니다 (lockfileVersion 이 없습니다).');

  if (!['importers', 'packages', 'snapshots', 'dependencies', 'devDependencies', 'optionalDependencies'].some((key) => isPlainObject(doc[key]))) {
    throw new LockfileError('NOT_A_LOCKFILE', 'pnpm-lock.yaml 에 의존성 정보(importers, packages)가 없습니다.');
  }
  const versionText = doc.lockfileVersion as string;
  const major = Math.trunc(Number.parseFloat(versionText));
  if (![5, 6, 9].includes(major)) {
    throw new LockfileError('UNSUPPORTED_VERSION', `pnpm-lock.yaml 의 lockfileVersion ${versionText.slice(0, 20)} 은 지원하지 않습니다 (지원: 5, 6, 9).`);
  }

  const importers: Raw = isPlainObject(doc.importers)
    ? doc.importers
    : { '.': { dependencies: doc.dependencies, devDependencies: doc.devDependencies, optionalDependencies: doc.optionalDependencies } };
  const importerKeys = Object.keys(importers);
  if (importerKeys.length > MAX_ROOTS) throw new LockfileError('TOO_COMPLEX', '워크스페이스 수가 비정상적으로 많아 처리하지 않습니다.');

  const packagesMeta: Raw = isPlainObject(doc.packages) ? doc.packages : {};
  const graph: Raw = major >= 9 ? (isPlainObject(doc.snapshots) ? doc.snapshots : {}) : packagesMeta;
  const nodes = Object.keys(graph);
  checkCount(nodes.length, limits);
  for (const key of nodes) checkKey(key);

  const warnings = new WarningCollector();
  const budget = new WorkBudget();
  const has = (key: string) => Object.prototype.hasOwnProperty.call(graph, key) && isPlainObject(graph[key]);
  /** 다른 이름(별칭)으로 참조된 노드 */
  const aliased = new Set<string>();

  /** 의존성 참조(이름, 기록된 버전)를 그래프의 노드 키로 바꾼다. */
  const resolveRef = (depName: string, ref: string): string | 'LINK' | null => {
    if (ref.startsWith('link:')) return 'LINK';
    const candidates =
      major >= 9 ? [`${depName}@${ref}`, ref] : major === 6 ? [`/${depName}@${ref}`, ref, `/${ref}`] : [`/${depName}/${ref}`, ref, `/${ref}`];
    for (const candidate of candidates) {
      if (has(candidate)) {
        if (candidate === ref || candidate === `/${ref}`) {
          const parsed = parseKey(candidate, major);
          if (parsed && parsed.name !== depName) aliased.add(candidate);
        }
        return candidate;
      }
    }
    return null;
  };

  const prodRoots: string[] = [];
  const devRoots: string[] = [];
  const direct = new Set<string>();
  const localLinks = new Set<string>();
  for (const importerKey of importerKeys) {
    const importer = own(importers, importerKey);
    if (!isPlainObject(importer)) continue;
    const groups: Array<[unknown, string[]]> = [
      [importer.dependencies, prodRoots],
      [importer.optionalDependencies, prodRoots],
      [importer.devDependencies, devRoots],
    ];
    for (const [group, target] of groups) {
      for (const [depName, ref] of depEntries(group)) {
        budget.spend();
        const node = resolveRef(depName, ref);
        if (node === 'LINK') {
          localLinks.add(depName);
          continue;
        }
        if (!node) continue;
        direct.add(node);
        target.push(node);
      }
    }
  }
  for (const name of localLinks) warnings.add('LOCAL_PACKAGE', '워크스페이스 내부 패키지(link:) - 외부 패키지가 아니어서 검사하지 않음', name);

  const edgeCache = new Map<string, string[]>();
  const edges = (node: string): string[] => {
    const cached = edgeCache.get(node);
    if (cached) return cached;
    const entry = own(graph, node);
    const out: string[] = [];
    if (isPlainObject(entry)) {
      for (const [depName, ref] of [...depEntries(entry.dependencies), ...depEntries(entry.optionalDependencies)]) {
        const target = resolveRef(depName, ref);
        if (target && target !== 'LINK') out.push(target);
      }
    }
    edgeCache.set(node, out);
    return out;
  };

  const prodReached = shortestPaths(prodRoots, edges, budget).reached;
  const { parentOf, reached } = shortestPaths([...prodRoots, ...devRoots], edges, budget);

  const parts = new Map<string, KeyParts>();
  const metaOf = (key: string, kp: KeyParts): Raw | null => {
    const meta = major >= 9 ? own(packagesMeta, `${kp.name}@${kp.version}`) : own(packagesMeta, key);
    return isPlainObject(meta) ? meta : null;
  };
  const label = (key: string) => {
    const kp = parts.get(key);
    return kp ? `${kp.name}@${kp.version}` : key;
  };

  const packages: ParsedPackage[] = [];
  const packageKeys: string[] = [];
  for (const key of nodes) {
    const entry = own(graph, key);
    if (!isPlainObject(entry)) continue;
    const parsed = parseKey(key, major);
    if (!parsed) {
      warnings.add('UNSUPPORTED_REFERENCE', UNPARSEABLE, key);
      continue;
    }
    const meta = metaOf(key, parsed);
    // v5/v6 의 비레지스트리 항목은 name/version 을 따로 적는다.
    const name = typeof meta?.name === 'string' ? meta.name : parsed.name;
    const version = (typeof meta?.version === 'string' ? meta.version : parsed.version).slice(0, MAX_VERSION_LENGTH);
    parts.set(key, { name, version });

    let refKind = refKindOf(meta, parsed.version);
    if (refKind === 'REGISTRY' && aliased.has(key)) refKind = 'ALIAS';
    const { scannable, unsupportedReason } = classifyPackage(name, version, refKind, warnings, `${name}@${version}`.slice(0, 120));

    packages.push({
      name,
      version,
      installPath: `node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}`,
      isDirect: direct.has(key),
      isDev: reached.has(key) ? !prodReached.has(key) : isTrue(meta?.dev),
      isOptional: isTrue(entry.optional) || isTrue(meta?.optional),
      dependencyPath: [],
      refKind,
      scannable,
      unsupportedReason,
    });
    packageKeys.push(key);
  }
  // 경로 라벨은 모든 노드의 이름·버전을 안 뒤에 만든다.
  packages.forEach((pkg, index) => {
    pkg.dependencyPath = pathTo(packageKeys[index], parentOf, label);
  });

  const pkgJson = readPackageJson(packageJsonContent);
  if (packageJsonContent && !pkgJson) {
    warnings.add('PACKAGE_JSON_MISMATCH', 'package.json 을 JSON 으로 해석할 수 없어 비교를 건너뜀', 'package.json');
  }
  const rootImporter = own(importers, '.');
  if (pkgJson && isPlainObject(rootImporter)) {
    const declared = new Set([...pkgJson.dependencies, ...pkgJson.devDependencies, ...pkgJson.optionalDependencies].map(([n]) => n));
    const locked = new Set(
      [...depEntries(rootImporter.dependencies), ...depEntries(rootImporter.devDependencies), ...depEntries(rootImporter.optionalDependencies)].map(([n]) => n),
    );
    for (const name of declared) {
      if (!locked.has(name)) warnings.add('PACKAGE_JSON_MISMATCH', 'package.json 에는 있으나 lockfile 루트에 없는 의존성 - lockfile 이 최신이 아닐 수 있음', name);
    }
    for (const name of locked) {
      if (!declared.has(name)) warnings.add('PACKAGE_JSON_MISMATCH', 'lockfile 루트에는 있으나 package.json 에 없는 의존성 - 두 파일이 서로 다른 시점의 것일 수 있음', name);
    }
  }

  return {
    format: 'PNPM',
    lockfileVersion: major,
    rootName: pkgJson?.name ?? null,
    packages: mergeDuplicates(packages),
    warnings: warnings.list(),
  };
}

const UNPARSEABLE = '해석할 수 없는 pnpm 항목 이름 - 검사하지 않음';

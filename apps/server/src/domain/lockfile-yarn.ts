import {
  LockfileError,
  MAX_DEPS_PER_ENTRY,
  MAX_NAME_LENGTH,
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
  type PackageJsonDeps,
  type ParsedLockfile,
  type ParsedPackage,
  type RefKind,
} from './lockfile-common.js';
import { loadYamlDocuments } from './lockfile-yaml.js';

/**
 * yarn.lock 파서.
 * - Yarn 1: 전용 텍스트 형식. 직접 의존성은 package.json 으로만 알 수 있다.
 * - Yarn 2 이상(Berry): YAML. workspace: 항목의 dependencies 가 직접 의존성이다.
 */

interface YarnNode {
  /** 실제 패키지명 (별칭이면 대상 이름) */
  name: string;
  version: string;
  refKind: RefKind;
  aliased: boolean;
  deps: Array<[string, string]>;
  optional: boolean;
  workspace: string | null;
}

/** "name@range" → [name, range]. 범위 쪽에 "@" 가 있을 수 있으므로 이름 쪽에서 자른다. */
function splitSpec(spec: string): [string, string] {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at <= 0 ? [spec, ''] : [spec.slice(0, at), spec.slice(at + 1)];
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'string') return parsed;
    } catch {
      // 아래에서 따옴표만 벗긴다
    }
    return value.slice(1, -1);
  }
  return value;
}

/** 따옴표 밖의 구분자로 나눈다. */
function splitOutsideQuotes(line: string, separator: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && line.startsWith(separator, i)) {
      out.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** '키 값' 한 줄을 나눈다. 키와 값은 따옴표로 감쌀 수 있다. */
function splitKeyValue(text: string): [string, string] | null {
  let keyEnd: number;
  if (text.startsWith('"')) {
    keyEnd = 1;
    while (keyEnd < text.length && !(text[keyEnd] === '"' && text[keyEnd - 1] !== '\\')) keyEnd += 1;
    keyEnd += 1;
  } else {
    keyEnd = text.indexOf(' ');
    if (keyEnd === -1) return null;
  }
  const key = unquote(text.slice(0, keyEnd));
  const value = unquote(text.slice(keyEnd).trim());
  return [key, value];
}

/** 범위(또는 Berry 의 descriptor) 자체가 가리키는 출처. 레지스트리 범위면 null. */
function refKindFromRange(range: string): RefKind | null {
  const r = range.startsWith('npm:') ? null : range;
  if (r === null) return null;
  if (r.startsWith('file:')) return 'FILE';
  if (r.startsWith('link:') || r.startsWith('portal:') || r.startsWith('workspace:')) return 'LINK';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(r) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(r)) return 'GIT';
  if (/^https?:\/\//.test(r)) {
    // Yarn 2+ 는 git 저장소를 https://…/repo.git#commit=… 로 적는다.
    const [url, hash = ''] = r.split('#');
    if (url.endsWith('.git') || /(^|&)(commit|head|tag|semver)=/.test(hash)) return 'GIT';
    return classifyResolved(r);
  }
  if (r.startsWith('exec:') || r.startsWith('patch:')) return 'UNKNOWN';
  return null;
}

/** "npm:real@^1.0.0" 별칭이면 실제 이름 */
function aliasTarget(range: string): string | null {
  if (!range.startsWith('npm:')) return null;
  const rest = range.slice(4);
  const at = rest.indexOf('@', rest.startsWith('@') ? 1 : 0);
  return at > 0 ? rest.slice(0, at) : null;
}

function parseClassic(content: string, limits: LockfileLimits): { nodes: YarnNode[]; specs: Map<string, number> } {
  const nodes: YarnNode[] = [];
  const specs = new Map<string, number>();
  let current: YarnNode | null = null;
  let section: string | null = null;

  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (indent === 0) {
      if (!text.endsWith(':')) throw new LockfileError('INVALID_FORMAT', 'yarn.lock 형식으로 해석할 수 없는 줄이 있습니다.');
      const entrySpecs = splitOutsideQuotes(text.slice(0, -1), ', ').map((s) => unquote(s.trim())).filter(Boolean);
      if (entrySpecs.length === 0 || entrySpecs.length > MAX_DEPS_PER_ENTRY) {
        throw new LockfileError('TOO_COMPLEX', 'yarn.lock 항목 이름이 비정상적입니다.');
      }
      const [specName, range] = splitSpec(entrySpecs[0]);
      const target = aliasTarget(range);
      current = {
        name: (target ?? specName).slice(0, MAX_NAME_LENGTH),
        version: '',
        refKind: refKindFromRange(range) ?? 'REGISTRY',
        aliased: target !== null && target !== specName,
        deps: [],
        optional: false,
        workspace: null,
      };
      nodes.push(current);
      checkCount(nodes.length, limits);
      for (const spec of entrySpecs) {
        checkKey(spec);
        specs.set(spec, nodes.length - 1);
      }
      section = null;
      continue;
    }
    if (!current) throw new LockfileError('INVALID_FORMAT', 'yarn.lock 형식으로 해석할 수 없는 줄이 있습니다.');
    if (indent <= 2) {
      if (text.endsWith(':')) {
        section = unquote(text.slice(0, -1));
        continue;
      }
      section = null;
      const pair = splitKeyValue(text);
      if (!pair) continue;
      const [key, value] = pair;
      if (key === 'version') current.version = value.slice(0, MAX_VERSION_LENGTH);
      else if (key === 'resolved' && current.refKind === 'REGISTRY') current.refKind = classifyResolved(value);
      continue;
    }
    if (section === 'dependencies' || section === 'optionalDependencies') {
      const pair = splitKeyValue(text);
      if (!pair) continue;
      if (current.deps.length >= MAX_DEPS_PER_ENTRY) {
        throw new LockfileError('TOO_COMPLEX', `한 패키지의 의존성 수가 제한(${MAX_DEPS_PER_ENTRY})을 넘습니다.`);
      }
      checkKey(pair[0]);
      checkKey(pair[1]);
      current.deps.push(pair);
    }
  }
  return { nodes, specs };
}

function berryRefKind(resolution: string): { kind: RefKind; workspace: string | null } {
  const [, descriptor] = splitSpec(resolution);
  if (descriptor.startsWith('npm:')) return { kind: 'REGISTRY', workspace: null };
  if (descriptor.startsWith('workspace:')) return { kind: 'LINK', workspace: descriptor.slice('workspace:'.length) };
  if (descriptor.startsWith('patch:')) {
    // patch:name@npm%3A1.2.3#... → 원래 패키지가 레지스트리 버전이면 그 버전으로 검사한다.
    let inner = descriptor.slice('patch:'.length).split('#')[0];
    try {
      inner = decodeURIComponent(inner);
    } catch {
      return { kind: 'UNKNOWN', workspace: null };
    }
    return { kind: splitSpec(inner)[1].startsWith('npm:') ? 'REGISTRY' : 'UNKNOWN', workspace: null };
  }
  return { kind: refKindFromRange(descriptor) ?? 'UNKNOWN', workspace: null };
}

function parseBerry(doc: Record<string, unknown>, limits: LockfileLimits): { nodes: YarnNode[]; specs: Map<string, number> } {
  const nodes: YarnNode[] = [];
  const specs = new Map<string, number>();
  const keys = Object.keys(doc).filter((key) => key !== '__metadata');
  checkCount(keys.length, limits);
  for (const key of keys) {
    checkKey(key);
    const entry = own(doc, key);
    if (!isPlainObject(entry)) continue;
    const resolution = typeof entry.resolution === 'string' ? entry.resolution : '';
    const [resolvedName] = splitSpec(resolution);
    const entrySpecs = key.split(', ').map((s) => s.trim()).filter(Boolean);
    if (entrySpecs.length > MAX_DEPS_PER_ENTRY) throw new LockfileError('TOO_COMPLEX', 'yarn.lock 항목 이름이 비정상적입니다.');
    const [specName] = splitSpec(entrySpecs[0] ?? resolution);
    const { kind, workspace } = berryRefKind(resolution);
    const name = (resolvedName || specName).slice(0, MAX_NAME_LENGTH);
    nodes.push({
      name,
      version: (typeof entry.version === 'string' ? entry.version : '').slice(0, MAX_VERSION_LENGTH),
      refKind: kind,
      aliased: kind === 'REGISTRY' && name !== specName,
      deps: depEntries(entry.dependencies),
      optional: typeof entry.conditions === 'string',
      workspace,
    });
    for (const spec of entrySpecs) specs.set(spec, nodes.length - 1);
  }
  return { nodes, specs };
}

export function parseYarnLockfile(content: string, limits: LockfileLimits, packageJsonContent?: string | null): ParsedLockfile {
  const warnings = new WarningCollector();
  const budget = new WorkBudget();
  const pkgJson: PackageJsonDeps | null = readPackageJson(packageJsonContent);
  if (packageJsonContent && !pkgJson) warnings.add('PACKAGE_JSON_MISMATCH', 'package.json 을 JSON 으로 해석할 수 없어 비교를 건너뜀', 'package.json');

  const head = content.slice(0, 4096);
  const isBerry = /^"?__metadata"?:/m.test(head);
  let lockfileVersion = 1;
  let parsed: { nodes: YarnNode[]; specs: Map<string, number> };
  if (isBerry) {
    const [doc] = loadYamlDocuments(content);
    if (!isPlainObject(doc) || !isPlainObject(doc.__metadata)) throw new LockfileError('NOT_A_LOCKFILE', 'yarn.lock 형식이 아닙니다.');
    lockfileVersion = Number.parseInt(String(doc.__metadata.version ?? ''), 10) || 0;
    parsed = parseBerry(doc, limits);
  } else {
    parsed = parseClassic(content, limits);
  }
  const { nodes, specs } = parsed;

  const resolve = (depName: string, range: string): number | null => {
    const found = specs.get(`${depName}@${range}`) ?? (isBerry ? specs.get(`${depName}@npm:${range}`) : undefined);
    return found ?? null;
  };

  const prodRoots: string[] = [];
  const devRoots: string[] = [];
  const direct = new Set<string>();
  const addRoot = (index: number | null, dev: boolean) => {
    if (index === null || nodes[index].workspace !== null) return;
    const key = String(index);
    direct.add(key);
    (dev ? devRoots : prodRoots).push(key);
  };

  if (isBerry) {
    const devNames = new Set((pkgJson?.devDependencies ?? []).map(([n]) => n));
    const workspaces = nodes.filter((node) => node.workspace !== null);
    if (workspaces.length > MAX_ROOTS) throw new LockfileError('TOO_COMPLEX', '워크스페이스 수가 비정상적으로 많아 처리하지 않습니다.');
    for (const ws of workspaces) {
      for (const [depName, range] of ws.deps) {
        budget.spend();
        // 개발 의존성 구분은 루트 package.json 으로만 할 수 있다.
        addRoot(resolve(depName, range), ws.workspace === '.' && devNames.has(depName));
      }
    }
    if (!pkgJson) warnings.add('DIRECT_UNKNOWN', 'package.json 이 없어 개발 의존성을 구분하지 못함 - 모든 패키지를 검사함', 'package.json');
  } else if (pkgJson) {
    const groups: Array<[Array<[string, string]>, boolean]> = [
      [pkgJson.dependencies, false],
      [pkgJson.optionalDependencies, false],
      [pkgJson.devDependencies, true],
    ];
    for (const [entries, dev] of groups) {
      for (const [depName, range] of entries) {
        budget.spend();
        const index = resolve(depName, range);
        if (index === null) {
          warnings.add('PACKAGE_JSON_MISMATCH', 'package.json 에는 있으나 yarn.lock 에 없는 의존성 - lockfile 이 최신이 아닐 수 있음', depName);
          continue;
        }
        addRoot(index, dev);
      }
    }
    if (pkgJson.hasWorkspaces) {
      warnings.add('DIRECT_UNKNOWN', 'Yarn 1 워크스페이스 하위 패키지의 직접 의존성은 구분하지 못함 - 모두 검사함', 'workspaces');
    }
  } else {
    warnings.add('DIRECT_UNKNOWN', 'package.json 이 없어 직접 의존성과 개발 의존성을 구분하지 못함 - 모든 패키지를 검사함', 'package.json');
  }

  const edges = (key: string): string[] => {
    const node = nodes[Number(key)];
    const out: string[] = [];
    for (const [depName, range] of node?.deps ?? []) {
      const index = resolve(depName, range);
      if (index !== null && nodes[index].workspace === null) out.push(String(index));
    }
    return out;
  };
  const prodReached = shortestPaths(prodRoots, edges, budget).reached;
  const { parentOf, reached } = shortestPaths([...prodRoots, ...devRoots], edges, budget);
  const label = (key: string) => {
    const node = nodes[Number(key)];
    return node ? `${node.name}@${node.version}` : key;
  };

  const packages: ParsedPackage[] = [];
  nodes.forEach((node, index) => {
    if (node.workspace !== null) return; // 프로젝트 자신(워크스페이스)은 검사 대상이 아니다
    const key = String(index);
    const refKind: RefKind = node.refKind === 'REGISTRY' && node.aliased ? 'ALIAS' : node.refKind;
    const { scannable, unsupportedReason } = classifyPackage(node.name, node.version, refKind, warnings, `${node.name}@${node.version}`);
    packages.push({
      name: node.name,
      version: node.version,
      installPath: `${node.name}@${node.version}`,
      isDirect: direct.has(key),
      isDev: reached.has(key) && !prodReached.has(key),
      isOptional: node.optional,
      dependencyPath: pathTo(key, parentOf, label),
      refKind,
      scannable,
      unsupportedReason,
    });
  });

  return {
    format: 'YARN',
    lockfileVersion,
    rootName: pkgJson?.name ?? null,
    packages: mergeDuplicates(packages),
    warnings: warnings.list(),
  };
}

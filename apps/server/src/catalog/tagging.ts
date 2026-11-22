export type MappingKind = 'ECOSYSTEM' | 'PACKAGE' | 'CPE';

export interface MappingRow {
  technologyId: string;
  kind: MappingKind;
  ecosystem: string | null;
  pattern: string | null;
}

export interface TagInput {
  packages: Array<{ ecosystem: string; name: string }>;
  products: Array<{ vendor: string; product: string }>;
}

function matchesPattern(pattern: string, value: string): boolean {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
}

const STRENGTH: Record<MappingKind, number> = { PACKAGE: 3, CPE: 2, ECOSYSTEM: 1 };

/**
 * 취약점이 어떤 기술에 해당하는지 구조화된 근거(패키지·CPE·생태계)로만 판단한다.
 * 같은 기술에 여러 근거가 있으면 가장 구체적인 것을 남긴다.
 */
export function computeTechnologyTags(input: TagInput, mappings: MappingRow[]): Map<string, MappingKind> {
  const tags = new Map<string, MappingKind>();
  const add = (technologyId: string, kind: MappingKind) => {
    const current = tags.get(technologyId);
    if (!current || STRENGTH[kind] > STRENGTH[current]) tags.set(technologyId, kind);
  };
  for (const mapping of mappings) {
    if (mapping.kind === 'ECOSYSTEM') {
      if (input.packages.some((p) => p.ecosystem === mapping.ecosystem)) add(mapping.technologyId, 'ECOSYSTEM');
    } else if (mapping.kind === 'PACKAGE' && mapping.pattern) {
      const pattern = mapping.pattern;
      if (input.packages.some((p) => p.ecosystem === mapping.ecosystem && matchesPattern(pattern, p.name))) {
        add(mapping.technologyId, 'PACKAGE');
      }
    } else if (mapping.kind === 'CPE' && mapping.pattern) {
      const pattern = mapping.pattern;
      if (input.products.some((p) => matchesPattern(pattern, `${p.vendor}:${p.product}`))) add(mapping.technologyId, 'CPE');
    }
  }
  return tags;
}

/** "cpe:2.3:a:vendor:product:..." → { vendor, product } */
export function parseCpe(criteria: string): { vendor: string; product: string } | null {
  const parts = criteria.split(':');
  if (parts[0] !== 'cpe' || parts[1] !== '2.3' || parts.length < 5) return null;
  const vendor = parts[3];
  const product = parts[4];
  if (!vendor || !product || vendor === '*' || product === '*') return null;
  return { vendor: vendor.toLowerCase(), product: product.toLowerCase() };
}

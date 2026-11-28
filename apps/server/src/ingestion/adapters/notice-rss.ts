import type { PrismaService } from '../../db/prisma.service.js';
import type { IngestContext } from '../context.js';

/** RSS 로 받는 보안공지 한 건. 제목·주소·날짜만 쓴다. */
export interface NoticeItem {
  externalId: string;
  title: string;
  url: string;
  publishedAt: Date;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** RSS 의 item 블록들 */
export function rssItems(xml: string): string[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
}

/** 태그 안의 텍스트만 꺼낸다 (CDATA·엔티티 처리). 마크업은 해석하지 않는다. */
export function rssText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return '';
  const raw = match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return raw
    .replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});|&(amp|lt|gt|quot|apos);/gi, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name) return ENTITIES[name.toLowerCase()];
      const code = hex ? Number.parseInt(hex, 16) : Number(dec);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 공지 RSS 를 받아 새 공지를 저장한다. name 은 오류 문구에 쓰는 출처 이름이다. */
export async function ingestNoticeFeed(
  prisma: PrismaService,
  context: IngestContext,
  options: { source: 'KISA' | 'AWS'; name: string; feed: string; parse: (xml: string) => NoticeItem[] },
): Promise<void> {
  const { source, name } = options;
  const response = await context.fetch(options.feed, { redirect: 'error', timeoutMs: 30_000 });
  const xml = await response.text();
  // 점검 안내 페이지나 형식 변경을 "공지 0건, 정상"으로 넘기지 않는다.
  if (!/<rss[\s>]/.test(xml)) throw new Error(`${name} 응답이 RSS 형식이 아닙니다 (점검 중이거나 주소가 바뀌었을 수 있음).`);
  if (!/<item>/.test(xml)) throw new Error(`${name} RSS 에 항목이 없습니다.`);
  const notices = options.parse(xml);
  if (notices.length === 0) throw new Error(`${name} RSS 항목을 해석하지 못했습니다 (형식이 바뀌었을 수 있음).`);
  context.count('fetched', notices.length);
  for (const notice of notices) {
    const existing = await prisma.publicNotice.findUnique({ where: { source_externalId: { source, externalId: notice.externalId } } });
    if (existing) {
      if (existing.title !== notice.title) await prisma.publicNotice.update({ where: { id: existing.id }, data: { title: notice.title } });
      continue;
    }
    await prisma.publicNotice.create({ data: { source, ...notice } });
    context.count('upserted');
    context.count('changed');
  }
}

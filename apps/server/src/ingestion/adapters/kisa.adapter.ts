import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import type { IngestContext, SourceAdapter } from '../context.js';

/**
 * KISA 보호나라 보안공지 RSS.
 * 역할: 국내 공공 보안 권고를 놓치지 않게 목록·달력에 보여준다.
 * RSS 에는 제목·주소·날짜만 있고 영향 버전이 없으므로 기술 분류나 버전 매칭에 쓰지 않는다.
 */
const FEED = 'https://www.boho.or.kr/kr/rss.do?bbsId=B0000133';
const MAX_ITEMS = 100;

export interface KisaNotice {
  externalId: string;
  title: string;
  url: string;
  publishedAt: Date;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 태그 안의 텍스트만 꺼낸다 (CDATA·엔티티 처리). 마크업은 해석하지 않는다. */
function text(block: string, tag: string): string {
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

/** 보호나라 게시물 주소만 받는다. 게시물 번호(nttId)를 식별자로 쓴다. */
export function parseKisaRss(xml: string): KisaNotice[] {
  const notices: KisaNotice[] = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (notices.length >= MAX_ITEMS) break;
    const title = text(block, 'title').slice(0, 300);
    const link = text(block, 'link');
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    const externalId = url.searchParams.get('nttId') ?? '';
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(block, 'pubDate'));
    if (url.protocol !== 'https:' || url.hostname !== 'www.boho.or.kr' || !/^\d{1,12}$/.test(externalId) || !title || !date) continue;
    notices.push({
      externalId,
      title,
      url: `https://www.boho.or.kr/kr/bbs/view.do?bbsId=B0000133&menuNo=205020&nttId=${externalId}`,
      // 게시 날짜만 있으므로 한국 시간 자정으로 본다.
      publishedAt: new Date(`${date[1]}-${date[2]}-${date[3]}T00:00:00+09:00`),
    });
  }
  return notices;
}

@Injectable()
export class KisaAdapter implements SourceAdapter {
  readonly key = 'KISA' as const;

  constructor(private readonly prisma: PrismaService) {}

  async run(context: IngestContext): Promise<void> {
    const response = await context.fetch(FEED, { redirect: 'error', timeoutMs: 30_000 });
    const xml = await response.text();
    // 점검 안내 페이지나 형식 변경을 "공지 0건, 정상"으로 넘기지 않는다.
    if (!/<rss[\s>]/.test(xml)) throw new Error('KISA 보안공지 응답이 RSS 형식이 아닙니다 (점검 중이거나 주소가 바뀌었을 수 있음).');
    if (!/<item>/.test(xml)) throw new Error('KISA 보안공지 RSS 에 항목이 없습니다.');
    const notices = parseKisaRss(xml);
    if (notices.length === 0) throw new Error('KISA 보안공지 RSS 항목을 해석하지 못했습니다 (형식이 바뀌었을 수 있음).');
    context.count('fetched', notices.length);
    for (const notice of notices) {
      const existing = await this.prisma.publicNotice.findUnique({ where: { source_externalId: { source: 'KISA', externalId: notice.externalId } } });
      if (existing) {
        if (existing.title !== notice.title) await this.prisma.publicNotice.update({ where: { id: existing.id }, data: { title: notice.title } });
        continue;
      }
      await this.prisma.publicNotice.create({ data: { source: 'KISA', ...notice } });
      context.count('upserted');
      context.count('changed');
    }
  }
}

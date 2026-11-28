import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import type { IngestContext, SourceAdapter } from '../context.js';
import { ingestNoticeFeed, rssItems, rssText, type NoticeItem } from './notice-rss.js';

/**
 * KISA 보호나라 보안공지 RSS.
 * 역할: 국내 공공 보안 권고를 놓치지 않게 목록·달력에 보여준다.
 * RSS 에는 제목·주소·날짜만 있고 영향 버전이 없으므로 기술 분류나 버전 매칭에 쓰지 않는다.
 */
const FEED = 'https://www.boho.or.kr/kr/rss.do?bbsId=B0000133';
const MAX_ITEMS = 100;

/** 보호나라 게시물 주소만 받는다. 게시물 번호(nttId)를 식별자로 쓴다. */
export function parseKisaRss(xml: string): NoticeItem[] {
  const notices: NoticeItem[] = [];
  for (const block of rssItems(xml)) {
    if (notices.length >= MAX_ITEMS) break;
    const title = rssText(block, 'title').slice(0, 300);
    const link = rssText(block, 'link');
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    const externalId = url.searchParams.get('nttId') ?? '';
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(rssText(block, 'pubDate'));
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

  run(context: IngestContext): Promise<void> {
    return ingestNoticeFeed(this.prisma, context, { source: 'KISA', name: 'KISA 보안공지', feed: FEED, parse: parseKisaRss });
  }
}

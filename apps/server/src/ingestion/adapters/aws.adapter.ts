import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import type { IngestContext, SourceAdapter } from '../context.js';
import { ingestNoticeFeed, rssItems, rssText, type NoticeItem } from './notice-rss.js';

/**
 * AWS 보안 공지(Security Bulletins) RSS.
 * 역할: AWS 서비스와 도구의 공식 보안 공지를 놓치지 않게 목록·달력·브리핑에 보여준다.
 * 영향 버전이 구조화되어 있지 않으므로 기술 분류나 버전 매칭에 쓰지 않는다.
 */
const FEED = 'https://aws.amazon.com/security/security-bulletins/rss/feed/';
const MAX_ITEMS = 200;

/** AWS 보안 공지 주소만 받는다. 주소 끝의 공지 번호(예: 2026-173-aws)를 식별자로 쓴다. */
export function parseAwsRss(xml: string): NoticeItem[] {
  const notices: NoticeItem[] = [];
  for (const block of rssItems(xml)) {
    if (notices.length >= MAX_ITEMS) break;
    const title = rssText(block, 'title').slice(0, 300);
    let url: URL;
    try {
      url = new URL(rssText(block, 'link'));
    } catch {
      continue;
    }
    const path = /^\/security\/security-bulletins\/(?:[a-z0-9-]+\/)*([a-z0-9][a-z0-9-]{2,39})\/?$/i.exec(url.pathname);
    const publishedAt = new Date(rssText(block, 'pubDate'));
    if (url.protocol !== 'https:' || url.hostname !== 'aws.amazon.com' || !path || !title || Number.isNaN(publishedAt.getTime())) continue;
    notices.push({ externalId: path[1].toLowerCase(), title, url: `https://aws.amazon.com${url.pathname}`, publishedAt });
  }
  return notices;
}

@Injectable()
export class AwsAdapter implements SourceAdapter {
  readonly key = 'AWS' as const;

  constructor(private readonly prisma: PrismaService) {}

  run(context: IngestContext): Promise<void> {
    return ingestNoticeFeed(this.prisma, context, { source: 'AWS', name: 'AWS 보안 공지', feed: FEED, parse: parseAwsRss });
  }
}

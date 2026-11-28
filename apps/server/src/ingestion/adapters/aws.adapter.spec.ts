import { parseAwsRss } from './aws.adapter.js';

const item = (title: string, link: string, date = 'Fri, 06 Nov 2026 17:19:55 +0000') =>
  `<item><link>${link}</link><guid isPermaLink="false">abc</guid><title>${title}</title><description>&lt;p&gt;본문&lt;/p&gt;</description><pubDate>${date}</pubDate></item>`;

describe('AWS 보안 공지 RSS', () => {
  it('제목·공지 번호·게시 시각을 읽는다', () => {
    const xml = `<rss><channel>${item('CVE-2026-122193 - Issue with Trusted Remote Execution &amp; SSM', 'https://aws.amazon.com/security/security-bulletins/rss/2026-173-aws/')}</channel></rss>`;
    expect(parseAwsRss(xml)).toEqual([
      {
        externalId: '2026-173-aws',
        title: 'CVE-2026-122193 - Issue with Trusted Remote Execution & SSM',
        url: 'https://aws.amazon.com/security/security-bulletins/rss/2026-173-aws/',
        publishedAt: new Date('2026-11-06T17:19:55Z'),
      },
    ]);
  });

  it('다른 사이트 주소, 공지 경로가 아닌 주소, 날짜를 못 읽는 항목은 버린다', () => {
    const xml = [
      item('a', 'https://evil.example/security/security-bulletins/rss/2026-1-aws/'),
      item('b', 'http://aws.amazon.com/security/security-bulletins/rss/2026-2-aws/'),
      item('c', 'https://aws.amazon.com/blogs/security/2026-3-aws/'),
      item('d', 'javascript:alert(1)'),
      item('e', 'https://aws.amazon.com/security/security-bulletins/rss/2026-5-aws/', 'someday'),
    ].join('');
    expect(parseAwsRss(xml)).toEqual([]);
  });
});

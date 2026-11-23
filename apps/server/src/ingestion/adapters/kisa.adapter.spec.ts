import { parseKisaRss } from './kisa.adapter.js';

const item = (title: string, link: string, date = '2026-11-20') =>
  `<item><title><![CDATA[ ${title} ]]></title><link><![CDATA[ ${link} ]]></link><pubDate><![CDATA[ ${date} ]]></pubDate></item>`;

describe('KISA 보호나라 RSS', () => {
  it('제목·게시물 번호·날짜를 읽고 보호나라 주소로만 다시 만든다', () => {
    const xml = `<rss><channel>${item('VMware 제품 보안 업데이트 권고 &amp; 안내', 'https://www.boho.or.kr/kr/bbs/view.do?bbsId=B0000133&menuNo=205020&nttId=72319')}</channel></rss>`;
    expect(parseKisaRss(xml)).toEqual([
      {
        externalId: '72319',
        title: 'VMware 제품 보안 업데이트 권고 & 안내',
        url: 'https://www.boho.or.kr/kr/bbs/view.do?bbsId=B0000133&menuNo=205020&nttId=72319',
        publishedAt: new Date('2026-11-19T15:00:00Z'),
      },
    ]);
  });

  it('숫자 문자 참조를 글자로 바꾼다', () => {
    const xml = item('Apple &#39;iOS&#39; &#x27;보안&#x27; 업데이트', 'https://www.boho.or.kr/kr/bbs/view.do?nttId=9');
    expect(parseKisaRss(xml)[0].title).toBe("Apple 'iOS' '보안' 업데이트");
  });

  it('다른 사이트 주소, javascript 주소, 번호나 날짜가 없는 항목은 버린다', () => {
    const xml = [
      item('a', 'https://evil.example/kr/bbs/view.do?nttId=1'),
      item('b', 'javascript:alert(1)//?nttId=2'),
      item('c', 'http://www.boho.or.kr/kr/bbs/view.do?nttId=3'),
      item('d', 'https://www.boho.or.kr/kr/bbs/view.do?nttId=abc'),
      item('e', 'https://www.boho.or.kr/kr/bbs/view.do?nttId=5', 'yesterday'),
    ].join('');
    expect(parseKisaRss(xml)).toEqual([]);
  });
});

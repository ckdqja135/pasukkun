import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const render = (text: string) => renderToStaticMarkup(<Markdown>{text}</Markdown>);

describe('외부 공지 본문 렌더링', () => {
  it('원시 HTML 과 스크립트를 실행 가능한 형태로 내보내지 않는다', () => {
    const html = render('## Impact\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.example"></iframe>\n\ntext <b onclick="x()">bold</b>');
    expect(html).not.toMatch(/<script|<iframe|onerror|onclick|<img/i);
    expect(html).toContain('<h2>Impact</h2>');
  });

  it('javascript: / data: 링크는 링크로 만들지 않는다', () => {
    const html = render('[click](javascript:alert(1)) [data](data:text/html,<script>1</script>) [ok](https://example.com/a)');
    expect(html).not.toMatch(/href="javascript:|href="data:/i);
    expect(html).toContain('href="https://example.com/a"');
  });

  it('외부 링크는 새 창에서 열되 opener 를 넘기지 않는다', () => {
    const html = render('[ok](https://example.com/a)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('이미지는 불러오지 않고 링크로만 보여준다 (외부 추적 요청 방지)', () => {
    const html = render('![pixel](https://tracker.example/p.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://tracker.example/p.png"');
  });

  it('표·코드 같은 일반 Markdown 은 그대로 보여준다', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n`code` and\n\n```js\nconst x = "<script>";\n```');
    expect(html).toContain('<table>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('&lt;script&gt;');
  });
});

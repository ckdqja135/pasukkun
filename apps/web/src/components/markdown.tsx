import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * 외부 공지 본문(Markdown) 렌더링.
 * - 원시 HTML 은 해석하지 않는다 (react-markdown 기본 동작: 텍스트로 취급).
 * - 링크는 http/https/mailto 만 허용하고 새 창에서 연다.
 * - 이미지는 외부 요청을 일으키므로 불러오지 않고 링크로만 보여준다.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-advisory text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (SAFE_URL.test(url) ? url : '')}
        components={{
          a: ({ href, children: label }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            ),
          img: ({ src, alt }) =>
            typeof src === 'string' && src ? (
              <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
                [이미지: {alt || '보기'}]
              </a>
            ) : null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

import { DEFAULT_TEMPLATES, renderTemplate, TemplateError, validateTemplate } from './template.js';

describe('알림 문구 틀', () => {
  it('자리표시자를 값으로 바꾸고, 값이 없으면 - 로 채운다', () => {
    const text = renderTemplate('[{우선순위}] {제목}\n{패키지}@{현재버전} → {수정버전}', {
      우선순위: '긴급',
      제목: 'lodash Code Injection',
      패키지: 'lodash',
      현재버전: '4.17.20',
    });
    expect(text).toBe('[긴급] lodash Code Injection\nlodash@4.17.20 → -');
  });

  it('값 안에 든 중괄호는 다시 바꾸지 않는다', () => {
    expect(renderTemplate('{제목}', { 제목: '{프로젝트} 노출' })).toBe('{프로젝트} 노출');
  });

  it('알 수 없는 자리표시자는 저장할 때 알려준다', () => {
    expect(() => validateTemplate('{제목} {담당자} {날짜}')).toThrow(TemplateError);
    try {
      validateTemplate('{제목} {담당자} {날짜}');
    } catch (error) {
      expect((error as TemplateError).unknown).toEqual(['담당자', '날짜']);
    }
  });

  it('빈 문구는 기본 형식을 쓰라는 뜻이고, 너무 긴 문구는 거부한다', () => {
    expect(validateTemplate('   ')).toBeNull();
    expect(validateTemplate(null)).toBeNull();
    expect(() => validateTemplate('가'.repeat(1501))).toThrow(TemplateError);
    expect(validateTemplate('  {제목}\r\n')).toBe('{제목}');
  });

  it('기본 틀은 유효하다', () => {
    expect(validateTemplate(DEFAULT_TEMPLATES.PROJECT_IMPACT)).toBe(DEFAULT_TEMPLATES.PROJECT_IMPACT);
    expect(validateTemplate(DEFAULT_TEMPLATES.TECH_INTEREST)).toBe(DEFAULT_TEMPLATES.TECH_INTEREST);
  });
});

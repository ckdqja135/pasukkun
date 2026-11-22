import { cvss3BaseScore, cvssVersion, severityFromLabel, severityFromScore } from './cvss.js';

describe('CVSS v3 기본 점수', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
    ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N', 5.9],
    ['CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10.0],
    ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 7.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', 7.5],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:N', 0],
  ])('%s → %s', (vector, expected) => {
    expect(cvss3BaseScore(vector)).toBe(expected);
  });

  it('v4·v2·형식 오류는 점수를 추측하지 않는다', () => {
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    expect(cvss3BaseScore('AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBeNull();
    expect(cvss3BaseScore('CVSS:3.1/AV:X/AC:L')).toBeNull();
    expect(cvssVersion('CVSS:4.0/AV:N')).toBe('4.0');
    expect(cvssVersion('AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBe('2.0');
  });

  it('점수와 라벨을 심각도로 바꾼다', () => {
    expect(severityFromScore(9.0)).toBe('CRITICAL');
    expect(severityFromScore(6.9)).toBe('MEDIUM');
    expect(severityFromScore(null)).toBe('UNKNOWN');
    expect(severityFromLabel('moderate')).toBe('MEDIUM');
    expect(severityFromLabel(undefined)).toBe('UNKNOWN');
  });
});

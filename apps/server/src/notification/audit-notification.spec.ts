import type { AppEnv } from '../config/env.js';
import type { NotificationMessage } from './message.js';
import { DiscordProvider } from './providers/discord.provider.js';
import { quietUntil } from './rules.js';
import { latestSlot, nextSlot } from './schedule.js';
import { renderTemplate } from './template.js';

const env = { telegramBotToken: '1:x', discord: { botToken: 'b', clientId: '1', clientSecret: 's' } } as unknown as AppEnv;

describe('audit: quiet hours across DST', () => {
  const quiet = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60, timezone: 'America/New_York' };

  it('fall back: early release at 07:00 local is re-held until 08:00 local (no send inside quiet hours)', () => {
    // 2026-10-31 23:00 EDT = 2026-11-01T03:00Z. DST ends 2026-11-01 02:00 local. 08:00 EST = 13:00Z.
    const first = quietUntil(new Date('2026-11-01T03:00:00Z'), quiet)!;
    expect(first.toISOString()).toBe('2026-11-01T12:00:00.000Z'); // 07:00 EST
    expect(quietUntil(first, quiet)?.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('audit: schedule slots on DST transition days', () => {
  it('a 02:30 daily slot on the spring-forward day still fires once that day', () => {
    const schedule = { type: 'DAILY' as const, times: ['02:30'] };
    const slot = latestSlot(new Date('2026-03-08T12:00:00Z'), schedule, 'America/New_York');
    // Must be a 2026-03-08 instant (local date), not the previous day.
    expect(slot).not.toBeNull();
    expect(slot!.getTime()).toBeGreaterThan(new Date('2026-03-08T05:00:00Z').getTime());
  });

  it('nextSlot and latestSlot agree around fall-back', () => {
    const schedule = { type: 'DAILY' as const, times: ['01:30'] };
    const next = nextSlot(new Date('2026-11-01T04:00:00Z'), schedule, 'America/New_York');
    expect(next).not.toBeNull();
    expect(latestSlot(next!, schedule, 'America/New_York')?.getTime()).toBe(next!.getTime());
  });
});

describe('audit: Discord markdown from external text', () => {
  const discord = new DiscordProvider(env);
  const base: NotificationMessage = { heading: 'h', title: 't', identifiers: [], fields: [], links: [], tone: 'info', footer: 'f' };

  it('masked links and mentions are neutralized in every field', () => {
    const hostile = '[safe](https://evil.example) @everyone <@&123456> <#123456>';
    const payload = discord.format({ ...base, title: hostile, lead: hostile, fields: [{ label: hostile, value: hostile }], footer: hostile });
    const json = JSON.stringify(payload.embeds[0]);
    expect(json).not.toContain('](');
    expect(json).not.toMatch(/@everyone/);
    expect(json).not.toMatch(/<@&123456>|<#123456>/);
  });

  it('custom template text keeps placeholder values literal (no re-expansion)', () => {
    expect(renderTemplate('{제목} {프로젝트}', { 제목: '{프로젝트}', 프로젝트: 'p' })).toBe('{프로젝트} p');
  });
});

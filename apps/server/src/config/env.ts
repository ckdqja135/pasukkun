import { createPrivateKey, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** 저장소 루트 (apps/server/{src|dist}/config → 4단계 위) */
export const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));
const int = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().min(min));
const optional = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(3000, 1),
  /** 브라우저가 접속하는 프론트 주소. Origin 검증과 알림 링크에 쓴다. */
  APP_ORIGIN: z.string().default('http://localhost:5273'),
  DATABASE_PATH: z.string().default('data/pasukkun.db'),
  /** 서비스 텔레그램 봇 토큰 (@BotFather). 이용자는 이 봇과 대화를 시작해 알림을 연결한다. */
  TELEGRAM_BOT_TOKEN: optional,
  /** 서비스 디스코드 봇 (Developer Portal 의 Bot Token, Application ID, Client Secret) */
  DISCORD_BOT_TOKEN: optional,
  DISCORD_CLIENT_ID: optional,
  DISCORD_CLIENT_SECRET: optional,
  /** 착착 커스텀 봇의 받는 주소. 이 주소로 보내면 그 봇이 초대된 채널에 글을 올린다. */
  CHAKCHAK_BOT_URL: optional,
  COOKIE_SECURE: optional,
  SESSION_TTL_DAYS: int(14, 1),
  /** GitHub OAuth App 의 Client ID / Secret. 로그인·가입은 GitHub 계정으로만 한다. */
  GITHUB_OAUTH_CLIENT_ID: optional,
  GITHUB_OAUTH_CLIENT_SECRET: optional,
  /** 로그인할 수 있는 GitHub 아이디 (쉼표 구분). 비우면 GitHub 계정이 있는 누구나 가입할 수 있다. */
  GITHUB_OAUTH_ALLOWED_USERS: optional,
  /** 앞단 프록시 단계 수. 기본 0: X-Forwarded-For 를 믿지 않는다. 프록시 뒤에 둘 때만 1 로 설정한다. */
  TRUST_PROXY: int(0),
  /** API 가 바인딩할 주소. 기본은 로컬 전용. 컨테이너 안에서는 0.0.0.0 */
  HOST: z.string().default('127.0.0.1'),
  /**
   * 서비스 GitHub 앱 (저장소 가져오기). 이용자는 앱을 설치하고 저장소를 고르기만 한다.
   * 개인 키는 파일로 둔다 (.pem, 소유자만 읽기).
   */
  GITHUB_APP_CLIENT_ID: optional,
  GITHUB_APP_CLIENT_SECRET: optional,
  GITHUB_APP_SLUG: optional,
  GITHUB_APP_PRIVATE_KEY_PATH: optional,
  /** 연결된 저장소의 lockfile 변경을 확인하는 주기 (분) */
  GITHUB_SYNC_MINUTES: int(360, 60),
  ANTHROPIC_API_KEY: optional,
  BRIEFING_AI_MODEL: optional,
  SWAGGER_ENABLED: optional,
  GITHUB_TOKEN: optional,
  NVD_API_KEY: optional,
  INITIAL_FEED_DAYS: int(90, 1),
  INGEST_GHSA_MINUTES: int(30, 5),
  INGEST_NVD_MINUTES: int(120, 120),
  INGEST_KEV_MINUTES: int(360, 30),
  INGEST_EPSS_MINUTES: int(1440, 360),
  INGEST_KISA_MINUTES: int(60, 30),
  RESCAN_MINUTES: int(1440, 60),
  EPSS_THRESHOLD: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? 0.1 : Number(value)))
    .pipe(z.number().min(0).max(1)),
  UPLOAD_MAX_BYTES: int(20 * 1024 * 1024, 1024),
  MAX_PACKAGES: int(50000, 1),
  NOTIFY_MAX_ATTEMPTS: int(6, 1),
  /** 외부 API 호출을 끄는 스위치 (테스트용) */
  DISABLE_INGESTION: bool(false),
});

export interface AppEnv {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  appOrigin: string;
  databasePath: string;
  telegramBotToken?: string;
  discord: { botToken: string; clientId: string; clientSecret: string } | null;
  chakchakBotUrl?: string;
  cookieSecure: boolean;
  sessionTtlDays: number;
  githubOAuth: { clientId: string; clientSecret: string } | null;
  githubApp: { clientId: string; clientSecret: string; slug: string; privateKey: KeyObject } | null;
  githubSyncMinutes: number;
  /** 보안 브리핑 AI 요약 (키가 없으면 꺼짐) */
  briefingAi: { apiKey: string; model: string } | null;
  /** 소문자 GitHub 아이디. 비어 있으면 제한 없음 */
  allowedGithubUsers: string[];
  trustProxy: number;
  swaggerEnabled: boolean;
  githubToken?: string;
  nvdApiKey?: string;
  initialFeedDays: number;
  intervals: { GHSA: number; NVD: number; KEV: number; EPSS: number; KISA: number; OSV: number };
  rescanMinutes: number;
  epssThreshold: number;
  uploadMaxBytes: number;
  maxPackages: number;
  notifyMaxAttempts: number;
  disableIngestion: boolean;
}

let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const envFile = process.env.ENV_FILE ?? resolve(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const parsed = schema.parse(process.env);
  const production = parsed.NODE_ENV === 'production';

  const databasePath = isAbsolute(parsed.DATABASE_PATH) ? parsed.DATABASE_PATH : resolve(REPO_ROOT, parsed.DATABASE_PATH);
  mkdirSync(dirname(databasePath), { recursive: true });

  const flag = (value: string | undefined, fallback: boolean) =>
    value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

  cached = {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    appOrigin: parsed.APP_ORIGIN.replace(/\/+$/, ''),
    databasePath,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    discord:
      parsed.DISCORD_BOT_TOKEN && parsed.DISCORD_CLIENT_ID && parsed.DISCORD_CLIENT_SECRET
        ? { botToken: parsed.DISCORD_BOT_TOKEN, clientId: parsed.DISCORD_CLIENT_ID, clientSecret: parsed.DISCORD_CLIENT_SECRET }
        : null,
    chakchakBotUrl: loadChakchakBotUrl(parsed.CHAKCHAK_BOT_URL),
    // NODE_ENV 설정을 잊어도 HTTPS 주소라면 Secure 쿠키를 쓴다.
    cookieSecure: flag(parsed.COOKIE_SECURE, production || parsed.APP_ORIGIN.startsWith('https://')),
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    githubOAuth:
      parsed.GITHUB_OAUTH_CLIENT_ID && parsed.GITHUB_OAUTH_CLIENT_SECRET
        ? { clientId: parsed.GITHUB_OAUTH_CLIENT_ID, clientSecret: parsed.GITHUB_OAUTH_CLIENT_SECRET }
        : null,
    githubApp: loadGithubApp(parsed),
    githubSyncMinutes: parsed.GITHUB_SYNC_MINUTES,
    briefingAi: parsed.ANTHROPIC_API_KEY ? { apiKey: parsed.ANTHROPIC_API_KEY, model: parsed.BRIEFING_AI_MODEL ?? 'claude-opus-5-5' } : null,
    allowedGithubUsers: (parsed.GITHUB_OAUTH_ALLOWED_USERS ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
    trustProxy: parsed.TRUST_PROXY,
    // API 문서는 명시적으로 켰을 때만 제공한다.
    swaggerEnabled: flag(parsed.SWAGGER_ENABLED, false),
    githubToken: parsed.GITHUB_TOKEN,
    nvdApiKey: parsed.NVD_API_KEY,
    initialFeedDays: parsed.INITIAL_FEED_DAYS,
    intervals: {
      GHSA: parsed.INGEST_GHSA_MINUTES,
      NVD: parsed.INGEST_NVD_MINUTES,
      KEV: parsed.INGEST_KEV_MINUTES,
      EPSS: parsed.INGEST_EPSS_MINUTES,
      KISA: parsed.INGEST_KISA_MINUTES,
      OSV: parsed.RESCAN_MINUTES,
    },
    rescanMinutes: parsed.RESCAN_MINUTES,
    epssThreshold: parsed.EPSS_THRESHOLD,
    uploadMaxBytes: parsed.UPLOAD_MAX_BYTES,
    maxPackages: parsed.MAX_PACKAGES,
    notifyMaxAttempts: parsed.NOTIFY_MAX_ATTEMPTS,
    disableIngestion: parsed.DISABLE_INGESTION,
  };
  return cached;
}

/** 착착에서 복사한 받는 주소만 받는다. 주소에 토큰이 들어 있으므로 오류에 값을 넣지 않는다. */
function loadChakchakBotUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/api\/hooks\/bot\/[0-9a-f]{48}$/.test(url.pathname)) {
    throw new Error('CHAKCHAK_BOT_URL 형식이 올바르지 않습니다. 착착 커스텀 봇의 [알림 받기]에서 복사한 받는 주소를 그대로 넣어 주세요.');
  }
  return url.toString();
}

function loadGithubApp(parsed: z.infer<typeof schema>): AppEnv['githubApp'] {
  const { GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_SLUG: slug, GITHUB_APP_PRIVATE_KEY_PATH: keyPath } = parsed;
  if (!clientId || !clientSecret || !slug || !keyPath) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug)) throw new Error('GITHUB_APP_SLUG 형식이 올바르지 않습니다 (GitHub 앱 주소의 마지막 부분).');
  const path = isAbsolute(keyPath) ? keyPath : resolve(REPO_ROOT, keyPath);
  try {
    return { clientId, clientSecret, slug, privateKey: createPrivateKey(readFileSync(path)) };
  } catch {
    // 키 내용은 메시지에 넣지 않는다.
    throw new Error(`GITHUB_APP_PRIVATE_KEY_PATH 의 개인 키를 읽을 수 없습니다. 파일 경로와 PEM 형식을 확인해 주세요: ${path}`);
  }
}

/** 테스트에서 환경을 바꿔 다시 읽을 때 사용 */
export function resetEnvCache(): void {
  cached = null;
}

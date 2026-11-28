/**
 * 기술 카탈로그 정의. 항목을 추가하면 다음 기동 때 DB 에 반영되고 기존 취약점도 다시 태깅된다.
 * 매핑은 패키지명·CPE·생태계로만 한다. 설명문 키워드로 관련성을 확정하지 않는다.
 *
 * pattern 끝의 `*` 는 접두 일치를 뜻한다.
 */
export type Group = 'LANGUAGE' | 'FRAMEWORK' | 'RUNTIME' | 'INFRA' | 'DATABASE';

export interface CatalogEntry {
  slug: string;
  name: string;
  group: Group;
  aliases?: string[];
  /** 설치 버전 정밀 검사 지원 여부. MVP 는 npm 생태계만 PRECISE. */
  scanSupport?: 'PRECISE' | 'FEED_ONLY';
  ecosystems?: string[];
  packages?: Array<[ecosystem: string, name: string]>;
  cpes?: string[];
}

export const CATALOG: CatalogEntry[] = [
  // - 언어: 언어와 패키지 생태계의 관계를 명시한다 -
  { slug: 'javascript', name: 'JavaScript', group: 'LANGUAGE', aliases: ['js'], scanSupport: 'PRECISE', ecosystems: ['npm'] },
  {
    slug: 'typescript',
    name: 'TypeScript',
    group: 'LANGUAGE',
    aliases: ['ts'],
    scanSupport: 'PRECISE',
    ecosystems: ['npm'],
    cpes: ['microsoft:typescript'],
  },
  { slug: 'java', name: 'Java', group: 'LANGUAGE', ecosystems: ['maven'] },
  { slug: 'go', name: 'Go', group: 'LANGUAGE', aliases: ['golang'], ecosystems: ['go'], cpes: ['golang:go'] },
  { slug: 'python', name: 'Python', group: 'LANGUAGE', ecosystems: ['pypi'], cpes: ['python:python'] },
  { slug: 'rust', name: 'Rust', group: 'LANGUAGE', ecosystems: ['crates.io'], cpes: ['rust-lang:rust'] },
  { slug: 'php', name: 'PHP', group: 'LANGUAGE', ecosystems: ['packagist'], cpes: ['php:php'] },
  { slug: 'ruby', name: 'Ruby', group: 'LANGUAGE', ecosystems: ['rubygems'], cpes: ['ruby-lang:ruby'] },
  { slug: 'csharp', name: 'C# / .NET', group: 'LANGUAGE', aliases: ['dotnet'], ecosystems: ['nuget'], cpes: ['microsoft:.net', 'microsoft:.net_core'] },

  // - 프레임워크 -
  {
    slug: 'react',
    name: 'React',
    group: 'FRAMEWORK',
    scanSupport: 'PRECISE',
    packages: [['npm', 'react'], ['npm', 'react-dom'], ['npm', 'react-server-dom-*'], ['npm', 'react-router'], ['npm', 'react-router-dom']],
    cpes: ['facebook:react'],
  },
  { slug: 'nextjs', name: 'Next.js', group: 'FRAMEWORK', scanSupport: 'PRECISE', packages: [['npm', 'next'], ['npm', '@next/*']], cpes: ['vercel:next.js'] },
  { slug: 'nestjs', name: 'NestJS', group: 'FRAMEWORK', scanSupport: 'PRECISE', packages: [['npm', '@nestjs/*']], cpes: ['nestjs:nest'] },
  { slug: 'express', name: 'Express', group: 'FRAMEWORK', scanSupport: 'PRECISE', packages: [['npm', 'express']], cpes: ['expressjs:express', 'openjsf:express'] },
  { slug: 'vue', name: 'Vue.js', group: 'FRAMEWORK', scanSupport: 'PRECISE', packages: [['npm', 'vue'], ['npm', '@vue/*'], ['npm', 'nuxt']], cpes: ['vuejs:vue', 'vuejs:vue.js'] },
  { slug: 'angular', name: 'Angular', group: 'FRAMEWORK', scanSupport: 'PRECISE', packages: [['npm', '@angular/*']], cpes: ['angular:angular'] },
  { slug: 'vite', name: 'Vite', group: 'FRAMEWORK', scanSupport: 'PRECISE', packages: [['npm', 'vite']], cpes: ['vitejs:vite'] },
  {
    slug: 'spring-boot',
    name: 'Spring Boot',
    group: 'FRAMEWORK',
    packages: [['maven', 'org.springframework.boot:*']],
    cpes: ['vmware:spring_boot'],
  },
  {
    slug: 'spring-framework',
    name: 'Spring Framework',
    group: 'FRAMEWORK',
    packages: [['maven', 'org.springframework:*'], ['maven', 'org.springframework.security:*']],
    cpes: ['vmware:spring_framework', 'vmware:spring_security', 'pivotal_software:spring_framework'],
  },
  { slug: 'django', name: 'Django', group: 'FRAMEWORK', packages: [['pypi', 'django']], cpes: ['djangoproject:django'] },
  { slug: 'flask', name: 'Flask', group: 'FRAMEWORK', packages: [['pypi', 'flask']], cpes: ['palletsprojects:flask'] },
  { slug: 'fastapi', name: 'FastAPI', group: 'FRAMEWORK', packages: [['pypi', 'fastapi'], ['pypi', 'starlette']], cpes: ['tiangolo:fastapi'] },

  // - 런타임: MVP 는 관련 공지 표시와 수동 검토만 지원한다 -
  { slug: 'nodejs', name: 'Node.js', group: 'RUNTIME', aliases: ['node'], cpes: ['nodejs:node.js'] },
  { slug: 'jdk', name: 'JDK / JRE', group: 'RUNTIME', aliases: ['openjdk'], cpes: ['oracle:jdk', 'oracle:jre', 'oracle:openjdk', 'oracle:java_se', 'oracle:graalvm*'] },
  { slug: 'deno', name: 'Deno', group: 'RUNTIME', packages: [['crates.io', 'deno'], ['crates.io', 'deno_*']], cpes: ['deno:deno'] },
  { slug: 'bun', name: 'Bun', group: 'RUNTIME', packages: [['npm', 'bun']], cpes: ['oven:bun', 'bun:bun'] },

  // - 인프라 / 개발환경 -
  { slug: 'linux', name: 'Linux', group: 'INFRA', cpes: ['linux:linux_kernel'] },
  { slug: 'windows', name: 'Windows', group: 'INFRA', cpes: ['microsoft:windows*'] },
  { slug: 'macos', name: 'macOS', group: 'INFRA', cpes: ['apple:macos', 'apple:mac_os_x'] },
  {
    slug: 'docker',
    name: 'Docker',
    group: 'INFRA',
    packages: [['go', 'github.com/docker/docker'], ['go', 'github.com/moby/moby'], ['go', 'github.com/docker/cli'], ['go', 'github.com/opencontainers/runc'], ['go', 'github.com/containerd/containerd*']],
    cpes: ['docker:*', 'mobyproject:moby', 'linuxfoundation:runc', 'linuxfoundation:containerd'],
  },
  { slug: 'kubernetes', name: 'Kubernetes', group: 'INFRA', aliases: ['k8s'], packages: [['go', 'k8s.io/*']], cpes: ['kubernetes:*'] },
  { slug: 'nginx', name: 'Nginx', group: 'INFRA', cpes: ['f5:nginx*', 'nginx:nginx'] },
  { slug: 'apache-httpd', name: 'Apache HTTP Server', group: 'INFRA', cpes: ['apache:http_server'] },
  { slug: 'openssl', name: 'OpenSSL', group: 'INFRA', cpes: ['openssl:openssl'] },
  { slug: 'git', name: 'Git', group: 'INFRA', cpes: ['git-scm:git', 'git:git'] },
  {
    slug: 'aws',
    name: 'AWS',
    group: 'INFRA',
    aliases: ['amazon web services', 'amazon'],
    packages: [
      ['npm', '@aws-sdk/*'],
      ['npm', '@aws/*'],
      ['npm', '@aws-cdk/*'],
      ['npm', '@aws-amplify/*'],
      ['npm', 'aws-sdk'],
      ['npm', 'aws-cdk*'],
      ['npm', 'aws-amplify'],
      ['pypi', 'boto3'],
      ['pypi', 'botocore'],
      ['pypi', 'awscli'],
      ['pypi', 'aws-*'],
      ['crates.io', 'aws-*'],
      ['go', 'github.com/aws/*'],
      ['go', 'github.com/awslabs/*'],
      ['maven', 'software.amazon.*'],
      ['maven', 'com.amazonaws:*'],
    ],
    cpes: ['amazon:*'],
  },

  // - 데이터베이스 -
  { slug: 'mysql', name: 'MySQL', group: 'DATABASE', cpes: ['oracle:mysql', 'oracle:mysql_server', 'mysql:mysql'] },
  { slug: 'postgresql', name: 'PostgreSQL', group: 'DATABASE', aliases: ['postgres'], cpes: ['postgresql:postgresql'] },
  { slug: 'mariadb', name: 'MariaDB', group: 'DATABASE', cpes: ['mariadb:mariadb'] },
  { slug: 'redis', name: 'Redis', group: 'DATABASE', cpes: ['redis:redis', 'redislabs:redis'] },
  { slug: 'mongodb', name: 'MongoDB', group: 'DATABASE', cpes: ['mongodb:mongodb'] },
  { slug: 'sqlite', name: 'SQLite', group: 'DATABASE', cpes: ['sqlite:sqlite'] },
  { slug: 'elasticsearch', name: 'Elasticsearch', group: 'DATABASE', cpes: ['elastic:elasticsearch'] },
];

/** 출처마다 다른 생태계 표기를 하나로 맞춘다. */
const ECOSYSTEM_ALIASES: Record<string, string> = {
  pip: 'pypi',
  rust: 'crates.io',
  composer: 'packagist',
  erlang: 'hex',
  actions: 'github-actions',
  'github actions': 'github-actions',
  swifturl: 'swift',
};

export function normalizeEcosystem(raw: string): string {
  const base = raw.split(':')[0].trim().toLowerCase();
  return ECOSYSTEM_ALIASES[base] ?? base;
}

/** npm 패키지명은 소문자다. 그 외 생태계는 원래 표기를 유지한다(대소문자 구분이 있을 수 있음). */
export function normalizePackageName(ecosystem: string, name: string): string {
  const trimmed = name.trim();
  return ecosystem === 'npm' || ecosystem === 'pypi' ? trimmed.toLowerCase() : trimmed;
}

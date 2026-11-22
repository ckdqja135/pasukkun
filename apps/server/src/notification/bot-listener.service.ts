import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { ChannelService } from './channel.service.js';
import { DiscordProvider } from './providers/discord.provider.js';
import { TelegramApiError, TelegramProvider } from './providers/telegram.provider.js';

const TELEGRAM_OFFSET = 'telegram.offset';
const DISCORD_IDENTIFIED = 'discord.identifiedAt';

/**
 * Worker 에서 서비스 봇을 돌본다.
 * - 텔레그램: 긴 폴링(getUpdates)으로 /start 연결 코드와 차단·추방 소식을 받는다. 서버 주소를 외부에 열 필요가 없다.
 * - 디스코드: 처음 한 번 게이트웨이에 접속해 둔다 (예전 문서의 "메시지 전 1회 접속" 조건 대비).
 */
@Injectable()
export class BotListener implements OnApplicationShutdown {
  private readonly logger = new Logger(BotListener.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramProvider,
    private readonly discord: DiscordProvider,
    private readonly channels: ChannelService,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.telegram.enabled()) void this.telegramLoop();
    if (this.discord.enabled()) void this.discordIdentify();
  }

  /** 텔레그램 업데이트를 한 번 받아 처리한다. 처리한 개수를 돌려준다. */
  async pollTelegramOnce(timeoutSeconds: number): Promise<number> {
    const saved = await this.prisma.appState.findUnique({ where: { key: TELEGRAM_OFFSET } });
    const offset = saved ? Number(saved.value) : 0;
    const updates = await this.telegram.getUpdates(offset, timeoutSeconds);
    for (const update of updates) {
      try {
        await this.channels.handleTelegramUpdate(update);
      } catch (error) {
        this.logger.warn(`텔레그램 업데이트 처리 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 처리한 업데이트는 다시 받지 않도록 바로 확인 처리한다.
      await this.prisma.appState.upsert({
        where: { key: TELEGRAM_OFFSET },
        update: { value: String(update.update_id + 1) },
        create: { key: TELEGRAM_OFFSET, value: String(update.update_id + 1) },
      });
    }
    return updates.length;
  }

  private async telegramLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        await this.pollTelegramOnce(25);
        failures = 0;
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TelegramApiError && error.status === 409) {
          this.logger.warn('다른 곳에서 같은 텔레그램 봇의 업데이트를 받고 있습니다 (웹훅 또는 다른 프로세스). 한 곳에서만 받도록 해 주세요.');
        } else if (failures === 1 || failures % 20 === 0) {
          this.logger.warn(`텔레그램 업데이트 수신 실패: ${message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2_000 * failures)));
      }
    }
  }

  private async discordIdentify(): Promise<void> {
    const done = await this.prisma.appState.findUnique({ where: { key: DISCORD_IDENTIFIED } });
    if (done) return;
    const ok = await this.discord.identifyOnce();
    if (ok) {
      await this.prisma.appState.upsert({ where: { key: DISCORD_IDENTIFIED }, update: { value: new Date().toISOString() }, create: { key: DISCORD_IDENTIFIED, value: new Date().toISOString() } });
      this.logger.log('디스코드 봇 게이트웨이 확인 완료');
    } else {
      this.logger.warn('디스코드 봇 게이트웨이에 접속하지 못했습니다. 봇 토큰을 확인해 주세요. (다음 시작 때 다시 시도합니다)');
    }
  }

  onApplicationShutdown(): void {
    this.running = false;
  }
}

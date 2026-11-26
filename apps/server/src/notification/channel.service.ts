import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { randomToken, sha256 } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { NotificationMessage } from './message.js';
import type {
  ChakchakChannelOptionDto,
  ChannelDto,
  ChannelLinkStatusDto,
  ChannelProvidersDto,
  ChannelTestResultDto,
  DiscordChannelOptionDto,
  DiscordLinkDto,
  TelegramLinkDto,
} from './notification.dto.js';
import { ChakchakApiError, ChakchakProvider } from './providers/chakchak.provider.js';
import { DiscordProvider } from './providers/discord.provider.js';
import type { NotificationProvider, SendResult } from './providers/provider.js';
import { TelegramProvider, type TelegramChat, type TelegramUpdate } from './providers/telegram.provider.js';

type ChannelRow = Prisma.NotificationChannelGetPayload<object>;
type LinkRow = Prisma.ChannelLinkRequestGetPayload<object>;

const LINK_TTL_MS = 15 * 60_000;
const MAX_LINKS_PER_HOUR = 10;
const MAX_CHANNELS = 20;
const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/;

export function toChannelDto(row: ChannelRow): ChannelDto {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    label: row.label,
    status: row.status,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 알림 채널 = 서비스 봇이 보낼 곳.
 * 이용자는 텔레그램에서 [시작]을 누르거나 디스코드에서 서버·채널을 골라 연결한다.
 * 연결 코드와 OAuth state 는 해시로만 저장하고 15분 뒤 만료된다.
 */
@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramProvider,
    private readonly discord: DiscordProvider,
    private readonly chakchak: ChakchakProvider,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  provider(type: string): NotificationProvider {
    if (type === 'TELEGRAM') return this.telegram as NotificationProvider;
    if (type === 'DISCORD') return this.discord as NotificationProvider;
    if (type === 'CHAKCHAK') return this.chakchak as NotificationProvider;
    throw new BadRequestException(`지원하지 않는 채널 유형입니다: ${type}`);
  }

  async providers(): Promise<ChannelProvidersDto> {
    return {
      telegram: this.telegram.enabled(),
      telegramBotUsername: this.telegram.enabled() ? await this.telegram.botUsername() : null,
      discord: this.discord.enabled(),
      chakchak: this.chakchak.enabled(),
    };
  }

  /** 기본 형식 또는 사용자 문구로 보낸다. 발송·테스트가 함께 쓴다. */
  async send(channel: Pick<ChannelRow, 'type' | 'target'>, message: NotificationMessage, customText: string | null): Promise<SendResult> {
    const provider = this.provider(channel.type);
    if (!provider.enabled()) {
      return { status: 'PERMANENT', error: '서버에 이 채널의 봇이 설정되어 있지 않습니다.', statusCode: null, channelBroken: false };
    }
    const payload = customText !== null ? provider.formatText(customText, message.tone) : provider.format(message);
    return provider.send(channel.target, payload);
  }

  private async findOwned(userId: string, channelId: string): Promise<ChannelRow> {
    const row = await this.prisma.notificationChannel.findFirst({ where: { id: channelId, userId } });
    if (!row) throw new NotFoundException('알림 채널을 찾을 수 없습니다.');
    return row;
  }

  async list(userId: string): Promise<ChannelDto[]> {
    const rows = await this.prisma.notificationChannel.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toChannelDto);
  }

  async rename(userId: string, channelId: string, name: string): Promise<ChannelDto> {
    await this.findOwned(userId, channelId);
    return toChannelDto(await this.prisma.notificationChannel.update({ where: { id: channelId }, data: { name: name.trim() } }));
  }

  async remove(userId: string, channelId: string): Promise<void> {
    await this.findOwned(userId, channelId);
    await this.prisma.notificationChannel.delete({ where: { id: channelId } });
  }

  async setPaused(userId: string, channelId: string, paused: boolean): Promise<ChannelDto> {
    await this.findOwned(userId, channelId);
    const updated = await this.prisma.notificationChannel.update({ where: { id: channelId }, data: { status: paused ? 'PAUSED' : 'ACTIVE' } });
    if (paused) {
      // 일시 중지한 채널로 나갈 예정이던 알림은 취소한다 (재개 후 한꺼번에 쏟아지지 않게).
      await this.prisma.notificationDelivery.updateMany({
        where: { channelId, status: { in: ['PENDING', 'RETRYING', 'HELD', 'DIGEST_PENDING'] } },
        data: { status: 'CANCELLED', lastError: '채널 일시 중지로 취소됨' },
      });
    }
    return toChannelDto(updated);
  }

  /** 테스트 메시지를 실제로 한 건 보낸다. 결과는 발송 이력에도 남는다. */
  async test(userId: string, channelId: string): Promise<ChannelTestResultDto> {
    const row = await this.findOwned(userId, channelId);
    const result = await this.send(row, this.testMessage(row.name), null);
    return this.recordTest(row, result);
  }

  private testMessage(name: string): NotificationMessage {
    return {
      heading: '연결 테스트',
      title: `"${name}" 채널로 알림을 받을 수 있습니다`,
      identifiers: [],
      lead: '이 메시지가 보이면 연결이 정상입니다.',
      fields: [],
      links: [],
      tone: 'info',
      footer: 'pasukkun',
    };
  }

  private async recordTest(row: ChannelRow, result: SendResult): Promise<ChannelTestResultDto> {
    const ok = result.status === 'SENT';
    const error = ok ? null : result.error;
    const now = new Date();
    const broken = result.status === 'PERMANENT' && result.channelBroken;
    const [updated, delivery] = await this.prisma.$transaction([
      this.prisma.notificationChannel.update({
        where: { id: row.id },
        data: ok
          ? { status: row.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE', lastSuccessAt: now, lastError: null, lastErrorAt: null }
          : { status: broken && row.status !== 'PAUSED' ? 'ERROR' : row.status, lastError: error, lastErrorAt: now },
      }),
      this.prisma.notificationDelivery.create({
        data: {
          userId: row.userId,
          channelId: row.id,
          kind: 'TEST',
          dedupeKey: `test:${row.id}:${randomToken(9)}`,
          status: ok ? 'SENT' : 'FAILED',
          attempts: 1,
          title: '연결 테스트',
          lastError: error,
          lastStatusCode: result.status === 'SENT' ? 200 : result.statusCode,
          providerMessageId: result.status === 'SENT' ? result.providerMessageId : null,
          sentAt: ok ? now : null,
        },
      }),
    ]);
    return { ok, message: ok ? '테스트 메시지를 보냈습니다.' : `전송 실패: ${error}`, channel: toChannelDto(updated), deliveryId: delivery.id };
  }

  // - 연결 공통 -

  private async assertChannelRoom(userId: string): Promise<void> {
    if ((await this.prisma.notificationChannel.count({ where: { userId } })) >= MAX_CHANNELS) {
      throw new BadRequestException(`알림 채널은 계정당 ${MAX_CHANNELS}개까지 연결할 수 있습니다.`);
    }
  }

  private async createLinkRequest(userId: string, type: 'TELEGRAM' | 'DISCORD', name: string): Promise<{ request: LinkRow; secret: string }> {
    await this.assertChannelRoom(userId);
    const recent = await this.prisma.channelLinkRequest.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= MAX_LINKS_PER_HOUR) throw new HttpException('연결 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', HttpStatus.TOO_MANY_REQUESTS);
    const secret = randomToken(24);
    const request = await this.prisma.channelLinkRequest.create({
      data: { userId, type, name: name.trim(), codeHash: sha256(secret), expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    });
    return { request, secret };
  }

  private async ownedLink(userId: string, requestId: string): Promise<LinkRow> {
    const request = await this.prisma.channelLinkRequest.findFirst({ where: { id: requestId, userId } });
    if (!request) throw new NotFoundException('연결 요청을 찾을 수 없습니다.');
    return request;
  }

  private expired(request: LinkRow): boolean {
    return request.expiresAt.getTime() < Date.now();
  }

  async linkStatus(userId: string, requestId: string): Promise<ChannelLinkStatusDto> {
    const request = await this.ownedLink(userId, requestId);
    const open = request.status === 'PENDING' || request.status === 'GUILD_SELECTED';
    return {
      requestId: request.id,
      type: request.type as ChannelLinkStatusDto['type'],
      status: (open && this.expired(request) ? 'EXPIRED' : request.status) as ChannelLinkStatusDto['status'],
      guildName: request.guildName,
      channelId: request.channelId,
      error: request.error,
    };
  }

  private async upsertChannel(userId: string, type: 'TELEGRAM' | 'DISCORD' | 'CHAKCHAK', match: (target: Record<string, unknown>) => boolean, data: { name: string; label: string; target: object }): Promise<ChannelRow> {
    const existing = (await this.prisma.notificationChannel.findMany({ where: { userId, type } })).find((row) => match((row.target ?? {}) as Record<string, unknown>));
    if (existing) {
      return this.prisma.notificationChannel.update({ where: { id: existing.id }, data: { ...data, status: 'ACTIVE', lastError: null, lastErrorAt: null } });
    }
    return this.prisma.notificationChannel.create({ data: { userId, type, ...data } });
  }

  // - 텔레그램 -

  async startTelegramLink(userId: string, name: string): Promise<TelegramLinkDto> {
    if (!this.telegram.enabled()) throw new BadRequestException('이 서버에는 텔레그램 봇이 설정되어 있지 않습니다.');
    const username = await this.telegram.botUsername();
    if (!username) throw new HttpException('텔레그램 봇 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', HttpStatus.SERVICE_UNAVAILABLE);
    const { request, secret } = await this.createLinkRequest(userId, 'TELEGRAM', name);
    return {
      requestId: request.id,
      url: `https://t.me/${username}?start=${secret}`,
      groupUrl: `https://t.me/${username}?startgroup=${secret}`,
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  /** Worker 가 텔레그램에서 받은 업데이트 하나를 처리한다. */
  async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message?.migrate_to_chat_id !== undefined) {
      await this.retargetTelegramChat(String(message.chat.id), String(message.migrate_to_chat_id));
    }
    const match = message?.text ? START_COMMAND.exec(message.text.trim()) : null;
    if (message && match) {
      if (match[1]) await this.completeTelegramLink(match[1], message.chat, message.from);
      else if (message.chat.type === 'private') {
        await this.replyTelegram(message.chat.id, 'pasukkun 화면의 [알림 설정] → [텔레그램 연결]에서 시작하면 이 대화방으로 알림을 받을 수 있습니다.');
      }
    }
    const membership = update.my_chat_member;
    if (membership) {
      const status = membership.new_chat_member?.status;
      const chatId = String(membership.chat.id);
      const channels = (await this.prisma.notificationChannel.findMany({ where: { type: 'TELEGRAM' } })).filter(
        (row) => String((row.target as { chatId?: unknown })?.chatId) === chatId,
      );
      if (status === 'kicked' || status === 'left') {
        for (const row of channels) {
          await this.prisma.notificationChannel.update({
            where: { id: row.id },
            data: { status: 'ERROR', lastError: '봇이 차단되었거나 대화방에서 내보내졌습니다. 다시 연결해 주세요.', lastErrorAt: new Date() },
          });
        }
      } else if (status === 'member' || status === 'administrator') {
        for (const row of channels.filter((channel) => channel.status === 'ERROR')) {
          await this.prisma.notificationChannel.update({ where: { id: row.id }, data: { status: 'ACTIVE', lastError: null, lastErrorAt: null } });
        }
      }
    }
  }

  private async completeTelegramLink(code: string, chat: TelegramChat, from?: { username?: string; first_name?: string }): Promise<void> {
    const request = await this.prisma.channelLinkRequest.findUnique({ where: { codeHash: sha256(code) } });
    if (!request || request.type !== 'TELEGRAM' || request.status !== 'PENDING' || this.expired(request)) {
      if (request && request.status === 'PENDING') await this.prisma.channelLinkRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } });
      await this.replyTelegram(chat.id, '연결 링크가 만료되었거나 이미 사용되었습니다. pasukkun 알림 설정에서 다시 시도해 주세요.');
      return;
    }
    const chatId = String(chat.id);
    const label =
      chat.type === 'private'
        ? `텔레그램 · ${from?.username ? `@${from.username}` : (chat.first_name ?? '개인 대화')}`
        : `텔레그램 · ${chat.title ?? '그룹'} (그룹)`;
    const channel = await this.upsertChannel(request.userId, 'TELEGRAM', (target) => String(target.chatId) === chatId, {
      name: request.name,
      label: label.slice(0, 120),
      target: { chatId, chatType: chat.type, title: chat.title ?? chat.first_name ?? null },
    });
    await this.prisma.channelLinkRequest.update({ where: { id: request.id }, data: { status: 'COMPLETED', channelId: channel.id } });
    await this.replyTelegram(chat.id, `pasukkun 알림이 연결되었습니다.\n이 대화방으로 "${request.name}" 알림을 보냅니다.`);
  }

  private async retargetTelegramChat(oldChatId: string, newChatId: string): Promise<void> {
    const channels = (await this.prisma.notificationChannel.findMany({ where: { type: 'TELEGRAM' } })).filter((row) => String((row.target as { chatId?: unknown })?.chatId) === oldChatId);
    for (const row of channels) {
      await this.prisma.notificationChannel.update({ where: { id: row.id }, data: { target: { ...(row.target as object), chatId: newChatId } } });
    }
  }

  private async replyTelegram(chatId: number, text: string): Promise<void> {
    const result = await this.telegram.send({ chatId: String(chatId) }, this.telegram.formatText(text, 'info'));
    if (result.status !== 'SENT') this.logger.warn(`텔레그램 안내 메시지 전송 실패: ${result.error}`);
  }

  // - 디스코드 -

  private get discordRedirectUri(): string {
    return `${this.env.appOrigin}/api/v1/channels/discord/callback`;
  }

  async startDiscordLink(userId: string, name: string): Promise<DiscordLinkDto> {
    if (!this.discord.enabled()) throw new BadRequestException('이 서버에는 디스코드 봇이 설정되어 있지 않습니다.');
    const { request, secret } = await this.createLinkRequest(userId, 'DISCORD', name);
    return { requestId: request.id, url: this.discord.authorizeUrl({ state: secret, redirectUri: this.discordRedirectUri }) };
  }

  /** 디스코드에서 돌아오는 곳. 프론트의 알림 설정 화면 주소를 돌려준다 (정해진 주소로만). */
  async discordCallback(user: AuthUser | undefined, query: { code?: unknown; state?: unknown; error?: unknown }): Promise<string> {
    const base = `${this.env.appOrigin}/notifications`;
    if (typeof query.state !== 'string' || query.state === '' || query.state.length > 100) return `${base}?discord_error=expired`;
    const request = await this.prisma.channelLinkRequest.findUnique({ where: { codeHash: sha256(query.state) } });
    if (!request || request.type !== 'DISCORD' || request.status !== 'PENDING' || this.expired(request)) return `${base}?discord_error=expired`;
    // 연결을 시작한 사람의 브라우저에서만 끝낼 수 있다.
    if (!user || user.id !== request.userId) return `${base}?discord_error=session`;
    if (query.error !== undefined) {
      await this.prisma.channelLinkRequest.update({ where: { id: request.id }, data: { status: 'FAILED', error: '디스코드에서 취소했습니다.' } });
      return `${base}?discord_error=denied`;
    }
    if (typeof query.code !== 'string' || query.code === '' || query.code.length > 200) return `${base}?discord_error=discord`;
    try {
      const guild = await this.discord.exchangeCode(query.code, this.discordRedirectUri);
      await this.prisma.channelLinkRequest.update({
        where: { id: request.id },
        data: { status: 'GUILD_SELECTED', guildId: guild.id, guildName: guild.name, expiresAt: new Date(Date.now() + LINK_TTL_MS) },
      });
      return `${base}?discord_link=${request.id}`;
    } catch (error) {
      await this.prisma.channelLinkRequest.update({ where: { id: request.id }, data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 200) : '디스코드 오류' } });
      return `${base}?discord_error=discord`;
    }
  }

  private async guildSelected(userId: string, requestId: string): Promise<LinkRow & { guildId: string }> {
    const request = await this.ownedLink(userId, requestId);
    if (request.type !== 'DISCORD' || request.status !== 'GUILD_SELECTED' || !request.guildId || this.expired(request)) {
      throw new BadRequestException('연결 요청이 만료되었습니다. 다시 시도해 주세요.');
    }
    return request as LinkRow & { guildId: string };
  }

  async listDiscordChannels(userId: string, requestId: string): Promise<DiscordChannelOptionDto[]> {
    const request = await this.guildSelected(userId, requestId);
    const channels = await this.discord.listTextChannels(request.guildId);
    return channels.map((channel) => ({ id: channel.id, name: channel.name }));
  }

  async completeDiscordLink(userId: string, requestId: string, channelId: string): Promise<ChannelDto> {
    const request = await this.guildSelected(userId, requestId);
    const info = await this.discord.getChannel(channelId);
    // 봇을 넣은 그 서버의 텍스트 채널인지 확인한다 (다른 서버의 채널로 보내게 할 수 없다).
    if (!info || info.guildId !== request.guildId || (info.type !== 0 && info.type !== 5)) {
      throw new BadRequestException('이 서버의 텍스트 채널이 아니거나 봇이 볼 수 없는 채널입니다.');
    }
    const result = await this.send({ type: 'DISCORD', target: { channelId: info.id } }, this.testMessage(request.name), null);
    if (result.status !== 'SENT') throw new BadRequestException(`채널에 메시지를 보내지 못했습니다: ${result.error}`);
    const channel = await this.upsertChannel(userId, 'DISCORD', (target) => target.channelId === info.id, {
      name: request.name,
      label: `디스코드 · ${request.guildName ?? '서버'} #${info.name}`.slice(0, 120),
      target: { guildId: request.guildId, guildName: request.guildName, channelId: info.id, channelName: info.name },
    });
    await this.prisma.channelLinkRequest.update({ where: { id: request.id }, data: { status: 'COMPLETED', channelId: channel.id } });
    await this.prisma.notificationChannel.update({ where: { id: channel.id }, data: { lastSuccessAt: new Date() } });
    return toChannelDto((await this.prisma.notificationChannel.findUniqueOrThrow({ where: { id: channel.id } })));
  }

  // - 착착 -

  /** 착착 봇이 들어가 있는 채널 목록 (연결할 채널 고르기) */
  async listChakchakChannels(): Promise<ChakchakChannelOptionDto[]> {
    if (!this.chakchak.enabled()) throw new BadRequestException('이 서버에는 착착 봇이 설정되어 있지 않습니다.');
    try {
      return await this.chakchak.listChannels();
    } catch (error) {
      throw new BadRequestException(error instanceof ChakchakApiError ? error.message : '착착에서 채널 목록을 가져오지 못했습니다.');
    }
  }

  /** 고른 채널에 확인 메시지를 올리고 연결한다. 봇이 들어가 있는 채널만 고를 수 있고, 채널마다 따로 연결한다. */
  async connectChakchak(userId: string, name: string, channelName: string): Promise<ChannelDto> {
    const available = await this.listChakchakChannels();
    if (!available.some((option) => option.name === channelName)) {
      throw new BadRequestException('봇이 들어가 있는 채널이 아닙니다. 착착에서 봇을 그 채널에 초대한 뒤 다시 시도해 주세요.');
    }
    const existing = (await this.prisma.notificationChannel.findMany({ where: { userId, type: 'CHAKCHAK' } })).some(
      (row) => (row.target as { channel?: unknown } | null)?.channel === channelName,
    );
    if (!existing) await this.assertChannelRoom(userId);
    const result = await this.send({ type: 'CHAKCHAK', target: { channel: channelName } }, this.testMessage(name.trim()), null);
    if (result.status !== 'SENT') throw new BadRequestException(`채널에 메시지를 보내지 못했습니다: ${result.error}`);
    const channel = await this.upsertChannel(userId, 'CHAKCHAK', (target) => target.channel === channelName, {
      name: name.trim(),
      label: `착착 · #${channelName}`.slice(0, 120),
      target: { channel: channelName },
    });
    return toChannelDto(await this.prisma.notificationChannel.update({ where: { id: channel.id }, data: { lastSuccessAt: new Date() } }));
  }

  /** 오래된 연결 요청 정리 */
  async purgeLinkRequests(olderThan: Date): Promise<void> {
    await this.prisma.channelLinkRequest.deleteMany({ where: { createdAt: { lt: olderThan } } });
  }
}

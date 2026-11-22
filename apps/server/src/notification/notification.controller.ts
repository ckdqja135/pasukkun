import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest, AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Public } from '../auth/decorators.js';
import { ChannelService } from './channel.service.js';
import { DeliveryService } from './delivery.service.js';
import {
  ChannelDto,
  ChannelLinkInputDto,
  ChannelLinkStatusDto,
  ChannelProvidersDto,
  ChannelTestResultDto,
  CompleteDiscordLinkDto,
  DeliveryDto,
  DeliveryListDto,
  DeliveryQueryDto,
  DiscordChannelOptionDto,
  DiscordLinkDto,
  RuleDto,
  RuleInputDto,
  TelegramLinkDto,
  TemplateInfoDto,
  TemplatePreviewDto,
  TemplatePreviewInputDto,
  UpdateChannelDto,
} from './notification.dto.js';
import { RuleService } from './rule.service.js';

@ApiTags('notifications')
@Controller()
export class NotificationController {
  constructor(
    private readonly channels: ChannelService,
    private readonly rules: RuleService,
    private readonly deliveries: DeliveryService,
  ) {}

  /** 이 서버에 설정된 서비스 봇 */
  @Get('channels/providers')
  providers(): Promise<ChannelProvidersDto> {
    return this.channels.providers();
  }

  @Get('channels')
  listChannels(@CurrentUser() user: AuthUser): Promise<ChannelDto[]> {
    return this.channels.list(user.id);
  }

  @Patch('channels/:id')
  renameChannel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateChannelDto): Promise<ChannelDto> {
    return this.channels.rename(user.id, id, dto.name);
  }

  @Delete('channels/:id')
  @HttpCode(204)
  async removeChannel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.channels.remove(user.id, id);
  }

  /** 테스트 메시지를 한 건 보낸다. */
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('channels/:id/test')
  @HttpCode(200)
  testChannel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ChannelTestResultDto> {
    return this.channels.test(user.id, id);
  }

  @Post('channels/:id/pause')
  @HttpCode(200)
  pauseChannel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ChannelDto> {
    return this.channels.setPaused(user.id, id, true);
  }

  @Post('channels/:id/resume')
  @HttpCode(200)
  resumeChannel(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ChannelDto> {
    return this.channels.setPaused(user.id, id, false);
  }

  /** 텔레그램 연결 시작: 서비스 봇과의 대화를 여는 링크를 만든다 (15분 유효). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('channels/telegram/link')
  startTelegram(@CurrentUser() user: AuthUser, @Body() dto: ChannelLinkInputDto): Promise<TelegramLinkDto> {
    return this.channels.startTelegramLink(user.id, dto.name);
  }

  /** 디스코드 연결 시작: 봇을 넣을 서버를 고르는 디스코드 화면 주소를 만든다 (15분 유효). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('channels/discord/link')
  startDiscord(@CurrentUser() user: AuthUser, @Body() dto: ChannelLinkInputDto): Promise<DiscordLinkDto> {
    return this.channels.startDiscordLink(user.id, dto.name);
  }

  /** 디스코드에서 돌아오는 곳. 알림 설정 화면으로 돌려보낸다. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  @Get('channels/discord/callback')
  async discordCallback(
    @Req() request: AuthedRequest,
    @Res() response: Response,
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
  ): Promise<void> {
    response.redirect(302, await this.channels.discordCallback(request.user, { code, state, error }));
  }

  @Get('channels/links/:id')
  linkStatus(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ChannelLinkStatusDto> {
    return this.channels.linkStatus(user.id, id);
  }

  /** 디스코드: 봇을 넣은 서버에서 알림 받을 수 있는 채널 목록 */
  @Get('channels/links/:id/discord-channels')
  discordChannels(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<DiscordChannelOptionDto[]> {
    return this.channels.listDiscordChannels(user.id, id);
  }

  /** 디스코드: 채널을 골라 연결을 끝낸다 (그 채널로 확인 메시지를 보낸다) */
  @Post('channels/links/:id/discord-complete')
  @HttpCode(200)
  completeDiscord(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CompleteDiscordLinkDto): Promise<ChannelDto> {
    return this.channels.completeDiscordLink(user.id, id, dto.channelId);
  }

  /** 쓸 수 있는 자리표시자와 기본 틀 */
  @Get('rules/template-info')
  templateInfo(): TemplateInfoDto {
    return this.rules.templateInfo();
  }

  @Post('rules/template-preview')
  @HttpCode(200)
  previewTemplate(@Body() dto: TemplatePreviewInputDto): TemplatePreviewDto {
    return this.rules.previewTemplate(dto);
  }

  @Get('rules')
  listRules(@CurrentUser() user: AuthUser): Promise<RuleDto[]> {
    return this.rules.list(user.id);
  }

  @Post('rules')
  createRule(@CurrentUser() user: AuthUser, @Body() dto: RuleInputDto): Promise<RuleDto> {
    return this.rules.create(user.id, dto);
  }

  @Put('rules/:id')
  updateRule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RuleInputDto): Promise<RuleDto> {
    return this.rules.update(user.id, id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  async removeRule(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.rules.remove(user.id, id);
  }

  @Get('deliveries')
  listDeliveries(@CurrentUser() user: AuthUser, @Query() query: DeliveryQueryDto): Promise<DeliveryListDto> {
    return this.deliveries.list(user.id, query);
  }

  @Get('deliveries/:id')
  getDelivery(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<DeliveryDto> {
    return this.deliveries.get(user.id, id);
  }
}

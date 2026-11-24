import { Module } from '@nestjs/common';
import { BotListener } from './bot-listener.service.js';
import { BriefingController } from './briefing.controller.js';
import { BriefingService } from './briefing.service.js';
import { ChannelService } from './channel.service.js';
import { DeliveryService } from './delivery.service.js';
import { MessageBuilder } from './message-builder.service.js';
import { NotificationController } from './notification.controller.js';
import { DiscordProvider } from './providers/discord.provider.js';
import { TelegramProvider } from './providers/telegram.provider.js';
import { RuleService } from './rule.service.js';

@Module({
  controllers: [NotificationController, BriefingController],
  providers: [BotListener, ChannelService, RuleService, DeliveryService, MessageBuilder, BriefingService, TelegramProvider, DiscordProvider],
  exports: [BotListener, ChannelService, DeliveryService, BriefingService, TelegramProvider, DiscordProvider],
})
export class NotificationModule {}

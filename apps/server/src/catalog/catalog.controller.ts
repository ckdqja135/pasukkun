import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { InterestsDto, SetInterestsDto, TechnologyDto } from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('technologies')
  async technologies(): Promise<TechnologyDto[]> {
    const rows = await this.catalog.listTechnologies();
    return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, group: row.group, scanSupport: row.scanSupport }));
  }

  /** 계정에 저장된 관심 기술. 화면의 임시 필터와는 별개다. */
  @Get('me/interests')
  async interests(@CurrentUser() user: AuthUser): Promise<InterestsDto> {
    return { technologyIds: await this.catalog.getInterests(user.id) };
  }

  @Put('me/interests')
  async setInterests(@CurrentUser() user: AuthUser, @Body() dto: SetInterestsDto): Promise<InterestsDto> {
    return { technologyIds: await this.catalog.setInterests(user.id, dto.technologyIds) };
  }
}

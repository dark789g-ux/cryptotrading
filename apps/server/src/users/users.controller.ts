import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthUserDto } from '../auth/dto/auth.dto';
import {
  CreateInvitationDto,
  CreateUserDto,
  PatchUserDto,
  ResetPasswordDto,
} from './dto/users.dto';
import { InvitationsService } from './invitations.service';
import { UsersService } from './users.service';

@AdminOnly()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly invitationsService: InvitationsService,
  ) {}

  @Get()
  list() {
    return this.usersService.list();
  }

  @Post()
  create(@Body() body: CreateUserDto) {
    return this.usersService.create(body);
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: PatchUserDto) {
    return this.usersService.patch(id, body);
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: ResetPasswordDto) {
    return this.usersService.resetPassword(id, body);
  }

  @Get('invitations')
  listInvitations() {
    return this.invitationsService.list();
  }

  @Post('invitations')
  createInvitation(@CurrentUser() user: AuthUserDto, @Body() body: CreateInvitationDto) {
    return this.invitationsService.create(body, user.id);
  }

  @Post('invitations/:id/revoke')
  revokeInvitation(@Param('id') id: string) {
    return this.invitationsService.revoke(id);
  }
}

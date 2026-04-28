import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { SESSION_COOKIE_NAME } from './auth.constants';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  AcceptInvitationDto,
  AuthUserDto,
  BootstrapDto,
  ChangePasswordDto,
  LoginDto,
} from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Get('bootstrap-status')
  bootstrapStatus() {
    return this.authService.bootstrapStatus();
  }

  @Public()
  @Post('bootstrap')
  bootstrap(@Body() body: BootstrapDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.bootstrap(body, req, res);
  }

  @Public()
  @Post('login')
  login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.login(body, req, res);
  }

  @Public()
  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.logout(req.cookies?.[SESSION_COOKIE_NAME], res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUserDto) {
    return this.authService.me(user);
  }

  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUserDto, @Body() body: ChangePasswordDto) {
    return this.authService.changePassword(user, body);
  }

  @Public()
  @Get('invitations/:token')
  invitationInfo(@Param('token') token: string) {
    return this.authService.invitationInfo(token);
  }

  @Public()
  @Post('invitations/:token/accept')
  acceptInvitation(
    @Param('token') token: string,
    @Body() body: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.acceptInvitation(token, body, req, res);
  }
}

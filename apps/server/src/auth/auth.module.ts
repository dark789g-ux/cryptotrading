import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { UserInvitationEntity } from '../users/entities/user-invitation.entity';
import { UserEntity } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AuthSessionEntity, UserEntity, UserInvitationEntity])],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [PasswordService, SessionService],
})
export class AuthModule {}

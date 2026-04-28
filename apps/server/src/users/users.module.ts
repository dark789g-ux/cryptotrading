import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { UserInvitationEntity } from './entities/user-invitation.entity';
import { UserEntity } from './entities/user.entity';
import { InvitationsService } from './invitations.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, UserInvitationEntity]), AuthModule],
  controllers: [UsersController],
  providers: [UsersService, InvitationsService],
})
export class UsersModule {}

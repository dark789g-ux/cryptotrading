import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserRole } from '../../auth/auth.types';
import { UserEntity } from './user.entity';

@Entity('user_invitations')
export class UserInvitationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', length: 20 })
  role: UserRole;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @Column({ name: 'created_by_user_id', type: 'varchar', length: 36 })
  createdByUserId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: UserEntity;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserRole } from '../../auth/auth.types';

@Entity('users')
export class UserEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash: string;

  @Column({ type: 'varchar', length: 20 })
  role: UserRole;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

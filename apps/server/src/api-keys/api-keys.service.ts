import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { API_KEY_PREFIX } from '../auth/shared/auth.constants';
import { generateToken, hashToken, toAuthUser } from '../auth/shared/auth.utils';
import { ApiKeyEntity } from '../entities/api-key/api-key.entity';
import { ApiKeyValidatedUser, ApiKeyView, CreatedApiKey } from './api-keys.types';

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly repo: Repository<ApiKeyEntity>,
  ) {}

  /**
   * Create a new API key. Returns the full plaintext key **once**.
   */
  async createKey(userId: string, name: string): Promise<CreatedApiKey> {
    const rawToken = generateToken();
    const fullKey = `${API_KEY_PREFIX}${rawToken}`;
    const keyPrefix = fullKey.slice(0, 16);

    const entity = this.repo.create({
      userId,
      name,
      keyHash: hashToken(fullKey),
      keyPrefix,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });

    const saved = await this.repo.save(entity);

    return {
      id: saved.id,
      name: saved.name,
      keyPrefix: saved.keyPrefix,
      plaintextKey: fullKey,
      createdAt: saved.createdAt.toISOString(),
    };
  }

  /**
   * List non-revoked API keys for the given user, ordered by creation date descending.
   */
  async listKeys(userId: string): Promise<ApiKeyView[]> {
    const keys = await this.repo.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
      expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
      createdAt: k.createdAt.toISOString(),
    }));
  }

  /**
   * Revoke (soft-delete) an API key by id, scoped to the given user.
   */
  async revokeKey(userId: string, id: string): Promise<void> {
    const key = await this.repo.findOneBy({ id, userId, revokedAt: IsNull() });
    if (!key) {
      throw new NotFoundException(`API Key ${id} not found`);
    }
    await this.repo.update(id, { revokedAt: new Date() });
  }

  /**
   * Validate a raw API key. Returns the authenticated user info if valid, or null.
   * Also fire-and-forget updates last_used_at with 60s throttling.
   */
  async validateKey(rawKey: string): Promise<ApiKeyValidatedUser | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) {
      return null;
    }

    const keyHash = hashToken(rawKey);
    const key = await this.repo.findOne({
      where: { keyHash, revokedAt: IsNull() },
      relations: ['user'],
    });

    if (!key) {
      return null;
    }

    // Check expiration
    if (key.expiresAt && key.expiresAt < new Date()) {
      return null;
    }

    // Check user is active
    if (!key.user.isActive) {
      return null;
    }

    // Throttled fire-and-forget update of last_used_at (60s)
    const now = Date.now();
    const lastMs = key.lastUsedAt ? key.lastUsedAt.getTime() : 0;
    if (now - lastMs >= 60_000) {
      void this.repo.update(key.id, { lastUsedAt: new Date(now) }).catch(() => {});
    }

    return toAuthUser(key.user);
  }
}

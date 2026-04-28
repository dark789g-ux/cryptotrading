import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const deriveKey = scrypt as (
  password: string,
  salt: string,
  keylen: number,
  options: typeof SCRYPT_PARAMS,
) => Promise<Buffer>;

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    this.assertPassword(password);
    const salt = randomBytes(16).toString('hex');
    const derived = await deriveKey(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
    return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${derived.toString('hex')}`;
  }

  async verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    if (!password || !passwordHash) {
      return false;
    }

    const [scheme, nRaw, rRaw, pRaw, salt, hashHex] = passwordHash.split('$');
    if (scheme !== 'scrypt' || !nRaw || !rRaw || !pRaw || !salt || !hashHex) {
      return false;
    }

    const expected = Buffer.from(hashHex, 'hex');
    const actual = await deriveKey(password, salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
    });

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  assertPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('密码至少需要 8 个字符');
    }
    if (password.length > 200) {
      throw new BadRequestException('密码过长');
    }
  }
}

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { FactorsController } from '../factors.controller';
import type { RequestWithUser } from '../../../../auth/shared/auth.types';

/**
 * FactorsController HTTP 层单测：
 *   - PATCH DTO 边界（pit_window_days / category / description maxLen / enabled type）
 *   - 路径参数缺失
 *   - 转发 req.user.id 到 service.update
 *
 * AdminGuard 自身的单测在 `apps/server/src/auth/__tests__/admin.guard.spec.ts`，
 * 这里不重复——controller 单测构造 mock service 即可。
 */
function req(userId: string | null): RequestWithUser {
  return {
    user: userId ? { id: userId, email: 'x@y.z', displayName: 'x', role: 'user' } : undefined,
    headers: {},
  } as RequestWithUser;
}

describe('FactorsController', () => {
  let svc: {
    listFactors: jest.Mock;
    listCategories: jest.Mock;
    update: jest.Mock;
  };
  let controller: FactorsController;

  beforeEach(() => {
    svc = {
      listFactors: jest.fn(async () => [{ factor_id: 'momentum_20d' }]),
      listCategories: jest.fn(async () => ['price', 'industry']),
      update: jest.fn(async (id, v, dto, uid) => ({
        factor_id: id,
        factor_version: v,
        updated_by: uid,
        ...dto,
      })),
    };
    controller = new FactorsController(svc as any);
  });

  describe('GET /quant/factors', () => {
    it('无 query → service.listFactors({})', async () => {
      const out = await controller.list({});
      expect(svc.listFactors).toHaveBeenCalledWith({});
      expect(out).toEqual({ items: [{ factor_id: 'momentum_20d' }] });
    });
    it('enabled=true（字符串）→ boolean true', async () => {
      await controller.list({ enabled: 'true' });
      expect(svc.listFactors).toHaveBeenCalledWith({ enabled: true });
    });
    it('enabled=0 → false', async () => {
      await controller.list({ enabled: '0' });
      expect(svc.listFactors).toHaveBeenCalledWith({ enabled: false });
    });
    it('enabled=garbage → 400', async () => {
      await expect(controller.list({ enabled: 'maybe' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
    it('category=price 透传', async () => {
      await controller.list({ category: 'price' });
      expect(svc.listFactors).toHaveBeenCalledWith({ category: 'price' });
    });
  });

  describe('GET /quant/factors/categories', () => {
    it('转发 → { items }', async () => {
      const out = await controller.listCategories();
      expect(out).toEqual({ items: ['price', 'industry'] });
    });
  });

  describe('PATCH /quant/factors/:id/:version', () => {
    it('happy path → svc.update 拿到 ValidatedUpdateFactor + user.id', async () => {
      const out = await controller.update(
        'momentum_20d',
        'v1',
        { description: '新描述', pit_window_days: 30, enabled: false },
        req('user-1'),
      );
      expect(svc.update).toHaveBeenCalledWith(
        'momentum_20d',
        'v1',
        expect.objectContaining({
          description: '新描述',
          pitWindowDays: 30,
          enabled: false,
        }),
        'user-1',
      );
      expect(out.item).toMatchObject({ factor_id: 'momentum_20d', updated_by: 'user-1' });
    });

    it('id 空 → 400', async () => {
      await expect(
        controller.update('', 'v1', { enabled: false }, req('u')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('version 空 → 400', async () => {
      await expect(
        controller.update('momentum_20d', '', { enabled: false }, req('u')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('未登录 → 401（防御兜底）', async () => {
      await expect(
        controller.update('momentum_20d', 'v1', { enabled: false }, req(null)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    describe('DTO 边界校验', () => {
      it('pit_window_days = 0 → 400', async () => {
        await expect(
          controller.update('m', 'v1', { pit_window_days: 0 }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('pit_window_days = 401 → 400', async () => {
        await expect(
          controller.update('m', 'v1', { pit_window_days: 401 }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('pit_window_days = 1 与 400 边界 → 通过', async () => {
        await controller.update('m', 'v1', { pit_window_days: 1 }, req('u'));
        await controller.update('m', 'v1', { pit_window_days: 400 }, req('u'));
        expect(svc.update).toHaveBeenCalledTimes(2);
      });
      it('category 非枚举 → 400', async () => {
        await expect(
          controller.update('m', 'v1', { category: 'foo' as any }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('description 长度 501 → 400', async () => {
        const long = 'a'.repeat(501);
        await expect(
          controller.update('m', 'v1', { description: long }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('description 长度 500 → 通过', async () => {
        const ok = 'a'.repeat(500);
        await controller.update('m', 'v1', { description: ok }, req('u'));
        expect(svc.update).toHaveBeenCalled();
      });
      it('enabled 非 boolean → 400', async () => {
        await expect(
          controller.update('m', 'v1', { enabled: 'yes' as any }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('pit_anchor 非枚举 → 400', async () => {
        await expect(
          controller.update('m', 'v1', { pit_anchor: 'today' as any }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('display_order = -1 → 400', async () => {
        await expect(
          controller.update('m', 'v1', { display_order: -1 }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('display_order = 9999 → 通过', async () => {
        await controller.update('m', 'v1', { display_order: 9999 }, req('u'));
        expect(svc.update).toHaveBeenCalled();
      });
      it('formula = null → 通过；formula 字符串过长 → 400', async () => {
        await controller.update('m', 'v1', { formula: null }, req('u'));
        await expect(
          controller.update('m', 'v1', { formula: 'a'.repeat(501) }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      it('data_source 非数组 → 400；null → 通过', async () => {
        await expect(
          controller.update('m', 'v1', { data_source: 'foo' as any }, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
        await controller.update('m', 'v1', { data_source: null }, req('u'));
        await controller.update('m', 'v1', { data_source: ['raw.daily_quote'] }, req('u'));
      });
      it('body 非对象 → 400', async () => {
        await expect(
          controller.update('m', 'v1', null as any, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          controller.update('m', 'v1', [] as any, req('u')),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });
});

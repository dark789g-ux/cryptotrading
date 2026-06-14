import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { QuantJobsController } from './quant-jobs.controller';
import type { RequestWithUser } from '../../../auth/shared/auth.types';

/**
 * QuantJobsController HTTP 层单测：happy path + 校验错误路径。
 * service 用最简 mock，验证调用形参 + 异常类型。
 */
describe('QuantJobsController', () => {
  let svc: {
    create: jest.Mock;
    findOne: jest.Mock;
    list: jest.Mock;
    cancel: jest.Mock;
    dispatch: jest.Mock;
    issueSseToken: jest.Mock;
  };
  let controller: QuantJobsController;

  const req = (userId: string | null): RequestWithUser =>
    ({
      user: userId ? { id: userId, email: 'x@y.z', displayName: 'x', role: 'user' } : undefined,
      headers: {},
    } as RequestWithUser);

  beforeEach(() => {
    svc = {
      create: jest.fn(async (dto, by) => ({ id: 'j1', runType: dto.runType, createdBy: by })),
      findOne: jest.fn(async (id) => ({ id })),
      list: jest.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 })),
      cancel: jest.fn(async (id) => ({ id, cancelRequested: true })),
      dispatch: jest.fn(async (id) => ({ jobId: id })),
      issueSseToken: jest.fn(async (id, uid) => ({ token: 'abc.def', expires_at: '2026-05-17 00:00:00Z', job_id: id })),
    };
    controller = new QuantJobsController(svc as any);
  });

  describe('POST /quant/jobs', () => {
    it('happy path：合法 body + 用户 → service.create 收到 ValidatedCreateJob + userId', async () => {
      const out = await controller.create(
        { run_type: 'noop', params: {}, priority: 100 },
        req('user-1'),
      );
      expect(svc.create).toHaveBeenCalledWith(
        expect.objectContaining({ runType: 'noop', params: {}, priority: 100, maxAttempts: 1 }),
        'user-1',
      );
      expect(out).toMatchObject({ id: 'j1', runType: 'noop' });
    });

    it('run_type 非法 → BadRequestException', async () => {
      await expect(
        controller.create({ run_type: 'evil_type', params: {} }, req('u')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('params 为数组 → BadRequestException', async () => {
      await expect(
        controller.create({ run_type: 'noop', params: [] as any }, req('u')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('未登录 → UnauthorizedException（防御层兜底）', async () => {
      await expect(
        controller.create({ run_type: 'noop' }, req(null)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('GET /quant/jobs', () => {
    it('合法 query → 调用 service.list with 校验后 dto', async () => {
      await controller.list({ status: 'running', run_type: 'train', page: '2', page_size: '15' });
      expect(svc.list).toHaveBeenCalledWith({
        status: 'running',
        runType: 'train',
        page: 2,
        pageSize: 15,
      });
    });
    it('未知 status → 400', () => {
      expect(() => controller.list({ status: 'weird' })).toThrow(BadRequestException);
    });
    it('未知 run_type → 400', () => {
      expect(() => controller.list({ run_type: 'evil' })).toThrow(BadRequestException);
    });
    it('page_size 超 200 → 400', () => {
      expect(() => controller.list({ page_size: '500' })).toThrow(BadRequestException);
    });
  });

  describe('GET /quant/jobs/:id', () => {
    it('id 必填', () => {
      expect(() => controller.findOne('' as any)).toThrow(BadRequestException);
    });
    it('转发到 service.findOne', async () => {
      const out = await controller.findOne('abc');
      expect(svc.findOne).toHaveBeenCalledWith('abc');
      expect(out).toEqual({ id: 'abc' });
    });
  });

  describe('POST /quant/jobs/:id/cancel', () => {
    it('转发到 service.cancel', async () => {
      const out = await controller.cancel('j1');
      expect(svc.cancel).toHaveBeenCalledWith('j1');
      expect(out).toEqual({ id: 'j1', cancelRequested: true });
    });
    it('id 空 → 400', () => {
      expect(() => controller.cancel('')).toThrow(BadRequestException);
    });
  });

  describe('POST /quant/jobs/:id/dispatch', () => {
    it('转发到 service.dispatch', async () => {
      const out = await controller.dispatch('jd');
      expect(svc.dispatch).toHaveBeenCalledWith('jd');
      expect(out).toEqual({ jobId: 'jd' });
    });
    it('id 空 → 400', () => {
      expect(() => controller.dispatch('')).toThrow(BadRequestException);
    });
  });

  describe('POST /quant/jobs/:id/sse-token', () => {
    it('转发 (id, user.id) → service.issueSseToken', async () => {
      const out = await controller.issueSseToken('j1', req('u-9'));
      expect(svc.issueSseToken).toHaveBeenCalledWith('j1', 'u-9');
      expect(out.token).toBe('abc.def');
    });
    it('未登录 → 401', () => {
      // controller.issueSseToken 是同步方法，在 svc 调用前同步抛错；用 toThrow 即可
      expect(() => controller.issueSseToken('j1', req(null))).toThrow(UnauthorizedException);
    });
    it('id 空 → 400', () => {
      expect(() => controller.issueSseToken('', req('u'))).toThrow(BadRequestException);
    });
  });
});

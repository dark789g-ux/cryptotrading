import { BadRequestException } from '@nestjs/common';
import { QuantRunsController } from './quant-runs.controller';

describe('QuantRunsController', () => {
  let svc: {
    list: jest.Mock;
    findOne: jest.Mock;
  };
  let controller: QuantRunsController;

  beforeEach(() => {
    svc = {
      list: jest.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 })),
      findOne: jest.fn(async (id) => ({ id })),
    };
    controller = new QuantRunsController(svc as any);
  });

  describe('GET /quant/runs', () => {
    it('happy path：合法 query → svc.list 收到 ValidatedRunQuery（sort_by 拆分为 field/dir）', async () => {
      await controller.list({
        model_version: 'lgb-v1-20260517',
        sort_by: 'created_at:ASC',
        page: '2',
        page_size: '15',
      });
      expect(svc.list).toHaveBeenCalledWith({
        modelVersion: 'lgb-v1-20260517',
        sortField: 'created_at',
        sortDir: 'ASC',
        page: 2,
        pageSize: 15,
      });
    });

    it('sort_by.field 不在白名单 → 400', () => {
      expect(() => controller.list({ sort_by: 'drop_table:ASC' })).toThrow(BadRequestException);
    });

    it('page_size 超 200 → 400', () => {
      expect(() => controller.list({ page_size: '500' })).toThrow(BadRequestException);
    });

    it('全空 query：dto 取默认值 { page:1, pageSize:20 }', async () => {
      await controller.list({});
      expect(svc.list).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    });
  });

  describe('GET /quant/runs/:id', () => {
    it('转发到 svc.findOne', async () => {
      const out = await controller.findOne('run-1');
      expect(svc.findOne).toHaveBeenCalledWith('run-1');
      expect(out).toEqual({ id: 'run-1' });
    });

    it('id 空 → 400', () => {
      expect(() => controller.findOne('')).toThrow(BadRequestException);
    });
  });
});

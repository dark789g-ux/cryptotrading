import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CustomIndexService } from './custom-index.service';
import { CustomIndexComputeService } from './custom-index-compute.service';
import { CustomIndexDefinitionEntity } from '../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexWeightVersionEntity } from '../../entities/custom-index/custom-index-weight-version.entity';
import { CustomIndexMemberEntity } from '../../entities/custom-index/custom-index-member.entity';
import { SseTokenService } from '../../modules/quant/services/sse-token.service';
import { PgListenService } from '../../modules/quant/realtime/pg-listen.service';
import {
  assertWeightSum,
  generateCustomIndexTsCode,
  membersEqual,
} from './custom-index.types';

describe('custom-index.types', () => {
  it('assertWeightSum 接受总和为 1', () => {
    expect(() => assertWeightSum([0.5, 0.5])).not.toThrow();
  });

  it('assertWeightSum 拒绝总和偏离 1', () => {
    expect(() => assertWeightSum([0.5, 0.4])).toThrow(/权重总和/);
  });

  it('generateCustomIndexTsCode 符合 CUST.{8hex}.U', () => {
    const code = generateCustomIndexTsCode();
    expect(code).toMatch(/^CUST\.[0-9a-f]{8}\.U$/);
  });

  it('membersEqual 忽略顺序', () => {
    const a = [{ conCode: '600519.SH', weight: '0.5' }, { conCode: '000858.SZ', weight: '0.5' }];
    const b = [{ conCode: '000858.SZ', weight: 0.5 }, { conCode: '600519.SH', weight: 0.5 }];
    expect(membersEqual(a, b)).toBe(true);
  });
});

describe('CustomIndexService', () => {
  let service: CustomIndexService;
  let definitionRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  let versionRepo: { findOne: jest.Mock };
  let memberRepo: { find: jest.Mock; findOne: jest.Mock };
  let computeService: { enqueue: jest.Mock; cancelLatestJob: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };

  const userA = 'user-a';
  const userB = 'user-b';
  const indexId = 'idx-1';

  const baseDef: CustomIndexDefinitionEntity = {
    id: indexId,
    userId: userA,
    tsCode: 'CUST.aabbccdd.U',
    name: '测试指数',
    description: null,
    indexType: 'price',
    baseDate: '20200102',
    basePoint: '1000',
    weightMethod: 'equal',
    status: 'ready',
    computeProgress: 100,
    computeStage: null,
    latestJobId: 'job-1',
    lastError: null,
    createdAt: new Date('2020-01-02T00:00:00Z'),
    updatedAt: new Date('2020-01-02T00:00:00Z'),
  };

  beforeEach(async () => {
    definitionRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (e) => e),
      delete: jest.fn(),
      update: jest.fn(),
    };
    versionRepo = {
      findOne: jest.fn(),
    };
    memberRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
    };
    computeService = {
      enqueue: jest.fn(async () => ({ id: 'job-new' })),
      cancelLatestJob: jest.fn(),
    };
    dataSource = {
      query: jest.fn(),
      transaction: jest.fn(async (cb) =>
        cb({
          create: (_: unknown, data: unknown) => data,
          save: async (_: unknown, data: unknown) =>
            Array.isArray(data)
              ? data.map((d, i) => ({ ...(d as object), id: String(i + 1) }))
              : { ...(data as object), id: indexId },
          update: jest.fn(),
          delete: jest.fn(),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomIndexService,
        { provide: getRepositoryToken(CustomIndexDefinitionEntity), useValue: definitionRepo },
        { provide: getRepositoryToken(CustomIndexWeightVersionEntity), useValue: versionRepo },
        { provide: getRepositoryToken(CustomIndexMemberEntity), useValue: memberRepo },
        { provide: CustomIndexComputeService, useValue: computeService },
        {
          provide: SseTokenService,
          useValue: {
            issueToken: jest.fn(() => ({
              token: 'tok',
              expiresAt: new Date('2030-01-01T00:00:00Z'),
            })),
          },
        },
        {
          provide: PgListenService,
          useValue: { events$: jest.fn(() => ({ subscribe: jest.fn() })) },
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    service = module.get(CustomIndexService);
  });

  describe('user 隔离', () => {
    it('getDetail 非本人指数抛 404', async () => {
      definitionRepo.findOne.mockResolvedValue(null);
      await expect(service.getDetail(userB, indexId)).rejects.toBeInstanceOf(NotFoundException);
      expect(definitionRepo.findOne).toHaveBeenCalledWith({ where: { id: indexId, userId: userB } });
    });

    it('remove 仅删除本人数据', async () => {
      definitionRepo.findOne.mockResolvedValue(baseDef);
      await service.remove(userA, indexId);
      expect(computeService.cancelLatestJob).toHaveBeenCalledWith(baseDef);
      expect(definitionRepo.delete).toHaveBeenCalledWith({ id: indexId, userId: userA });
    });
  });

  describe('create', () => {
    it('base_date 非交易日抛 422', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      await expect(
        service.create(userA, {
          name: '新指数',
          index_type: 'price',
          base_date: '20200101',
          base_point: 1000,
          weight_method: 'equal',
          effective_date: '20200102',
          members: [{ con_code: '600519.SH' }, { con_code: '000858.SZ' }],
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('equal 权重创建并入队 job', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ ok: 1 }]) // trade_cal
        .mockResolvedValueOnce([]); // loadStockNames (empty ok)

      const out = await service.create(userA, {
        name: '新指数',
        index_type: 'price',
        base_date: '20200102',
        base_point: 1000,
        weight_method: 'equal',
        effective_date: '20200102',
        members: [{ con_code: '600519.SH' }, { con_code: '000858.SZ' }],
      });

      expect(out.status).toBe('pending');
      expect(out.ts_code).toMatch(/^CUST\./);
      expect(computeService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: userA, fullRebuild: true }),
      );
    });

    it('custom 权重总和不对抛 400', async () => {
      dataSource.query.mockResolvedValueOnce([{ ok: 1 }]);
      await expect(
        service.create(userA, {
          name: '新指数',
          index_type: 'price',
          base_date: '20200102',
          weight_method: 'custom',
          effective_date: '20200102',
          members: [
            { con_code: '600519.SH', weight: 0.3 },
            { con_code: '000858.SZ', weight: 0.3 },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('computing 状态抛 409', async () => {
      definitionRepo.findOne.mockResolvedValue({ ...baseDef, status: 'computing' });
      await expect(service.update(userA, indexId, { name: '新名' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('仅改 name 不 enqueue', async () => {
      definitionRepo.findOne.mockResolvedValue({ ...baseDef });
      const out = await service.update(userA, indexId, { name: '新名' });
      expect(out.status).toBe('ready');
      expect(computeService.enqueue).not.toHaveBeenCalled();
    });

    it('成分无变化抛 400', async () => {
      definitionRepo.findOne.mockResolvedValue({ ...baseDef });
      versionRepo.findOne.mockResolvedValue({
        id: '1',
        customIndexId: indexId,
        effectiveDate: '20200102',
        expireDate: null,
        weightMethod: 'equal',
      });
      memberRepo.find.mockResolvedValue([
        { conCode: '600519.SH', weight: '0.5' },
        { conCode: '000858.SZ', weight: '0.5' },
      ]);
      dataSource.query.mockResolvedValueOnce([]);

      await expect(
        service.update(userA, indexId, {
          members: [{ con_code: '600519.SH' }, { con_code: '000858.SZ' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

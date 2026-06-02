import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FactorsService } from '../factors.service';
import { FactorVersionsController } from '../factor-versions.controller';
import { FactorDefinitionEntity } from '../../../../entities/ml/factor-definition.entity';

/**
 * factor-versions API 单测：
 *   - service.listFactorVersions：DISTINCT enabled、升序、空表返回 []
 *   - controller.list：包装为 { versions }
 *
 * spec 02-backend-passthrough.md#factor-versions-api。
 */

/** 构造可链式调用的 QueryBuilder mock；getRawMany 返回给定行。 */
function makeQb(rows: Array<{ factor_version: string }>) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(() => qb),
    where: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    getRawMany: jest.fn(async () => rows),
  };
  return qb;
}

describe('FactorsService.listFactorVersions', () => {
  let service: FactorsService;
  let repo: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        FactorsService,
        {
          provide: getRepositoryToken(FactorDefinitionEntity),
          useValue: { createQueryBuilder: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(FactorsService);
    repo = moduleRef.get(getRepositoryToken(FactorDefinitionEntity));
  });

  it('返回 DISTINCT factor_version（升序），并以 enabled=true 参数化过滤', async () => {
    const qb = makeQb([{ factor_version: 'v1' }, { factor_version: 'v2' }]);
    repo.createQueryBuilder.mockReturnValue(qb);

    const versions = await service.listFactorVersions();

    expect(versions).toEqual(['v1', 'v2']);
    expect(qb.select).toHaveBeenCalledWith('DISTINCT f.factor_version', 'factor_version');
    expect(qb.where).toHaveBeenCalledWith('f.enabled = :enabled', { enabled: true });
    expect(qb.orderBy).toHaveBeenCalledWith('factor_version', 'ASC');
  });

  it('空表返回 []（不报错）', async () => {
    const qb = makeQb([]);
    repo.createQueryBuilder.mockReturnValue(qb);

    await expect(service.listFactorVersions()).resolves.toEqual([]);
  });

  it('过滤掉非字符串 / 空字符串行', async () => {
    const qb = makeQb([
      { factor_version: 'v1' },
      { factor_version: '' },
      { factor_version: null as unknown as string },
    ]);
    repo.createQueryBuilder.mockReturnValue(qb);

    await expect(service.listFactorVersions()).resolves.toEqual(['v1']);
  });
});

describe('FactorVersionsController', () => {
  let controller: FactorVersionsController;
  let svc: { listFactorVersions: jest.Mock };

  beforeEach(async () => {
    svc = { listFactorVersions: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [FactorVersionsController],
      providers: [{ provide: FactorsService, useValue: svc }],
    }).compile();
    controller = moduleRef.get(FactorVersionsController);
  });

  it('list 包装 service 结果为 { versions }', async () => {
    svc.listFactorVersions.mockResolvedValue(['v1']);
    await expect(controller.list()).resolves.toEqual({ versions: ['v1'] });
    expect(svc.listFactorVersions).toHaveBeenCalledTimes(1);
  });

  it('list 空结果返回 { versions: [] }', async () => {
    svc.listFactorVersions.mockResolvedValue([]);
    await expect(controller.list()).resolves.toEqual({ versions: [] });
  });
});

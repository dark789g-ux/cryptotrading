import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreferenceEntity } from '../entities/user-preference.entity';
import {
  DEFAULT_SYMBOLS_VIEW_COLUMNS,
  PreferencesService,
  SYMBOLS_VIEW_PREFERENCES_KEY,
  normalizeSymbolsView,
} from './preferences.service';

describe('PreferencesService', () => {
  let service: PreferencesService;
  let repo: jest.Mocked<Repository<UserPreferenceEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferencesService,
        {
          provide: getRepositoryToken(UserPreferenceEntity),
          useValue: {
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(PreferencesService);
    repo = module.get(getRepositoryToken(UserPreferenceEntity));
  });

  it('returns defaults when no preference exists', async () => {
    repo.findOneBy.mockResolvedValueOnce(null);

    await expect(service.getSymbolsView('user-1')).resolves.toEqual(DEFAULT_SYMBOLS_VIEW_COLUMNS);
  });

  it('normalizes stored preference values when reading', async () => {
    repo.findOneBy.mockResolvedValueOnce({
      id: 'pref-1',
      userId: 'user-1',
      key: SYMBOLS_VIEW_PREFERENCES_KEY,
      value: {
        crypto: [
          { key: 'close', visible: false },
          { key: 'symbol', visible: false },
          { key: 'ghost', visible: true },
        ],
        aShares: [
          { key: 'name', visible: false },
          { key: 'tsCode', visible: false },
        ],
      },
    } as UserPreferenceEntity);

    const result = await service.getSymbolsView('user-1');

    expect(result.crypto).toEqual(
      expect.arrayContaining([
        { key: 'close', visible: false },
        { key: 'symbol', visible: true },
        { key: 'actions', visible: true },
      ]),
    );
    expect(result.crypto.some((item) => item.key === 'ghost')).toBe(false);
    expect(result.aShares.some((item) => item.key === 'tsCode' && item.visible === true)).toBe(true);
  });

  it('normalizes and stores preference values when saving', async () => {
    repo.findOneBy.mockResolvedValueOnce(null);
    repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
    repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

    const result = await service.saveSymbolsView('user-1', {
      crypto: [
        { key: 'close', visible: false },
        { key: 'symbol', visible: false },
        { key: 'ghost', visible: true },
      ],
      aShares: [
        { key: 'name', visible: false },
        { key: 'tsCode', visible: false },
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: expect.objectContaining({
          crypto: expect.arrayContaining([
            { key: 'close', visible: false },
            { key: 'symbol', visible: true },
          ]),
          aShares: expect.arrayContaining([{ key: 'tsCode', visible: true }]),
        }),
      }),
    );
  });
});

describe('normalizeSymbolsView', () => {
  it('drops unknown columns and keeps locked columns visible', () => {
    const result = normalizeSymbolsView({
      crypto: [
        { key: 'close', visible: false },
        { key: 'symbol', visible: false },
        { key: 'close', visible: true },
        { key: 'ghost', visible: true },
      ],
      aShares: [
        { key: 'name', visible: false },
        { key: 'tsCode', visible: false },
        { key: 'unknown', visible: true },
      ],
    });

    expect(result.crypto.some((item) => item.key === 'ghost')).toBe(false);
    expect(result.crypto.find((item) => item.key === 'symbol')).toEqual({ key: 'symbol', visible: true });
    expect(result.aShares.find((item) => item.key === 'tsCode')).toEqual({ key: 'tsCode', visible: true });
  });
});

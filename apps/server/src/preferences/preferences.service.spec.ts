import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreferenceEntity } from '../entities/config/user-preference.entity';
import {
  PreferencesService,
  SYMBOLS_VIEW_PREFERENCES_KEY,
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

  describe('getSymbolsView', () => {
    it('returns empty arrays when no preference exists', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual({
        crypto: [],
        aShares: [],
      });
    });

    it('returns stored data as-is', async () => {
      const stored = {
        crypto: [{ key: 'close', visible: false }],
        aShares: [
          { key: 'name', visible: true },
          { key: 'buySignal', visible: true },
          { key: 'actions', visible: true },
        ],
      };
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: stored,
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual(stored);
    });
  });

  describe('saveSymbolsView', () => {
    it('preserves unknown column keys and their order', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const input = {
        crypto: [],
        aShares: [
          { key: 'tsCode', visible: true },
          { key: 'name', visible: true },
          { key: 'tags', visible: true },
          { key: 'buySignal', visible: false },
          { key: 'actions', visible: true },
        ],
      };

      await service.saveSymbolsView('user-1', input);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ value: input }),
      );
    });

    it('filters out malformed items (missing key or visible)', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveSymbolsView('user-1', {
        crypto: [],
        aShares: [
          { key: 'name', visible: true },
          { key: '', visible: true },
          { visible: true },
          { key: 'actions' },
          null,
          { key: 'tsCode', visible: false },
        ],
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: {
            crypto: [],
            aShares: [
              { key: 'name', visible: true },
              { key: 'tsCode', visible: false },
            ],
          },
        }),
      );
    });

    it('updates existing preference record', async () => {
      const existing = {
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: { crypto: [], aShares: [] },
      } as UserPreferenceEntity;
      repo.findOneBy.mockResolvedValueOnce(existing);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const newValue = {
        crypto: [{ key: 'close', visible: false }],
        aShares: [{ key: 'tsCode', visible: true }],
      };

      await service.saveSymbolsView('user-1', newValue);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: newValue }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});

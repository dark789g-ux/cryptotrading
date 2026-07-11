import { RegimeBacktestAshareController } from './regime-backtest-ashare.controller';
import { RegimeBacktestController } from './regime-backtest.controller';
import { RegimeBacktestService } from './regime-backtest.service';
import { UpdateRegimeBacktestDto } from './dto/update-regime-backtest.dto';

describe('RegimeBacktest controllers PATCH wiring', () => {
  const dto = { name: 'x' } as UpdateRegimeBacktestDto;
  let service: { update: jest.Mock };

  beforeEach(() => {
    service = { update: jest.fn(async () => ({ id: 'run-1' })) };
  });

  it('ashare controller delegates PATCH to service.update', async () => {
    const ctrl = new RegimeBacktestAshareController(service as unknown as RegimeBacktestService);
    await ctrl.update('run-1', dto);
    expect(service.update).toHaveBeenCalledWith('run-1', dto);
  });

  it('legacy controller delegates PATCH to service.update', async () => {
    const ctrl = new RegimeBacktestController(service as unknown as RegimeBacktestService);
    await ctrl.update('run-1', dto);
    expect(service.update).toHaveBeenCalledWith('run-1', dto);
  });
});

import { IsString, IsNumber, IsEnum, IsOptional } from 'class-validator';

export class RunBacktestDto {
  @IsString()
  tsCode: string;

  @IsString()
  startDate: string;  // YYYYMMDD

  @IsString()
  endDate: string;

  @IsNumber()
  initialCapital: number;

  @IsEnum(['ma_cross'])
  strategy: 'ma_cross';

  @IsOptional()
  params?: {
    maShort?: number;  // 默认 5
    maLong?: number;   // 默认 20
  };
}

import { IsOptional, IsString, IsNumberString, IsEnum } from 'class-validator';

export class AdvancedFilterDto {
  @IsOptional()
  @IsString()
  indicator?: 'ma' | 'macd' | 'kdj' | 'rsi' | 'boll';

  // MA 条件
  @IsOptional()
  @IsNumberString()
  maShort?: string;  // 5, 10

  @IsOptional()
  @IsNumberString()
  maLong?: string;   // 20, 60

  @IsOptional()
  @IsEnum(['cross_up', 'cross_down', 'above', 'below'])
  maCondition?: 'cross_up' | 'cross_down' | 'above' | 'below';

  // MACD 条件
  @IsOptional()
  @IsEnum(['golden_cross', 'death_cross', 'above_zero', 'below_zero'])
  macdCondition?: 'golden_cross' | 'death_cross' | 'above_zero' | 'below_zero';

  // KDJ 条件
  @IsOptional()
  @IsEnum(['golden_cross', 'death_cross', 'overbought', 'oversold'])
  kdjCondition?: 'golden_cross' | 'death_cross' | 'overbought' | 'oversold';

  // RSI 条件
  @IsOptional()
  @IsNumberString()
  rsiPeriod?: string;  // 6, 12, 24

  @IsOptional()
  @IsEnum(['above', 'below'])
  rsiCompare?: 'above' | 'below';

  @IsOptional()
  @IsNumberString()
  rsiValue?: string;  // 30, 70

  // 布林带
  @IsOptional()
  @IsEnum(['touch_upper', 'touch_lower', 'break_upper', 'break_lower', 'squeeze'])
  bollCondition?: 'touch_upper' | 'touch_lower' | 'break_upper' | 'break_lower' | 'squeeze';

  @IsOptional()
  @IsString()
  tradeDate?: string;  // 筛选日期，默认最新
}

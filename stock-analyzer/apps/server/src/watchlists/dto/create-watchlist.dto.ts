import { IsString, IsOptional } from 'class-validator';

export class CreateWatchlistDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}

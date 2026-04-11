import { IsString, IsOptional } from 'class-validator';

export class AddItemDto {
  @IsString()
  tsCode: string;

  @IsOptional()
  @IsString()
  note?: string;
}

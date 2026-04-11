import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { WatchlistsService } from './watchlists.service';
import { CreateWatchlistDto } from './dto/create-watchlist.dto';
import { AddItemDto } from './dto/add-item.dto';

@Controller('watchlists')
export class WatchlistsController {
  constructor(private readonly watchlistsService: WatchlistsService) {}

  @Get()
  findAll() {
    return this.watchlistsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.watchlistsService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateWatchlistDto) {
    return this.watchlistsService.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: CreateWatchlistDto) {
    return this.watchlistsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.watchlistsService.remove(id);
  }

  @Post(':id/items')
  addItem(@Param('id') id: string, @Body() dto: AddItemDto) {
    return this.watchlistsService.addItem(id, dto);
  }

  @Delete(':id/items/:itemId')
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.watchlistsService.removeItem(itemId);
  }
}

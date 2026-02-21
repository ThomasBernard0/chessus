import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { LobbyModule } from '../lobby/lobby.module';

@Module({
  imports: [LobbyModule],
  providers: [GameGateway, GameService],
})
export class GameModule {}

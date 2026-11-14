import { PrismaModule } from '../prisma/prisma.module.js';
import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service.js';
import { TypegraphService } from './typegraph.service.js';

@Module({
  imports: [PrismaModule],
  providers: [EmbeddingsService, TypegraphService],
  exports: [EmbeddingsService, TypegraphService],
})
export class TypegraphModule {}

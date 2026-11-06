import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service.js';
import { TypegraphService } from './typegraph.service.js';

@Module({
  providers: [EmbeddingsService, TypegraphService],
  exports: [EmbeddingsService, TypegraphService],
})
export class TypegraphModule {}

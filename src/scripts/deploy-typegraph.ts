import 'dotenv/config';
import { Pool } from 'pg';
import { typegraphDeploy } from '@typegraph-ai/sdk';
import { EmbeddingsService } from '../typegraph/embeddings.service.js';
import { typegraphConfig } from '../typegraph/typegraph.config.js';
import { config } from '../config.js';

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await typegraphDeploy(typegraphConfig(pool, new EmbeddingsService()));
    console.log('TypeGraph schema deployed');
  } finally { await pool.end(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });

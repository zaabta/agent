import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { BackendTools } from '../src/agent/backend-tools.js';

async function main() {
  const userId = process.env.INSTALLATION_OWNER_USER_ID;
  const token = process.env.ATOMIC_ACCESS_TOKEN;

  if (!userId || !token) {
    throw new Error('Missing required configuration');
  }

  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const service = app.get(BackendTools);

    const existing = await service.listCustomTools();

    if (existing.some((tool: any) => tool.name === 'atomic_departments')) {
      console.log('Tool already exists');
      return;
    }

    await service.createCustomTool({
      name: 'atomic_departments',
      displayName: 'Atomic Departments',
      description: 'Search and list departments from Atomic Staging.',
      endpoint: 'https://stagingatomic.ictasnukleer.com.tr/api/v1/departments',
      parameters: [
        {
          name: 'search',
          type: 'string',
          queryParameter: 'q',
          required: false
        },
        {
          name: 'start',
          type: 'integer',
          queryParameter: '_start',
          required: false
        },
        {
          name: 'end',
          type: 'integer',
          queryParameter: '_end',
          required: false
        }
      ],
      auth: {
        headerName: 'Authorization',
        prefix: 'Bearer ',
        secret: token
      },
      timeoutMs: 10000,
      maxResponseBytes: 65536
    }, userId);

    console.log('atomic_departments created successfully');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error.name);
  process.exitCode = 1;
});

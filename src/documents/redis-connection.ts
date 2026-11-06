import { Redis } from 'ioredis';

export function redisConnection(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

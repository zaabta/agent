# Windows Prisma workflow

The Prisma 6.19 Windows query engine is loaded as `query_engine-windows.dll.node`. A running Nest process, tsx watcher, or document worker can keep that DLL mapped; Prisma Client generation then fails when it tries to replace the engine file (`EPERM` on rename).

Before changing `schema.prisma` and generating a client:

1. Stop the SitePilot API and document worker from their owning terminals (`Ctrl+C`). Do not stop unrelated Node processes.
2. Run `pnpm prisma:generate:safe`. It lists matching SitePilot processes and refuses to proceed while they are running; it never kills a process.
3. Run `pnpm prisma:validate`, `pnpm prisma:migrate:status`, and `pnpm build`.
4. Restart the API and worker after generation.

If Windows process inspection is restricted, the safe script fails closed and asks you to stop the project processes manually before running `pnpm prisma:generate`.

import { randomUUID } from 'node:crypto';

export type AgentRunState = 'starting' | 'running' | 'finalizing' | 'cancelling' | 'completed' | 'cancelled' | 'failed';

export interface AgentRunOwner {
  userId: string;
  tenantId: string;
}

export interface AgentRunHandle {
  readonly runId: string;
  readonly ownerId: string;
  readonly tenantId: string;
  conversationId?: string;
  state: AgentRunState;
  readonly startedAtMs: number;
  cancelRequestedAtMs?: number;
  readonly controller: AbortController;
  cancelRequested: boolean;
  finishedAtMs?: number;
  settle(): void;
  settled: Promise<void>;
}

export class AgentRunCapacityError extends Error {
  readonly code = 'AGENT_CONCURRENCY_LIMIT';
  constructor() {
    super('The agent is handling its maximum number of active requests. Try again shortly.');
    this.name = 'AgentRunCapacityError';
  }
}

export interface AgentRunCancellationResult {
  runId: string;
  status: 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'finishing';
  cancellationRequested: boolean;
  executionSettled: boolean;
  providerStopConfirmed: false;
  ackLatencyMs: number;
}

/** Process-local, bounded run coordination. No prompt, token, or tool data is retained. */
export class ActiveAgentRunRegistry {
  private readonly runs = new Map<string, AgentRunHandle>();
  constructor(
    private readonly maxActive = 48,
    private readonly maxPerUser = 2,
    private readonly maxEntries = 256,
    private readonly terminalTtlMs = 120_000,
    private readonly cancellationWaitMs = 1_500,
  ) {}

  create(owner: AgentRunOwner): AgentRunHandle {
    this.prune();
    const active = [...this.runs.values()].filter(run => this.isActive(run.state));
    if (active.length >= this.maxActive || active.filter(run => run.ownerId === owner.userId).length >= this.maxPerUser) {
      throw new AgentRunCapacityError();
    }
    while (this.runs.size >= this.maxEntries) {
      const oldest = [...this.runs.values()].filter(run => !this.isActive(run.state)).sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0))[0];
      if (!oldest) throw new AgentRunCapacityError();
      this.runs.delete(oldest.runId);
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    const run: AgentRunHandle = {
      runId: randomUUID(), ownerId: owner.userId, tenantId: owner.tenantId, state: 'starting',
      startedAtMs: Date.now(), controller: new AbortController(), cancelRequested: false,
      settled,
      settle: () => {
        if (run.finishedAtMs !== undefined) return;
        run.finishedAtMs = Date.now();
        resolveSettled();
      },
    };
    this.runs.set(run.runId, run);
    return run;
  }

  bindConversation(runId: string, conversationId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.conversationId = conversationId;
    if (run.state === 'starting') run.state = 'running';
  }

  beginFinalization(runId: string, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('AGENT_RUN_CANCELLED');
    const run = this.runs.get(runId);
    if (run && run.state === 'running') run.state = 'finalizing';
  }

  finish(runId: string, state: Extract<AgentRunState, 'completed' | 'cancelled' | 'failed'>) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.state = state;
    run.settle();
    this.prune();
  }

  getOwned(runId: string, owner: AgentRunOwner): AgentRunHandle | undefined {
    this.prune();
    const run = this.runs.get(runId);
    if (!run || run.ownerId !== owner.userId || run.tenantId !== owner.tenantId) return undefined;
    return run;
  }

  async cancel(run: AgentRunHandle): Promise<AgentRunCancellationResult> {
    const startedAt = Date.now();
    if (run.state === 'completed' || run.state === 'cancelled' || run.state === 'failed') {
      return { runId: run.runId, status: run.state, cancellationRequested: false, executionSettled: true, providerStopConfirmed: false, ackLatencyMs: Date.now() - startedAt };
    }
    if (run.state === 'finalizing') {
      return { runId: run.runId, status: 'finishing', cancellationRequested: false, executionSettled: false, providerStopConfirmed: false, ackLatencyMs: Date.now() - startedAt };
    }
    if (!run.cancelRequested) {
      run.cancelRequested = true;
      run.cancelRequestedAtMs = Date.now();
      run.state = 'cancelling';
      run.controller.abort(new Error('AGENT_RUN_CANCELLED'));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      run.settled.then(() => true),
      new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), this.cancellationWaitMs); timeout.unref?.(); }),
    ]);
    if (timeout) clearTimeout(timeout);
    return {
      runId: run.runId,
      status: settled ? run.state as AgentRunCancellationResult['status'] : 'cancelling',
      cancellationRequested: true,
      executionSettled: settled,
      providerStopConfirmed: false,
      ackLatencyMs: Date.now() - startedAt,
    };
  }

  async shutdown(waitMs = 1_500) {
    const active = [...this.runs.values()].filter(run => this.isActive(run.state));
    for (const run of active) {
      if (!run.controller.signal.aborted) {
        run.state = 'cancelling';
        run.controller.abort(new Error('API_SHUTDOWN'));
      }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(active.map(run => run.settled)),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, waitMs); timeout.unref?.(); }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  private isActive(state: AgentRunState) {
    return state === 'starting' || state === 'running' || state === 'finalizing' || state === 'cancelling';
  }

  private prune() {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (!this.isActive(run.state) && run.finishedAtMs !== undefined && now - run.finishedAtMs > this.terminalTtlMs) this.runs.delete(id);
    }
  }
}

export class AgentRunCancelledError extends Error {
  constructor(readonly runId: string, readonly ackLatencyMs: number) {
    super('AGENT_RUN_CANCELLED');
    this.name = 'AgentRunCancelledError';
  }
}

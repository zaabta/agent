import type { AuthPrincipal } from '../auth/auth.types.js';

/** Phase 1 registration contract for future Atomic read-only integrations. */
export interface AtomicToolRegistration<Input = unknown, Output = unknown> {
  readonly id: `atomic_${string}`;
  readonly description: string;
  readonly readOnly: true;
  readonly inputSchema: { parse(value: unknown): Input };
  authorize(principal: AuthPrincipal): Promise<boolean> | boolean;
  execute(input: Input, principal: AuthPrincipal, signal: AbortSignal): Promise<Output>;
}

/** Runtime guard: no dynamically supplied write capability is accepted. */
export function assertReadOnlyAtomicTool(tool: AtomicToolRegistration): void {
  if (!tool.id.startsWith('atomic_') || tool.readOnly !== true) {
    throw new Error('ATOMIC_TOOL_REGISTRATION_REJECTED');
  }
}

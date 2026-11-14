import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthPrincipal } from '../auth/auth.types.js';

export const backendCallSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  args: z.record(z.string(), z.unknown()),
});

// OpenRouter's NVIDIA Nemotron structured-output implementation rejects the
// `propertyNames` keyword emitted by z.record(). Keep this transport schema
// separate from backendCallSchema, which remains the runtime validator.
export const backendCallLLMSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  args: z.object({}).catchall(z.unknown()),
});

type ReadTool = {
  id: string;
  description: string;
  inputSchema: object;
  authorize: (principal: AuthPrincipal) => boolean;
  execute: (args: unknown, principal: AuthPrincipal, signal: AbortSignal) => Promise<string>;
};

@Injectable()
export class BackendTools {
  private readonly tools = new Map<string, ReadTool>();

  register<T extends z.ZodType>(tool: Omit<ReadTool, 'inputSchema' | 'execute'> & {
    input: T;
    execute: (args: z.output<T>, principal: AuthPrincipal, signal: AbortSignal) => Promise<string>;
  }) {
    backendCallSchema.shape.id.parse(tool.id);
    const description = z.string().trim().min(1).max(300).parse(tool.description);
    if (this.tools.has(tool.id) || this.tools.size >= 16) throw new Error('BACKEND_TOOL_REGISTRATION_REJECTED');
    const inputSchema = z.toJSONSchema(tool.input);
    if (JSON.stringify(inputSchema).length > 2000) throw new Error('BACKEND_TOOL_SCHEMA_TOO_LARGE');
    this.tools.set(tool.id, {
      id: tool.id, authorize: tool.authorize, description, inputSchema,
      execute: (args, principal, signal) => tool.execute(tool.input.parse(args), principal, signal),
    });
  }

  catalog(principal: AuthPrincipal) {
    return [...this.tools.values()].filter(tool => tool.authorize(principal)).map(tool => ({
      id: tool.id, description: tool.description, input: tool.inputSchema,
    }));
  }

  async execute(call: z.infer<typeof backendCallSchema>, principal: AuthPrincipal, parentSignal?: AbortSignal, onStart?: () => Promise<void>) {
    const tool = this.tools.get(call.id);
    if (!tool || !tool.authorize(principal)) return undefined;
    const timeout = AbortSignal.timeout(15_000);
    const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
    signal.throwIfAborted();
    if (JSON.stringify(call.args).length > 4000) throw new Error('BACKEND_TOOL_ARGUMENTS_TOO_LARGE');
    await onStart?.();
    signal.throwIfAborted();
    let stop: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
      });
      const output = await Promise.race([tool.execute(call.args, principal, signal), aborted]);
      return z.string().min(1).max(8000).parse(output);
    } finally {
      if (stop) signal.removeEventListener('abort', stop);
    }
  }
}

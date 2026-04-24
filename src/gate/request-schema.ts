import { z } from 'zod';

export const GateRequestSchema = z.object({
  agent_id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  action_type: z.enum(['sign', 'call', 'register_tool', 'invoke_tool']),
  payload: z.object({
    to: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    data: z.string().regex(/^0x[a-fA-F0-9]*$/).optional(),
    value: z.string().optional(),
    gas_limit: z.number().int().positive().max(30_000_000).optional(),
    gas_price: z.string().optional(),
    nonce: z.number().int().nonnegative().optional(),
    value_usd: z.number().nonnegative().optional(),
    wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    tool_name: z.string().max(128).optional(),
    tool_schema: z.object({}).passthrough().optional(),
    tool_endpoint: z.string().url().optional(),
    tool_params: z.record(z.unknown()).optional(),
    session_id: z.string().max(128).optional(),
  }).strict(),
}).strict();

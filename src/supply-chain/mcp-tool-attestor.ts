import type { Alert } from '../types.js';

/**
 * Tier 3 stub: MCP tool bundle attestation.
 *
 * Will verify MCP tool bundles pulled at runtime against
 * attestation manifests to prevent supply chain injection
 * through AI tool extensions.
 *
 * Not implemented until N > 5 builders.
 */

export interface MCPToolAttestResult {
  verified: boolean;
  alerts: Alert[];
}

export function attestMCPTool(
  _toolName: string,
  _bundlePath: string,
): MCPToolAttestResult {
  throw new Error('MCPToolAttestor is a Tier 3 feature — not yet implemented');
}

import type { Alert } from '../types.js';

/**
 * Tier 3 stub: CLI binary integrity verification.
 *
 * Will verify integrity of CLI binaries (bw, gh, npm, Orderly CLIs)
 * by comparing against known-good hashes from a trusted manifest.
 *
 * Not implemented until N > 5 builders.
 */

export interface BinaryVerifyResult {
  verified: boolean;
  alerts: Alert[];
}

export function verifyBinary(
  _binaryPath: string,
  _expectedHash: string,
): BinaryVerifyResult {
  throw new Error('BinaryVerifier is a Tier 3 feature — not yet implemented');
}

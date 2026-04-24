import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

interface NonceState {
  expected_nonce: number;
  last_confirmed_nonce: number;
  last_updated: string;
  hmac?: string;
}

const NONCE_SIGNING_KEY = process.env.SECCLAW_NONCE_SIGNING_KEY ?? process.env.SECCLAW_MANIFEST_SIGNING_KEY;

export class NonceTracker {
  private state: NonceState;
  private persistPath: string;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.state = this.load();
  }

  validate(nonce: number | undefined): { valid: boolean; expected: number; actual: number | undefined } {
    if (nonce === undefined) {
      return { valid: true, expected: this.state.expected_nonce, actual: undefined };
    }
    return {
      valid: nonce === this.state.expected_nonce,
      expected: this.state.expected_nonce,
      actual: nonce,
    };
  }

  confirmTransaction(nonce: number): void {
    this.state.last_confirmed_nonce = nonce;
    this.state.expected_nonce = nonce + 1;
    this.state.last_updated = new Date().toISOString();
    this.persist();
  }

  syncWithOnChain(onChainNonce: number): void {
    if (onChainNonce > this.state.expected_nonce) {
      this.state.expected_nonce = onChainNonce;
      this.state.last_updated = new Date().toISOString();
      this.persist();
    }
  }

  getExpectedNonce(): number {
    return this.state.expected_nonce;
  }

  private computeHMAC(state: NonceState): string {
    if (!NONCE_SIGNING_KEY) return '';
    const data = `${state.expected_nonce}:${state.last_confirmed_nonce}:${state.last_updated}`;
    return createHmac('sha256', NONCE_SIGNING_KEY).update(data).digest('hex');
  }

  private verifyHMAC(state: NonceState): boolean {
    if (!NONCE_SIGNING_KEY) return true;
    if (!state.hmac) return false;
    const expected = this.computeHMAC(state);
    if (expected.length !== state.hmac.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(state.hmac));
  }

  // Hardcoded invariant #8: nonce state HMAC failure does NOT fall back to zero
  private load(): NonceState {
    if (existsSync(this.persistPath)) {
      try {
        const content = readFileSync(this.persistPath, 'utf-8');
        const parsed = JSON.parse(content) as NonceState;
        if (NONCE_SIGNING_KEY && !this.verifyHMAC(parsed)) {
          throw new Error(
            `Nonce state HMAC verification failed at ${this.persistPath} — possible tampering. ` +
            'Refusing to start. Do NOT fall back to nonce 0.',
          );
        }
        return parsed;
      } catch (err) {
        if (err instanceof Error && err.message.includes('HMAC verification failed')) {
          throw err;
        }
        if (NONCE_SIGNING_KEY) {
          throw new Error(
            `Nonce state file at ${this.persistPath} is corrupted and signing key is set. ` +
            'Refusing to start with nonce 0.',
          );
        }
      }
    }
    return { expected_nonce: 0, last_confirmed_nonce: -1, last_updated: new Date().toISOString() };
  }

  private persist(): void {
    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const state = { ...this.state };
    state.hmac = this.computeHMAC(state);
    const tmpPath = this.persistPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmpPath, this.persistPath);
  }
}

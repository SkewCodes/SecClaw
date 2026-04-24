import type { TokenBucketRateLimiter } from './rate-limiter.js';
import type { NonceTracker } from './nonce-tracker.js';
import type { CumulativeExposureTracker } from './exposure-tracker.js';
import type { CooldownTracker } from './cooldown-tracker.js';
import type { AccelerationDetector } from './acceleration.js';
import type { TargetSwitchDetector } from './target-switch.js';
import type { SignerModificationManager } from './modification-mgr.js';
import type { TransactionDeduplicator } from '../transaction-dedup.js';
import type { GasPriceMonitor } from '../gas-monitor.js';

export interface SignerHealthContext {
  rateLimiter: TokenBucketRateLimiter;
  nonceTracker: NonceTracker;
  exposureTracker: CumulativeExposureTracker;
  cooldownTracker: CooldownTracker;
  accelerationDetector: AccelerationDetector;
  targetSwitchDetector: TargetSwitchDetector;
  modificationManager: SignerModificationManager;
  transactionDedup: TransactionDeduplicator;
  gasPriceMonitor: GasPriceMonitor;
  cachedBalanceEth: number | null;
  balanceCacheUpdatedAt: number;
  walletAddress: string | null;
}

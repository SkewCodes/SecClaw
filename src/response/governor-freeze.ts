import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Alert, AlertHandler } from '../types.js';

/**
 * Auto-response: on critical governance alerts, call
 * GovernanceSecOversight.freezeGovernor() from the SecClaw Council member
 * key. The on-chain freeze is one-way (members freeze, guardians unfreeze)
 * so the Council retains the recovery lever.
 *
 * Configuration via env:
 *   SECCLAW_OZ_OVERSIGHT       — GovernanceSecOversight address on Orderly Chain
 *   SECCLAW_COUNCIL_MEMBER_KEY — privileged key (member of OZCouncil)
 *   SECCLAW_ORDERLY_CHAIN_RPC  — RPC URL for Orderly Chain
 *   SECCLAW_OZ_CHAIN_ID        — 291 (mainnet) or 4460 (sepolia)
 */
export class GovernorFreezeHandler implements AlertHandler {
  private oversightAddress?: Address;
  private memberKey?: Hex;
  private rpcUrl?: string;
  private chainId: number;
  private freezeOnCritical: boolean;
  private alreadyFrozen = new Set<string>();

  constructor(opts: {
    oversightAddress?: string;
    memberKey?: string;
    rpcUrl?: string;
    chainId?: number;
    freezeOnCritical?: boolean;
  }) {
    this.oversightAddress = opts.oversightAddress as Address | undefined;
    this.memberKey = opts.memberKey as Hex | undefined;
    this.rpcUrl = opts.rpcUrl;
    this.chainId = opts.chainId ?? 291;
    this.freezeOnCritical = opts.freezeOnCritical ?? true;
  }

  async handle(alert: Alert): Promise<void> {
    if (!this.freezeOnCritical) return;
    if (alert.severity !== 'critical') return;
    if (alert.source !== 'governance') return;
    if (!this.oversightAddress || !this.memberKey || !this.rpcUrl) return;

    const governor = alert.data?.['governor'] as string | undefined;
    if (!governor) return;
    const govLower = governor.toLowerCase();
    if (this.alreadyFrozen.has(govLower)) return;

    const triggers = ['proposer_balance_surge', 'bond_slashing_proposed', 'proposal_whale_dominance'];
    if (!triggers.includes(alert.check)) return;

    try {
      const chain = defineChain({
        id: this.chainId,
        name: this.chainId === 4460 ? 'Orderly Sepolia' : 'Orderly',
        nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
        rpcUrls: { default: { http: [this.rpcUrl] } },
      });
      const account = privateKeyToAccount(this.memberKey);
      const walletClient = createWalletClient({ account, chain, transport: http(this.rpcUrl) });
      const publicClient = createPublicClient({ chain, transport: http(this.rpcUrl) });

      const abi = parseAbi(['function freezeGovernor(address governor)']);
      const hash = await walletClient.writeContract({
        address: this.oversightAddress,
        abi,
        functionName: 'freezeGovernor',
        args: [governor as Address],
      });
      console.log(`[secclaw] governor-freeze: ${governor} freeze tx ${hash}`);
      this.alreadyFrozen.add(govLower);

      // Best-effort wait (advisory).
      try {
        await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      } catch { /* advisory */ }
    } catch (err) {
      console.error(
        `[secclaw] governor-freeze failed for ${governor}: ${(err as Error).message}`,
      );
    }
  }
}

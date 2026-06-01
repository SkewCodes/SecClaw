import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Alert, AlertHandler } from '../types.js';

/**
 * Auto-response: surgical block of a specific governance action by hash.
 * Cheaper than freezing the whole governor — only the flagged proposal's
 * action becomes un-executable; legitimate proposals through the same
 * governor still go through.
 *
 * Trigger: warning-severity governance alerts where alert.data carries
 * { governor, target, selector, data } so we can compute the action hash.
 */
export class ActionBlockHandler implements AlertHandler {
  private oversightAddress?: Address;
  private memberKey?: Hex;
  private rpcUrl?: string;
  private chainId: number;
  private blockOnWarning: boolean;
  private alreadyBlocked = new Set<string>();

  constructor(opts: {
    oversightAddress?: string;
    memberKey?: string;
    rpcUrl?: string;
    chainId?: number;
    blockOnWarning?: boolean;
  }) {
    this.oversightAddress = opts.oversightAddress as Address | undefined;
    this.memberKey = opts.memberKey as Hex | undefined;
    this.rpcUrl = opts.rpcUrl;
    this.chainId = opts.chainId ?? 291;
    this.blockOnWarning = opts.blockOnWarning ?? false;
  }

  async handle(alert: Alert): Promise<void> {
    if (!this.blockOnWarning) return;
    if (alert.severity !== 'warning') return;
    if (alert.source !== 'governance') return;
    if (!this.oversightAddress || !this.memberKey || !this.rpcUrl) return;

    const governor = alert.data?.['governor'] as string | undefined;
    const target = alert.data?.['target'] as string | undefined;
    const selector = alert.data?.['selector'] as string | undefined;
    const data = (alert.data?.['data'] as string | undefined) ?? selector;
    if (!governor || !target || !selector || !data) return;

    const actionHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'address' },
          { type: 'bytes4' },
          { type: 'bytes' },
        ],
        [
          governor as `0x${string}`,
          target as `0x${string}`,
          selector as `0x${string}`,
          data as `0x${string}`,
        ],
      ),
    );
    if (this.alreadyBlocked.has(actionHash)) return;

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

      const abi = parseAbi(['function setBlockedActionHash(bytes32 actionHash, bool isBlocked)']);
      const hash = await walletClient.writeContract({
        address: this.oversightAddress,
        abi,
        functionName: 'setBlockedActionHash',
        args: [actionHash, true],
      });
      console.log(`[secclaw] action-block: ${actionHash} block tx ${hash}`);
      this.alreadyBlocked.add(actionHash);

      try {
        await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      } catch { /* advisory */ }
    } catch (err) {
      console.error(
        `[secclaw] action-block failed: ${(err as Error).message}`,
      );
    }
  }
}

import { createPublicClient, http, formatEther, type PublicClient, type Address } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import type { SignerHealthContext } from './context.js';

let balanceClient: PublicClient | null = null;
let balanceClientNetwork: string | null = null;

export function getBalanceClient(network: string): PublicClient {
  if (balanceClient && balanceClientNetwork === network) return balanceClient;
  const chain = network === 'mainnet' ? arbitrum : arbitrumSepolia;
  const rpcUrl = process.env.SECCLAW_RPC_URL;
  balanceClient = createPublicClient({
    chain,
    transport: http(rpcUrl || undefined),
  });
  balanceClientNetwork = network;
  return balanceClient;
}

export async function refreshSignerBalances(
  network: string,
  registry: Map<string, SignerHealthContext>,
): Promise<void> {
  const client = getBalanceClient(network);
  for (const [, ctx] of registry) {
    if (!ctx.walletAddress) continue;
    try {
      const raw = await client.getBalance({ address: ctx.walletAddress as Address });
      ctx.cachedBalanceEth = parseFloat(formatEther(raw));
      ctx.balanceCacheUpdatedAt = Date.now();
    } catch {
      // Non-fatal: balance cache remains stale; check will skip if null
    }
  }
}

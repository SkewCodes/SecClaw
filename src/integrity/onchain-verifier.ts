import { createPublicClient, http, type PublicClient, type Address, parseAbi } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { createAlert } from '../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../types.js';

// Orderly Vault contract ABI — the subset we need for verification
const VAULT_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);

let cachedClient: PublicClient | null = null;
let cachedNetwork: string | null = null;

function getClient(network: string): PublicClient {
  if (cachedClient && cachedNetwork === network) return cachedClient;

  const chain = network === 'mainnet' ? arbitrum : arbitrumSepolia;
  const rpcUrl = process.env.SECCLAW_RPC_URL;

  cachedClient = createPublicClient({
    chain,
    transport: http(rpcUrl || undefined),
  });
  cachedNetwork = network;
  return cachedClient;
}

export async function verifyOnChainState(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
  vaultDecimals = 6,
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // ─── Self-consistency checks (no RPC needed) ─────────────────

  if (snapshot.yieldclaw.ok && snapshot.yieldclaw.data?.sharePrice) {
    const sp = snapshot.yieldclaw.data.sharePrice;

    // Share price vs AUM/shares ratio
    if (sp.total_shares > 0 && sp.aum > 0) {
      const computedPrice = sp.aum / sp.total_shares;
      const reportedPrice = sp.share_price;
      const drift = Math.abs(computedPrice - reportedPrice) / computedPrice * 100;

      if (drift > manifest.yieldclaw.nav_drift_tolerance_pct) {
        alerts.push(createAlert('onchain', 'share_price_internal_inconsistency', 'critical',
          `Share price ${reportedPrice.toFixed(6)} inconsistent with AUM/shares = ${computedPrice.toFixed(6)} (drift: ${drift.toFixed(2)}%)`,
          { reportedPrice, computedPrice, aum: sp.aum, totalShares: sp.total_shares, drift },
        ));
      }
    }

    // NAV vs AUM divergence
    if (sp.nav > 0 && sp.aum > 0) {
      const navAumDrift = Math.abs(sp.nav - sp.aum) / sp.aum * 100;
      if (navAumDrift > 5) {
        alerts.push(createAlert('onchain', 'nav_aum_divergence', 'high',
          `NAV ($${sp.nav.toFixed(2)}) diverges from AUM ($${sp.aum.toFixed(2)}) by ${navAumDrift.toFixed(2)}%`,
          { nav: sp.nav, aum: sp.aum, divergencePct: navAumDrift },
        ));
      }
    }
  }

  // ─── Guardian policy vs manifest drift ───────────────────────

  if (snapshot.yieldclaw.ok && snapshot.yieldclaw.data?.guardianPolicy) {
    const gp = snapshot.yieldclaw.data.guardianPolicy;
    const mp = manifest.payment_layer;

    if (gp.trading.maxLeverage > mp.trading.max_leverage) {
      alerts.push(createAlert('onchain', 'guardian_leverage_permissive', 'high',
        `Guardian allows ${gp.trading.maxLeverage}x leverage but manifest limits to ${mp.trading.max_leverage}x`,
        { guardian: gp.trading.maxLeverage, manifest: mp.trading.max_leverage },
      ));
    }

    if (gp.trading.maxPositionSizeUSD > mp.trading.max_position_size_usd) {
      alerts.push(createAlert('onchain', 'guardian_position_size_permissive', 'high',
        `Guardian allows $${gp.trading.maxPositionSizeUSD} positions but manifest limits to $${mp.trading.max_position_size_usd}`,
        { guardian: gp.trading.maxPositionSizeUSD, manifest: mp.trading.max_position_size_usd },
      ));
    }

    if (gp.spending.dailyLimitUSD > mp.spending.daily_limit_usd) {
      alerts.push(createAlert('onchain', 'guardian_spending_permissive', 'high',
        `Guardian daily spending $${gp.spending.dailyLimitUSD} exceeds manifest $${mp.spending.daily_limit_usd}`,
        { guardian: gp.spending.dailyLimitUSD, manifest: mp.spending.daily_limit_usd },
      ));
    }

    for (const sym of gp.trading.allowedSymbols) {
      if (!mp.trading.allowed_symbols.includes(sym)) {
        alerts.push(createAlert('onchain', 'guardian_symbol_not_in_manifest', 'warning',
          `Guardian allows symbol ${sym} not listed in manifest`,
          { symbol: sym, manifestSymbols: mp.trading.allowed_symbols },
        ));
      }
    }
  }

  // ─── On-chain contract reads (requires RPC + vault address) ──

  const vaultAddress = process.env.SECCLAW_VAULT_CONTRACT as Address | undefined;
  if (vaultAddress && snapshot.yieldclaw.ok && snapshot.yieldclaw.data?.sharePrice) {
    try {
      const onchainAlerts = await verifyVaultOnChain(
        manifest.global.network,
        vaultAddress,
        snapshot.yieldclaw.data.sharePrice,
        manifest.yieldclaw.nav_drift_tolerance_pct,
        vaultDecimals,
      );
      alerts.push(...onchainAlerts);
    } catch (err) {
      alerts.push(createAlert('onchain', 'rpc_verification_failed', 'warning',
        `On-chain verification failed: ${(err as Error).message}`,
        { error: (err as Error).message },
      ));
    }
  }

  return alerts;
}

async function verifyVaultOnChain(
  network: string,
  vaultAddress: Address,
  reportedSharePrice: {
    share_price: number;
    total_shares: number;
    nav: number;
    aum: number;
  },
  driftTolerancePct: number,
  decimals: number,
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const client = getClient(network);

  const [totalSupply, totalAssets] = await Promise.all([
    client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'totalSupply',
    }),
    client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'totalAssets',
    }),
  ]);

  const onchainTotalShares = Number(totalSupply) / 10 ** decimals;
  const onchainTotalAssets = Number(totalAssets) / 10 ** decimals;

  // Verify total shares
  if (onchainTotalShares > 0 && reportedSharePrice.total_shares > 0) {
    const sharesDrift = Math.abs(onchainTotalShares - reportedSharePrice.total_shares) / onchainTotalShares * 100;
    if (sharesDrift > driftTolerancePct) {
      alerts.push(createAlert('onchain', 'total_shares_mismatch', 'critical',
        `On-chain total shares ${onchainTotalShares.toFixed(2)} vs reported ${reportedSharePrice.total_shares.toFixed(2)} (drift: ${sharesDrift.toFixed(2)}%)`,
        { onchain: onchainTotalShares, reported: reportedSharePrice.total_shares, driftPct: sharesDrift },
      ));
    }
  }

  // Verify total assets (AUM)
  if (onchainTotalAssets > 0 && reportedSharePrice.aum > 0) {
    const aumDrift = Math.abs(onchainTotalAssets - reportedSharePrice.aum) / onchainTotalAssets * 100;
    if (aumDrift > driftTolerancePct) {
      alerts.push(createAlert('onchain', 'total_assets_mismatch', 'critical',
        `On-chain total assets $${onchainTotalAssets.toFixed(2)} vs reported AUM $${reportedSharePrice.aum.toFixed(2)} (drift: ${aumDrift.toFixed(2)}%)`,
        { onchain: onchainTotalAssets, reported: reportedSharePrice.aum, driftPct: aumDrift },
      ));
    }
  }

  // Verify computed share price
  if (onchainTotalShares > 0 && onchainTotalAssets > 0) {
    const onchainSharePrice = onchainTotalAssets / onchainTotalShares;
    const priceDrift = Math.abs(onchainSharePrice - reportedSharePrice.share_price) / onchainSharePrice * 100;

    if (priceDrift > driftTolerancePct) {
      alerts.push(createAlert('onchain', 'share_price_onchain_mismatch', 'critical',
        `On-chain share price $${onchainSharePrice.toFixed(6)} vs reported $${reportedSharePrice.share_price.toFixed(6)} (drift: ${priceDrift.toFixed(2)}%)`,
        { onchain: onchainSharePrice, reported: reportedSharePrice.share_price, driftPct: priceDrift },
      ));
    }
  }

  return alerts;
}

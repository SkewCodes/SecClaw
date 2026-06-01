import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type PublicClient,
  type Address,
  type Log,
} from 'viem';
import { defineChain } from 'viem';
import type {
  ProbeResult,
  GovernanceSnapshot,
  ProposalSnapshot,
  BondSnapshot,
  OversightSnapshot,
  ProposalState,
  VoteEvent,
  GovernancePolicy,
} from '../types.js';

// Orderly Chain (OP Stack app-chain) — defined inline since not in viem/chains.
const orderlyChain = defineChain({
  id: 291,
  name: 'Orderly',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: { default: { http: ['https://rpc.orderly.network'] } },
});

const orderlySepolia = defineChain({
  id: 4460,
  name: 'Orderly Sepolia',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: { default: { http: ['https://l2-orderly-l2-4460-sepolia-8tc3sd7dvy.t.conduit.xyz'] } },
});

// ─── ABIs (parsed once at module load) ───────────────────────

const GOVERNOR_EVENT_ABI = parseAbi([
  'event ProposalCreated(uint256 indexed proposalId,address indexed proposer,address target,bytes data,uint256 value,uint64 voteStartBlock,uint64 voteEndBlock,bytes32 descriptionHash)',
  'event VoteCast(uint256 indexed proposalId,address indexed voter,uint8 support,uint256 weight)',
  'event ProposalQueued(uint256 indexed proposalId,bytes32 timelockOpId)',
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event ProposalCancelled(uint256 indexed proposalId,address by,string reason)',
]);

const GOVERNOR_VIEW_ABI = parseAbi([
  'function getProposalCore(uint256 proposalId) view returns (address proposer,address target,uint256 value,uint64 voteStartBlock,uint64 voteEndBlock,uint256 forVotes,uint256 againstVotes,uint256 abstainVotes,uint256 snapshotTotalSupply,bytes32 timelockOpId,bool cancelled,bool executed)',
  'function state(uint256 proposalId) view returns (uint8)',
]);

const BOND_EVENT_ABI = parseAbi([
  'event BondPosted(bytes32 indexed productId,address indexed builder,address indexed builderToken,uint256 orderAmount,uint256 builderTokenAmount,uint256 lpSharesOrder,uint256 lpSharesBuilderToken)',
  'event SlashingProposed(bytes32 indexed productId,uint8 reason,bytes32 reasonHash,address proposer,uint64 executableAt)',
  'event SlashingExecuted(bytes32 indexed productId,uint256 lpSharesBurned,uint256 lpSharesToInsurance)',
]);

const BOND_VIEW_ABI = parseAbi([
  'function bondOf(bytes32 productId) view returns (tuple(bytes32 productId,address builder,address builderToken,uint256 orderDeposited,uint256 builderTokenDeposited,uint256 lpSharesOrder,uint256 lpSharesBuilderToken,uint64 startTime,uint64 vestStart,uint64 vestEnd,uint256 vestedSharesOrderClaimed,uint256 vestedSharesBuilderTokenClaimed,uint8 status,uint64 slashingProposedAt,bytes32 slashingReasonHash,uint16 builderFeeBps,uint16 veOrderFeeBps,uint16 burnPctOnSlash,uint16 insurancePctOnSlash))',
]);

const OVERSIGHT_EVENT_ABI = parseAbi([
  'event GovernorFrozen(address indexed governor,bool frozen,address indexed by)',
  'event ActionBlocked(bytes32 indexed actionHash,bool blocked)',
]);

const PROPOSAL_STATE_NAMES: ProposalState[] = [
  'Pending', 'Active', 'Defeated', 'Succeeded',
  'Queued', 'Executed', 'Cancelled', 'Expired',
];

const SUPPORT_NAMES = ['Against', 'For', 'Abstain'] as const;

// ─── Probe ────────────────────────────────────────────────────

export class GovernanceProbe {
  private client: PublicClient | null = null;
  private lastBlockScanned = 0n;
  private knownGovernors: Set<string> = new Set();
  private knownBonds: Set<string> = new Set();
  private proposalCache: Map<string, ProposalSnapshot> = new Map();
  // proposerAddr -> { ts: balance } for surge detection
  private proposerBalanceHistory: Map<string, { ts: number; balance: bigint }[]> = new Map();

  constructor(private policy: GovernancePolicy | null) {
    if (policy) {
      this.knownGovernors = new Set();
      this.knownBonds = new Set();
    }
  }

  /** Hot-swap policy on manifest reload. */
  updatePolicy(policy: GovernancePolicy | null): void {
    this.policy = policy;
    this.client = null; // force reconnect on RPC URL change
  }

  registerGovernor(address: string): void {
    this.knownGovernors.add(address.toLowerCase());
  }

  registerBond(address: string): void {
    this.knownBonds.add(address.toLowerCase());
  }

  async probe(): Promise<ProbeResult<GovernanceSnapshot>> {
    const start = Date.now();
    if (!this.policy?.enabled) {
      return { ok: false, error: 'governance probe disabled', latencyMs: 0 };
    }
    if (!this.policy.contracts.rpc_url) {
      return { ok: false, error: 'no governance RPC configured', latencyMs: 0 };
    }

    try {
      const client = this.getClient();
      const head = await client.getBlockNumber();
      // First run: start from head - 100 blocks. Subsequent runs: from last+1.
      const fromBlock = this.lastBlockScanned === 0n
        ? (head > 100n ? head - 100n : 0n)
        : this.lastBlockScanned + 1n;
      // Cap range to avoid massive eth_getLogs windows.
      const toBlock = head > fromBlock + 1000n ? fromBlock + 1000n : head;

      const [proposals, bonds, oversight] = await Promise.all([
        this.scanProposals(client, fromBlock, toBlock),
        this.scanBonds(client, fromBlock, toBlock),
        this.scanOversight(client, fromBlock, toBlock),
      ]);

      this.lastBlockScanned = toBlock;

      const snapshot: GovernanceSnapshot = {
        recentProposals: proposals,
        bonds,
        oversight,
        lastBlockScanned: Number(toBlock),
      };
      return { ok: true, data: snapshot, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }

  private getClient(): PublicClient {
    if (this.client) return this.client;
    const chain = this.policy!.contracts.chain_id === 4460 ? orderlySepolia : orderlyChain;
    this.client = createPublicClient({
      chain,
      transport: http(this.policy!.contracts.rpc_url),
    });
    return this.client;
  }

  private async scanProposals(
    client: PublicClient,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ProposalSnapshot[]> {
    const out: ProposalSnapshot[] = [];
    if (this.knownGovernors.size === 0) return out;

    const addresses = Array.from(this.knownGovernors).map((a) => a as Address);

    // ProposalCreated logs across all known governors.
    const createdLogs = await client.getLogs({
      address: addresses,
      event: parseAbiItem(
        'event ProposalCreated(uint256 indexed proposalId,address indexed proposer,address target,bytes data,uint256 value,uint64 voteStartBlock,uint64 voteEndBlock,bytes32 descriptionHash)',
      ),
      fromBlock,
      toBlock,
    });

    const voteLogs = await client.getLogs({
      address: addresses,
      event: parseAbiItem(
        'event VoteCast(uint256 indexed proposalId,address indexed voter,uint8 support,uint256 weight)',
      ),
      fromBlock,
      toBlock,
    });

    // Group votes by proposalId.
    const votesByProposal = new Map<string, VoteEvent[]>();
    for (const log of voteLogs) {
      const args = (log as Log & { args: { proposalId: bigint; voter: Address; support: number; weight: bigint } }).args;
      const key = `${log.address.toLowerCase()}:${args.proposalId.toString()}`;
      const existing = votesByProposal.get(key) ?? [];
      existing.push({
        voter: args.voter,
        support: SUPPORT_NAMES[args.support] ?? 'Abstain',
        weight: args.weight.toString(),
        blockNumber: Number(log.blockNumber ?? 0n),
        timestamp: Date.now(), // upstream block timestamp would need a 2nd RPC call per block — skip for v1
      });
      votesByProposal.set(key, existing);
    }

    for (const log of createdLogs) {
      const args = (log as Log & {
        args: {
          proposalId: bigint;
          proposer: Address;
          target: Address;
          data: `0x${string}`;
          value: bigint;
          voteStartBlock: bigint;
          voteEndBlock: bigint;
          descriptionHash: `0x${string}`;
        };
      }).args;
      const governor = log.address.toLowerCase();
      const proposalIdStr = args.proposalId.toString();
      const key = `${governor}:${proposalIdStr}`;
      const votes = votesByProposal.get(key) ?? [];

      // Read live state.
      let stateNum = 0;
      let forVotes = 0n;
      let againstVotes = 0n;
      let abstainVotes = 0n;
      let snapshotTotalSupply = 0n;
      try {
        const core = await client.readContract({
          address: log.address,
          abi: GOVERNOR_VIEW_ABI,
          functionName: 'getProposalCore',
          args: [args.proposalId],
        });
        forVotes = core[5];
        againstVotes = core[6];
        abstainVotes = core[7];
        snapshotTotalSupply = core[8];
        const stateResult = await client.readContract({
          address: log.address,
          abi: GOVERNOR_VIEW_ABI,
          functionName: 'state',
          args: [args.proposalId],
        });
        stateNum = Number(stateResult);
      } catch {
        // Proposal may have been cancelled/cleared; fall through with defaults.
      }

      const selector = args.data.slice(0, 10);
      const totalForBig = forVotes;
      const topVoter = computeTopVoterShareBps(votes, totalForBig);
      const spike = computeVoteSpikeWindowBlocks(votes);

      out.push({
        governor,
        proposalId: proposalIdStr,
        proposer: args.proposer,
        target: args.target,
        selector,
        data: args.data,
        value: args.value.toString(),
        createdBlock: Number(log.blockNumber ?? 0n),
        voteStartBlock: Number(args.voteStartBlock),
        voteEndBlock: Number(args.voteEndBlock),
        forVotes: forVotes.toString(),
        againstVotes: againstVotes.toString(),
        abstainVotes: abstainVotes.toString(),
        snapshotTotalSupply: snapshotTotalSupply.toString(),
        state: PROPOSAL_STATE_NAMES[stateNum] ?? 'Pending',
        votes,
        // Surge tracking is best-effort: requires the gate to feed pre-propose
        // balance via writeProposerBalanceHistory(). In its absence, the
        // surge rule degrades to a no-op for that proposal.
        proposerBalanceBefore: '0',
        proposerBalanceAtPropose: '0',
        voteSpikeWindowBlocks: spike,
        topVoterShareBps: topVoter,
      });
    }

    return out;
  }

  private async scanBonds(
    client: PublicClient,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<BondSnapshot[]> {
    const out: BondSnapshot[] = [];
    if (this.knownBonds.size === 0) return out;
    const addresses = Array.from(this.knownBonds).map((a) => a as Address);

    const proposedLogs = await client.getLogs({
      address: addresses,
      event: parseAbiItem(
        'event SlashingProposed(bytes32 indexed productId,uint8 reason,bytes32 reasonHash,address proposer,uint64 executableAt)',
      ),
      fromBlock,
      toBlock,
    });

    interface BondTuple {
      productId: `0x${string}`;
      builder: Address;
      builderToken: Address;
      orderDeposited: bigint;
      builderTokenDeposited: bigint;
      lpSharesOrder: bigint;
      lpSharesBuilderToken: bigint;
      startTime: bigint;
      vestStart: bigint;
      vestEnd: bigint;
      vestedSharesOrderClaimed: bigint;
      vestedSharesBuilderTokenClaimed: bigint;
      status: number;
      slashingProposedAt: bigint;
      slashingReasonHash: `0x${string}`;
      builderFeeBps: number;
      veOrderFeeBps: number;
      burnPctOnSlash: number;
      insurancePctOnSlash: number;
    }

    for (const log of proposedLogs) {
      const args = (log as Log & {
        args: { productId: `0x${string}`; reason: number; reasonHash: `0x${string}`; proposer: Address; executableAt: bigint };
      }).args;
      try {
        const tuple = await client.readContract({
          address: log.address,
          abi: BOND_VIEW_ABI,
          functionName: 'bondOf',
          args: [args.productId],
        }) as unknown as BondTuple;
        const statusNames = ['None', 'Active', 'SlashingProposed', 'Slashed', 'Released'] as const;
        out.push({
          bondAddress: log.address.toLowerCase(),
          productId: args.productId,
          builder: tuple.builder,
          builderToken: tuple.builderToken,
          status: statusNames[tuple.status] ?? 'None',
          orderDeposited: tuple.orderDeposited.toString(),
          builderTokenDeposited: tuple.builderTokenDeposited.toString(),
          startTime: Number(tuple.startTime),
          vestStart: Number(tuple.vestStart),
          vestEnd: Number(tuple.vestEnd),
          slashingProposedAt: Number(tuple.slashingProposedAt),
          slashingReasonHash: tuple.slashingReasonHash,
          vetoExecutableAt: Number(args.executableAt),
        });
      } catch {
        // skip
      }
    }
    return out;
  }

  private async scanOversight(
    client: PublicClient,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<OversightSnapshot | null> {
    if (!this.policy?.contracts.oversight_address) return null;
    const oversightAddr = this.policy.contracts.oversight_address.toLowerCase() as Address;

    const frozenLogs = await client.getLogs({
      address: oversightAddr,
      event: parseAbiItem(
        'event GovernorFrozen(address indexed governor,bool frozen,address indexed by)',
      ),
      fromBlock,
      toBlock,
    });

    const blockedLogs = await client.getLogs({
      address: oversightAddr,
      event: parseAbiItem('event ActionBlocked(bytes32 indexed actionHash,bool blocked)'),
      fromBlock,
      toBlock,
    });

    const frozenSet = new Set<string>();
    for (const log of frozenLogs) {
      const args = (log as Log & { args: { governor: Address; frozen: boolean } }).args;
      const k = args.governor.toLowerCase();
      if (args.frozen) frozenSet.add(k);
      else frozenSet.delete(k);
    }

    return {
      contract: oversightAddr,
      frozenGovernors: Array.from(frozenSet),
      recentBlockedActions: blockedLogs.map((log) => {
        const args = (log as Log & { args: { actionHash: `0x${string}`; blocked: boolean } }).args;
        return {
          actionHash: args.actionHash,
          blockedAt: args.blocked ? Number(log.blockNumber ?? 0n) : 0,
        };
      }),
    };
  }
}

// ─── Heuristic helpers (pure, exported for unit tests) ──────────

function computeTopVoterShareBps(votes: VoteEvent[], totalForVotes: bigint): number {
  if (totalForVotes === 0n) return 0;
  let top = 0n;
  for (const v of votes) {
    if (v.support !== 'For') continue;
    const w = BigInt(v.weight);
    if (w > top) top = w;
  }
  return Number((top * 10_000n) / totalForVotes);
}

function computeVoteSpikeWindowBlocks(votes: VoteEvent[]): number {
  const forVotes = votes.filter((v) => v.support === 'For');
  if (forVotes.length < 3) return 0;
  forVotes.sort((a, b) => a.blockNumber - b.blockNumber);
  let totalWeight = 0n;
  for (const v of forVotes) totalWeight += BigInt(v.weight);
  if (totalWeight === 0n) return 0;
  // Find tightest window covering >= 50% of forVotes weight.
  let bestWindow = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < forVotes.length; i++) {
    let acc = 0n;
    for (let j = i; j < forVotes.length; j++) {
      acc += BigInt(forVotes[j]!.weight);
      if (acc * 2n >= totalWeight) {
        bestWindow = Math.min(bestWindow, forVotes[j]!.blockNumber - forVotes[i]!.blockNumber + 1);
        break;
      }
    }
  }
  return bestWindow === Number.MAX_SAFE_INTEGER ? 0 : bestWindow;
}

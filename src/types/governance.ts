// ─── Governance probe + policy types ──────────────────────────
//
// SecClaw's off-chain enforcement layer for Orderly Zero builder governance.
// Pairs with on-chain GovernanceSecOversight + BuilderTimelock + BuilderBond
// in the OZ contracts repo. The on-chain contracts are safe-by-default but
// slow to react; SecClaw is fast detect + automated response.

import type { ProbeResult } from './probes.js';

// ─── Probe snapshot ───────────────────────────────────────────

export type ProposalState =
  | 'Pending'
  | 'Active'
  | 'Defeated'
  | 'Succeeded'
  | 'Queued'
  | 'Executed'
  | 'Cancelled'
  | 'Expired';

export interface VoteEvent {
  voter: string;
  support: 'Against' | 'For' | 'Abstain';
  weight: string; // bigint as decimal string for JSON safety
  blockNumber: number;
  timestamp: number;
}

export interface ProposalSnapshot {
  governor: string;          // BuilderGovernor address
  proposalId: string;        // hex
  proposer: string;
  target: string;
  selector: string;          // 0x + 4 bytes
  data: string;              // full calldata
  value: string;             // wei as decimal string
  createdBlock: number;
  voteStartBlock: number;
  voteEndBlock: number;
  forVotes: string;          // bigint as decimal string
  againstVotes: string;
  abstainVotes: string;
  snapshotTotalSupply: string;
  state: ProposalState;
  votes: VoteEvent[];
  proposerBalanceBefore: string; // 24h before propose()
  proposerBalanceAtPropose: string;
  voteSpikeWindowBlocks: number; // 0 if no spike
  topVoterShareBps: number;      // largest single forVote as bps of forVotes
}

export interface BondSnapshot {
  bondAddress: string;        // BuilderBond contract
  productId: string;          // bytes32 hex
  builder: string;
  builderToken: string;
  status: 'None' | 'Active' | 'SlashingProposed' | 'Slashed' | 'Released';
  orderDeposited: string;
  builderTokenDeposited: string;
  startTime: number;
  vestStart: number;
  vestEnd: number;
  slashingProposedAt: number; // 0 if none
  slashingReasonHash: string;
  vetoExecutableAt: number;   // slashingProposedAt + 7 days
}

export interface OversightSnapshot {
  contract: string;           // GovernanceSecOversight address
  frozenGovernors: string[];
  recentBlockedActions: { actionHash: string; blockedAt: number }[];
}

export interface GovernanceSnapshot {
  recentProposals: ProposalSnapshot[];
  bonds: BondSnapshot[];
  oversight: OversightSnapshot | null;
  lastBlockScanned: number;
}

// ─── Policy block ─────────────────────────────────────────────

export interface GovernanceTierMins {
  silver: number;
  gold: number;
  platinum: number;
  diamond: number;
}

export interface GovernancePolicy {
  enabled: boolean;
  // Hard-deny lists mirrored to on-chain GovernanceSecOversight on bootstrap.
  orderly_protected_targets: string[];
  forbidden_selectors_global: string[];
  // Per-product action blocklist — keyed by `${governor}:${actionHash}`.
  action_blocklist: string[];
  proposal_heuristics: {
    whale_dominance_threshold_bps: number;
    proposer_balance_surge_pct: number;
    vote_spike_window_blocks: number;
    low_voter_diversity_threshold: number;
    quorum_edge_band_pct: number;
  };
  auto_response: {
    freeze_on_critical: boolean;
    block_action_on_warning: boolean;
    propose_slash_on_shai_hulud: boolean;
  };
  bond_min_size_usd: GovernanceTierMins;
  contracts: {
    oversight_address: string;     // GovernanceSecOversight
    council_address: string;       // OZCouncil
    registry_address: string;      // ProductRegistry on Orderly Chain
    rpc_url: string;               // Orderly Chain RPC
    chain_id: number;              // 291 mainnet, 4460 sepolia
  };
}

// Re-export for SystemSnapshot wiring.
export type GovernanceProbeResult = ProbeResult<GovernanceSnapshot>;

// ─── Governance config audit (pre-deploy validation) ──────────
//
// Run by the OZ wizard / chat / agents before deploying a builder product.
// Validates that the proposed governance + bond + timelock allowlist do not
// cross the firewall (no Orderly-protected targets, no forbidden selectors,
// sane council/quorum/timelock parameters, sane bond composition).
//
// Pairs with:
//   - On-chain GovernanceSecOversight.sol — runtime enforcement
//   - In-process governance-action.ts gate — pre-tx enforcement
//   - This module — pre-deploy enforcement (catches misconfiguration at the
//     wizard step, before any contract is deployed)

export interface GovernanceAuditCheckResult {
  check: string;
  passed: boolean;
  message: string;
}

export interface GovernanceAuditResult {
  passed: boolean;
  score: number;
  checks: GovernanceAuditCheckResult[];
}

export interface GovernanceAuditInput {
  template:
    | 'none'
    | 'council'
    | 'token_vote'
    | 've_token'
    | 'dual_token'
    | 'council_to_dao';
  signers?: string[];
  threshold?: number;
  builder_token?: string;
  quorum_pct?: number;
  pass_threshold_pct?: number;
  voting_period_hours?: number;
  timelock_hours?: number;
  builder_weight?: number;
  composition?: 'geomean' | 'linear';
}

export interface GovernanceTargetSpec {
  target: string;
  selector: string; // 0x + 4 bytes
}

export interface GovernanceAuditConfig {
  governance: GovernanceAuditInput;
  allowlist: GovernanceTargetSpec[];
  builder_address: string;
  product_id: string;
  commitment?: {
    size_usd: number;
    order_pct: number;
    builder_token_pct: number;
    lock_months: number;
  };
}

// Protocol-wide deny list — placeholders. The OZ deploy script populates
// the live values from the policy manifest at runtime; this is the bare
// minimum that guarantees ORDER itself is never callable by builder gov.
export const ORDERLY_PROTECTED_TARGETS: ReadonlyArray<string> = [
  '0xabd4c63d2616a5201454168269031355f4764337', // ORDER (Ethereum)
  '0x0000000000000000000000000000000000000001', // Orderly vault — wired at runtime
  '0x0000000000000000000000000000000000000002', // Orderly CLOB — wired at runtime
];

export const FORBIDDEN_SELECTORS_GLOBAL: ReadonlyArray<{
  selector: string;
  signature: string;
  reason: string;
}> = [
  { selector: '0x5c19a95c', signature: 'delegate(address)',
    reason: 'delegating bonded voting power can capture upstream governance' },
  { selector: '0xc3cda520', signature: 'delegateBySig(address,uint256,uint256,uint8,bytes32,bytes32)',
    reason: 'signed delegation has the same takeover surface as delegate()' },
  { selector: '0x3659cfe6', signature: 'upgradeTo(address)',
    reason: 'UUPS upgrade allows arbitrary code substitution' },
  { selector: '0x4f1ef286', signature: 'upgradeToAndCall(address,bytes)',
    reason: 'UUPS upgrade-and-call allows arbitrary code + init' },
  { selector: '0xf2fde38b', signature: 'transferOwnership(address)',
    reason: 'ownership transfer is a contract takeover' },
  { selector: '0x715018a6', signature: 'renounceOwnership()',
    reason: 'renouncing ownership leaves contracts unmanageable' },
  { selector: '0x40c10f19', signature: 'mint(address,uint256)',
    reason: 'unbounded mint authority on a token outside the product invites supply attacks' },
];

const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SELECTOR_RE = /^0x[a-fA-F0-9]{8}$/;

function check(name: string, passed: boolean, message: string): GovernanceAuditCheckResult {
  return { check: name, passed, message };
}

export function auditGovernanceConfig(input: GovernanceAuditConfig): GovernanceAuditResult {
  const checks: GovernanceAuditCheckResult[] = [];
  const protectedSet = new Set(ORDERLY_PROTECTED_TARGETS.map((s) => s.toLowerCase()));
  const forbiddenSelSet = new Set(
    FORBIDDEN_SELECTORS_GLOBAL.map((s) => s.selector.toLowerCase()),
  );

  const gov = input.governance;

  if (gov.template === 'council' || gov.template === 'council_to_dao') {
    const signers = gov.signers ?? [];
    const allValid = signers.every((s) => ETH_ADDR_RE.test(s));
    checks.push(check('council_signers_valid', signers.length >= 3 && allValid,
      signers.length < 3
        ? `council requires 3+ signers (got ${signers.length})`
        : allValid
          ? `${signers.length} valid signer addresses`
          : 'one or more signer addresses are malformed'));

    const thresholdOk = typeof gov.threshold === 'number'
      && gov.threshold >= 2 && gov.threshold <= signers.length;
    checks.push(check('council_threshold_sane', thresholdOk,
      thresholdOk
        ? `threshold ${gov.threshold} of ${signers.length}`
        : `threshold must be 2..${signers.length}`));

    const distinct = new Set(signers.map((s) => s.toLowerCase())).size;
    checks.push(check('council_no_duplicate_signers', distinct === signers.length,
      distinct === signers.length
        ? 'all signer addresses distinct'
        : 'duplicate signer addresses detected'));
  }

  if (gov.template === 'token_vote' || gov.template === 've_token' || gov.template === 'dual_token') {
    const tok = gov.builder_token ?? '';
    checks.push(check('builder_token_present', ETH_ADDR_RE.test(tok),
      ETH_ADDR_RE.test(tok)
        ? `builder_token ${tok}`
        : 'builder_token missing or malformed'));

    const quorum = gov.quorum_pct ?? 0;
    checks.push(check('quorum_within_bounds', quorum >= 1 && quorum <= 50,
      `quorum_pct ${quorum}`));

    const pass = gov.pass_threshold_pct ?? 50;
    checks.push(check('pass_threshold_supermajority_ok', pass >= 50 && pass <= 100,
      `pass_threshold_pct ${pass}`));

    const period = gov.voting_period_hours ?? 0;
    checks.push(check('voting_period_long_enough', period >= 24,
      period >= 24
        ? `voting period ${period}h`
        : `voting period ${period}h too short — flash-vote risk`));

    const tl = gov.timelock_hours ?? 0;
    checks.push(check('timelock_long_enough', tl >= 24,
      tl >= 24
        ? `timelock ${tl}h`
        : `timelock ${tl}h too short — Council cannot react`));
  }

  if (gov.template === 'dual_token') {
    const w = gov.builder_weight ?? 0.6;
    checks.push(check('dual_token_weight_in_range', w >= 0.1 && w <= 0.9,
      `builder_weight ${w}`));
  }

  // Allowlist firewall pre-flight
  if (input.allowlist.length === 0 && gov.template !== 'none') {
    checks.push(check('allowlist_non_empty', false,
      'governance template is set but timelock allowlist is empty'));
  }
  for (const entry of input.allowlist) {
    if (!ETH_ADDR_RE.test(entry.target)) {
      checks.push(check(`allowlist_target_valid:${entry.target}`, false,
        `malformed target address ${entry.target}`));
      continue;
    }
    if (!SELECTOR_RE.test(entry.selector)) {
      checks.push(check(`allowlist_selector_valid:${entry.selector}`, false,
        `malformed selector ${entry.selector}`));
      continue;
    }
    const t = entry.target.toLowerCase();
    const s = entry.selector.toLowerCase();
    if (protectedSet.has(t)) {
      checks.push(check(`allowlist_target_not_protected:${entry.target}`, false,
        `${entry.target} is an Orderly-protected target — never callable from builder governance`));
    }
    if (forbiddenSelSet.has(s)) {
      const meta = FORBIDDEN_SELECTORS_GLOBAL.find((x) => x.selector.toLowerCase() === s);
      checks.push(check(`allowlist_selector_not_forbidden:${entry.selector}`, false,
        `${meta?.signature ?? entry.selector} forbidden globally — ${meta?.reason ?? 'takeover risk'}`));
    }
  }

  // Commitment bond sanity
  if (input.commitment) {
    const c = input.commitment;
    checks.push(check('commitment_size_min', c.size_usd >= 10_000,
      `bond size $${c.size_usd.toLocaleString()}`));
    checks.push(check('commitment_composition_sums_100', c.order_pct + c.builder_token_pct === 100,
      `composition ${c.order_pct}% ORDER + ${c.builder_token_pct}% builder = ${c.order_pct + c.builder_token_pct}%`));
    checks.push(check('commitment_lock_min_six_months', c.lock_months >= 6,
      `lock ${c.lock_months} months`));
  }

  const passed = checks.every((c) => c.passed);
  const score = checks.length === 0 ? 1 : checks.filter((c) => c.passed).length / checks.length;
  return { passed, score, checks };
}

// ─── Live proposal monitoring (used by SecClaw daemon as well) ──

export interface ProposalSnapshot {
  governor: string;
  proposalId: string;
  proposer: string;
  target: string;
  selector: string;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  snapshotTotalSupply: bigint;
  voterCount: number;
  topVoterShareBps: number;
  proposerBalanceJump24hPct: number;
  voteSpikeWindowBlocks: number;
}

export interface ProposalHeuristic {
  name: string;
  severity: 'info' | 'warning' | 'critical';
  triggered: boolean;
  message: string;
}

export function evaluateProposalHeuristics(snap: ProposalSnapshot): ProposalHeuristic[] {
  const out: ProposalHeuristic[] = [];

  const whaleDominant = snap.topVoterShareBps > 5_000;
  out.push({
    name: 'whale_dominant_passage',
    severity: whaleDominant ? 'warning' : 'info',
    triggered: whaleDominant,
    message: whaleDominant
      ? `top voter holds ${(snap.topVoterShareBps / 100).toFixed(1)}% of forVotes`
      : 'no single voter dominates',
  });

  const proposerSurge = snap.proposerBalanceJump24hPct > 50;
  out.push({
    name: 'proposer_balance_surge',
    severity: proposerSurge ? 'critical' : 'info',
    triggered: proposerSurge,
    message: proposerSurge
      ? `proposer balance grew ${snap.proposerBalanceJump24hPct.toFixed(1)}% in 24h pre-propose`
      : 'proposer balance steady pre-propose',
  });

  const tightWindow = snap.voteSpikeWindowBlocks > 0 && snap.voteSpikeWindowBlocks < 4;
  out.push({
    name: 'vote_landing_spike',
    severity: tightWindow ? 'warning' : 'info',
    triggered: tightWindow,
    message: tightWindow
      ? `majority of votes within ${snap.voteSpikeWindowBlocks} blocks — sybil/coordination signal`
      : 'votes landed across a normal window',
  });

  const lowDiversity = snap.voterCount < 10 && snap.forVotes > snap.againstVotes;
  out.push({
    name: 'low_voter_diversity',
    severity: lowDiversity ? 'warning' : 'info',
    triggered: lowDiversity,
    message: lowDiversity
      ? `only ${snap.voterCount} unique voters — capture risk`
      : `${snap.voterCount} unique voters`,
  });

  const totalCast = snap.forVotes + snap.againstVotes + snap.abstainVotes;
  const quorum4Bps = (snap.snapshotTotalSupply * 400n) / 10_000n;
  const quorumEdge = totalCast >= quorum4Bps && totalCast <= (quorum4Bps * 110n) / 100n;
  out.push({
    name: 'quorum_edge_passage',
    severity: quorumEdge ? 'warning' : 'info',
    triggered: quorumEdge,
    message: quorumEdge
      ? 'passed within 10% of quorum — manipulation risk'
      : 'well above quorum threshold',
  });

  return out;
}

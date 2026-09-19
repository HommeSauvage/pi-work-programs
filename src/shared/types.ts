export type Mode = "session" | "managed" | "captain";
export type ParallelExecution = "worktrees" | "direct";
export type ReviewProfile = "light" | "enhanced";
export type CardKind = "write" | "recon";

export type CardPhase =
	| "pending"
	| "ready"
	| "implementing"
	| "review_pending"
	| "reviewing"
	| "triaging"
	| "fixing"
	| "approved"
	| "verifying"
	| "queued"
	| "merging"
	| "reconciling"
	| "done"
	| "blocked";

export type ProgramStatus = "planning" | "active" | "paused" | "complete" | "abandoned";

export interface GateResult {
	command: string;
	code: number;
	at: number;
	tail: string;
}

export interface Lane {
	/** Absolute worktree path. */
	path: string;
	branch: string;
	/** Commit the lane branched from. */
	base: string;
}

/** Token/cost usage of one run (or an aggregate of runs), from pi-subagents status.json. */
export interface RunUsage {
	/** Non-cached input tokens. */
	input: number;
	output: number;
	/** Cumulative tokens across the run (input + cache reads + output). */
	total: number;
	/** Largest context window the run reached. */
	windowPeak?: number;
	costUsd?: number;
	turns?: number;
	tools?: number;
	/** Cached input tokens re-read across turns (transcript-accurate when available). */
	cacheRead?: number;
	cacheWrite?: number;
	/** Reasoning (thinking) tokens; providers bill these as output. Transcript-accurate only. */
	reasoning?: number;
	/** Cost split in USD, transcript-accurate only (status.json carries a single total).
	 *  Cached input is ~50x cheaper per token than uncached input, so the split — not
	 *  the total — is what tells a reader where the money went. */
	costInputUsd?: number;
	costOutputUsd?: number;
	costCacheReadUsd?: number;
	costCacheWriteUsd?: number;
}

/** One recorded run's usage, kept per card for per-pass breakdown. */
export interface CardRunUsage extends RunUsage {
	kind: ActiveRunKind;
	at: number;
	/** True when this run continued a retained session (resume) instead of starting fresh. */
	resumed?: boolean;
	/** Session transcript key; resumed runs share their session's key. */
	session?: string;
}

/**
 * Cumulative usage of one agent session — a worker or reviewer chain across
 * resumes shares one session (and one transcript), so resumes UPDATE this
 * snapshot instead of adding a row. A fresh dispatch starts a new session.
 * Card totals are the sum of sessions: accurate across resume chains.
 */
export interface CardSessionUsage {
	session: string;
	kind: ActiveRunKind;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	costUsd?: number;
	windowPeak?: number;
	turns?: number;
	tools?: number;
	/** Reasoning (thinking) tokens; billed as output. Transcript-accurate only. */
	reasoning?: number;
	/** Cost split in USD (transcript-accurate only); see {@link RunUsage}. */
	costInputUsd?: number;
	costOutputUsd?: number;
	costCacheReadUsd?: number;
	costCacheWriteUsd?: number;
	updatedAt: number;
}

/**
 * Program atlas: a scout-maintained orientation document (`atlas.md`) so workers
 * and reviewers start from a curated map instead of re-exploring the repo.
 * The atlas file is the source of truth; the scout session is only a warm cache
 * over it (resume when possible, fresh scout re-reads the atlas otherwise).
 */
export interface AtlasLedger {
	enabled: boolean;
	agent?: string;
	model?: string;
	thinking?: string;
	/** undefined = never built; building = first build in flight (gates worker dispatch); refreshing = post-merge update in flight. */
	state?: "building" | "ready" | "refreshing" | "failed";
	runId?: string;
	asyncDir?: string;
	startedAt?: number;
	/** Cards merged since the atlas was last updated (drives refresh briefs). */
	pendingMerges: Array<{ id: string; commit?: string }>;
	refreshes: number;
	builtAt?: number;
	updatedAt?: number;
	usage?: RunUsage;
	/** Per-session scout usage (refreshes replace their session row, never sum). */
	usageSessions?: CardSessionUsage[];
	lastError?: string;
	/** Refresh retry throttle: no fresh refresh dispatch before this timestamp. */
	nextRefreshAt?: number;
}

export interface CardMerge {
	state: "queued" | "merging" | "conflict" | "merged";
	commit?: string;
	attempts: number;
}

export type ActiveRunKind = "worker" | "reviewer" | "fix" | "captain" | "reconciler" | "scout";

export interface ActiveRun {
	kind: ActiveRunKind;
	runId: string;
	asyncDir?: string;
	startedAt: number;
	/** True when this run continued a retained session instead of starting fresh. */
	resumed?: boolean;
}

export interface CardLedger {
	id: string;
	/** Path relative to the program directory. */
	path: string;
	title: string;
	phase: CardPhase;
	dependsOn: string[];
	kind: CardKind;
	reviewProfile?: ReviewProfile;
	/** Per-card review-cycle cap (falls back to the program maxCycles). */
	maxCycles?: number;
	workerAgent?: string;
	workerModel?: string;
	workerThinking?: string;
	/** Per-card override for fresh fix dispatches (falls back to the program's fix* then the worker lane). */
	fixModel?: string;
	fixThinking?: string;
	reviewerAgent?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
	workerRun?: string;
	reviewRun?: string;
	/** Lane HEAD sha at the last review dispatch — the delta base for a resumed re-review. */
	lastReviewedSha?: string;
	fixRuns?: string[];
	captainRun?: string;
	reconcilerRun?: string;
	activeRun?: ActiveRun;
	cycles: number;
	runs: number;
	gateAttempts?: number;
	reconcileAttempts?: number;
	workerSummary?: string;
	fixReason?: "review" | "gate";
	lane?: Lane;
	merge?: CardMerge;
	gates?: GateResult[];
	lastError?: string;
	/** Phase the card was in when it became blocked (routes redispatch back to fixing). */
	blockedFrom?: CardPhase;
	/** Consecutive runner-infra auto-retries consumed by the current fix round. */
	infraRetries?: number;
	/** Quota hold: no dispatch until this timestamp (provider usage limits). */
	holdUntil?: number;
	/** Human-readable hold reason, naming the parsed reset hint and its source. */
	holdReason?: string;
	/** Consecutive quota holds consumed for the current pause (extension cap). */
	holdCount?: number;
	/** Open blocking operator todos (`op-NN` ids) parking this card. */
	waitingOn?: string[];
	/** Operator-dropped scope: terminal, kept in records, excluded from completion gating. */
	abandoned?: boolean;
	/** Aggregated token usage across all of this card's runs. */
	usage?: RunUsage;
	/** Per-run usage records (bounded), newest last. */
	usageRuns?: CardRunUsage[];
	/** Cumulative per-session usage (resumes update their session; fresh runs add one). */
	usageSessions?: CardSessionUsage[];
	/** Consecutive resumes of the worker session; a fresh worker resets it to 0. */
	workerResumeDepth?: number;
	/** Consecutive resumes of the reviewer session; a fresh reviewer resets it to 0. */
	reviewerResumeDepth?: number;
	/** Per-card gate commands (front matter `gates`); overrides the program's gates.card when set. */
	gateCommands?: string[];
	/** Findings approved at the review-cycle cap and carried into the merge unfixed. */
	acceptedFindings?: string[];
	updatedAt: number;
}

export type DecisionKind = "review-triage" | "cycle-exhausted" | "blocked" | "gate-failed";

export interface FindingVerdict {
	finding: string;
	verdict: "approve" | "reject" | "defer";
	note?: string;
}

export interface Decision {
	id: string;
	kind: DecisionKind;
	card?: string;
	status: "open" | "resolved" | "cancelled";
	createdAt: number;
	resolvedAt?: number;
	/** Review text path for review-triage decisions. */
	reviewPath?: string;
	/** Reviewer output digest shown in packets. */
	summary?: string;
	/** Operator/orchestrator-facing description of what is being asked. */
	message?: string;
	/** Exact tool call expected to resolve this decision. */
	expectedAction?: string;
	verdicts?: FindingVerdict[];
	cancelReason?: string;
	packetSent?: boolean;
}

export interface ProgramLedger {
	version: 1;
	slug: string;
	title: string;
	/** Directory path relative to the project cwd. */
	dir: string;
	status: ProgramStatus;
	mode: Mode;
	maxParallel: number;
	parallelExecution: ParallelExecution;
	reviewProfile: ReviewProfile;
	maxCycles: number;
	onExhausted: "ask" | "accept" | "block";
	workerAgent: string;
	reviewerAgent: string;
	/** Resume the same reviewer session across review cycles of a card (default true). */
	reviewerResume?: boolean;
	/** Per-run wall-clock timeout passed to every dispatch (default 4h; pi-subagents otherwise kills single async runs at 30m). */
	runTimeoutMs?: number;
	/** Resume a retained session only while its context peak stays under this (tokens). */
	resumeMaxWindowPeak?: number;
	/** Max consecutive resumes of one session before a fresh dispatch. */
	resumeMaxDepth?: number;
	workerModel?: string;
	workerThinking?: string;
	/** Fresh fix dispatches only: resumed fixes keep the retained child's stored model/thinking. */
	fixModel?: string;
	/** Fresh fix dispatches only; see {@link ProgramLedger.fixModel}. */
	fixThinking?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
	gates: { card: string[]; program: string[] };
	baseBranch: string;
	baseCommit: string;
	laneBranchPattern: string;
	cards: Record<string, CardLedger>;
	order: string[];
	mergeQueue: string[];
	decisions: Decision[];
	programGate?: GateResult[];
	mergeQueuePaused?: boolean;
	atlas?: AtlasLedger;
	createdAt: number;
	updatedAt: number;
}

export interface ParsedCard {
	id: string;
	path: string;
	title: string;
	dependsOn: string[];
	hasDependsDeclaration: boolean;
	kind: CardKind;
	reviewProfile?: ReviewProfile;
	maxCycles?: number;
	workerAgent?: string;
	workerModel?: string;
	workerThinking?: string;
	fixModel?: string;
	fixThinking?: string;
	reviewerAgent?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
	/** Front-matter `gates`: per-card gate commands overriding the program's gates.card. */
	gates?: string[];
	state: string;
	evidence: string;
}

export interface CardConfigPatch {
	reviewProfile?: ReviewProfile;
	maxCycles?: number;
	workerAgent?: string;
	workerModel?: string;
	workerThinking?: string;
	fixModel?: string;
	fixThinking?: string;
	reviewerAgent?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
}

export interface ParsedPlan {
	title: string;
	config: Record<string, unknown>;
	cards: Array<{ id: string; path: string }>;
	problems: string[];
}

export interface ProgramConfigOverrides {
	mode?: Mode;
	maxParallel?: number;
	parallelExecution?: ParallelExecution;
	reviewProfile?: ReviewProfile;
	maxCycles?: number;
	workerAgent?: string;
	reviewerAgent?: string;
	workerModel?: string;
	workerThinking?: string;
	fixModel?: string;
	fixThinking?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
	reviewerResume?: boolean;
	runTimeoutMs?: number;
	resumeMaxWindowPeak?: number;
	resumeMaxDepth?: number;
	atlasEnabled?: boolean;
	atlasAgent?: string;
	atlasModel?: string;
	atlasThinking?: string;
	gates?: { card?: string[]; program?: string[] };
	laneBranchPattern?: string;
}

export interface WorkProgramSettings {
	dir: string;
	mode: Mode;
	maxParallel: number;
	parallelExecution: ParallelExecution;
	review: {
		agent: string;
		profile: ReviewProfile;
		maxCycles: number;
		onExhausted: "ask" | "accept" | "block";
		/** Resume the same reviewer across a card's review cycles (default true). */
		resumeReviewer?: boolean;
	};
	worker: { agent: string; model?: string; thinking?: string; fixModel?: string; fixThinking?: string };
	reviewer: { model?: string; thinking?: string };
	/** Program atlas: scout-built orientation document injected into worker/reviewer briefs. */
	atlas?: { enabled: boolean; agent: string; model?: string; thinking?: string };
	iterations?: number;
	/** Per-run wall-clock timeout for dispatches (default 4h). */
	runTimeoutMs?: number;
	/** Context-peak threshold for resuming a retained session (default 250k tokens). */
	resumeMaxWindowPeak?: number;
	/** Max consecutive resumes of one session (default 3). */
	resumeMaxDepth?: number;
	gates: { card: string[]; program: string[] };
	worktreeDir?: string;
	laneBranchPattern: string;
}

export interface RunStatus {
	state: "queued" | "running" | "complete" | "failed" | "stopped" | "paused" | "rejected" | "not_found" | "unknown";
	output?: string;
	structured?: unknown;
	error?: string;
	/** Token/cost usage read from the run's status.json (terminal states). */
	usage?: RunUsage;
	/** Child session transcript path (status.json `sessionFile`); resumed runs share the original. */
	sessionFile?: string;
	/** Cumulative usage of the whole session, summed from the transcript (authoritative, includes cache reads). */
	sessionUsage?: RunUsage;
}

export interface RunHeartbeat {
	runId: string;
	state: string;
	elapsedMs?: number;
	lastUpdate?: number;
	steps?: number;
	recentTools?: string[];
	tail?: string;
}

export interface DispatchRequest {
	kind: "worker" | "reviewer" | "fix" | "captain" | "reconciler" | "scout";
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string;
	label: string;
	timeoutMs?: number;
	outputSchema?: Record<string, unknown>;
}

export interface DispatchResult {
	runId: string;
	asyncDir?: string;
}

export interface GitOps {
	statusPorcelain(cwd: string): Promise<string>;
	diffCachedQuiet(cwd: string): Promise<boolean>;
	ignoredPaths(cwd: string, paths: string[]): Promise<string[]>;
	commitRecords(cwd: string, message: string, paths: string[]): Promise<{ commit: string; skipped: string[] }>;
	commitMerge(cwd: string): Promise<string>;
	head(cwd: string): Promise<string>;
	currentBranch(cwd: string): Promise<string>;
	worktreeAdd(cwd: string, path: string, branch: string, baseRef: string): Promise<void>;
	worktreeRemove(cwd: string, path: string): Promise<void>;
	branchDelete(cwd: string, branch: string): Promise<void>;
	diffStat(cwd: string, from: string, to: string): Promise<string>;
	commitLog(cwd: string, range: string): Promise<string>;
	mergeNoCommit(cwd: string, branch: string): Promise<{ code: number; conflicted: string[]; output: string }>;
	merging(cwd: string): Promise<boolean>;
	isAncestor(cwd: string, ref: string, of: string): Promise<boolean>;
	mergeAbort(cwd: string): Promise<void>;
	unmergedPaths(cwd: string): Promise<string[]>;
	commitAll(cwd: string, message: string): Promise<string>;
	commitPaths(cwd: string, message: string, paths: string[]): Promise<string>;
	revParse(cwd: string, ref: string): Promise<string>;
	changedFiles(cwd: string, from: string, to: string): Promise<string[]>;
}

export interface RunOps {
	dispatch(request: DispatchRequest): Promise<DispatchResult>;
	resume(runId: string, message: string): Promise<DispatchResult>;
	/** Stop a live run immediately. Throws when the run cannot be stopped. */
	stop(runId: string): Promise<void>;
	status(runId: string, asyncDir?: string): Promise<RunStatus>;
	/**
	 * Read-only liveness snapshot for UI display (status, doctor, TUI widget).
	 * Pure artifact reads — never steers, resumes, stops, or otherwise disturbs the run.
	 */
	heartbeat(runId: string, asyncDir?: string): Promise<RunHeartbeat>;
	/** Sync variant of heartbeat for the synchronous widget path (same read-only file reads). */
	heartbeatSnapshot?(runId: string, asyncDir?: string): RunHeartbeat;
	available(): boolean;
}

export interface GateOps {
	run(command: string, cwd: string): Promise<GateResult>;
}

export interface DriverPorts {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	appendProgress(line: string): Promise<void>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** Inject a message into the session and wake the agent when needed. */
	ask(message: string): void;
	/**
	 * False while pi is processing a run, an automatic retry, a compaction, or a
	 * queued continuation. Decision packets only wake an idle session, so a
	 * decision answered during the current turn is never announced afterwards.
	 */
	sessionIdle(): boolean;
	git: GitOps;
	runs: RunOps;
	gates: GateOps;
	persist(ledger: ProgramLedger): Promise<void>;
	readCard(ledger: ProgramLedger, card: CardLedger): Promise<string>;
	writeCard(ledger: ProgramLedger, card: CardLedger, content: string): Promise<void>;
	/** Directory that holds lane worktrees for this program. */
	worktreeBase(ledger: ProgramLedger): string;
	/** Working directory for a card's runs and gates (lane worktree in worktrees mode, repo root otherwise). */
	runCwd(ledger: ProgramLedger, card: CardLedger): string;
}

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

export interface CardMerge {
	state: "queued" | "merging" | "conflict" | "merged";
	commit?: string;
	attempts: number;
}

export type ActiveRunKind = "worker" | "reviewer" | "fix" | "captain" | "reconciler";

export interface ActiveRun {
	kind: ActiveRunKind;
	runId: string;
	asyncDir?: string;
	startedAt: number;
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
	workerRun?: string;
	reviewRun?: string;
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
	workerModel?: string;
	workerThinking?: string;
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
	state: string;
	evidence: string;
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
	reviewerModel?: string;
	reviewerThinking?: string;
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
	};
	worker: { agent: string; model?: string; thinking?: string };
	reviewer: { model?: string; thinking?: string };
	gates: { card: string[]; program: string[] };
	worktreeDir?: string;
	laneBranchPattern: string;
}

export interface RunStatus {
	state: "queued" | "running" | "complete" | "failed" | "stopped" | "paused" | "rejected" | "not_found" | "unknown";
	output?: string;
	structured?: unknown;
	error?: string;
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
	kind: "worker" | "reviewer" | "fix" | "captain" | "reconciler";
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

import { join, resolve } from "node:path";
import { ATLAS_FILE, DEFAULT_RESUME_MAX_DEPTH, DEFAULT_RESUME_MAX_WINDOW_PEAK, DEFAULT_RUN_TIMEOUT_MS, LEDGER_FILE, PROGRESS_FILE, REVIEWS_DIR, RUNTIME_DIR } from "../constants.ts";
import { readJson, writeJsonAtomic } from "../shared/fsx.ts";
import type {
	CardLedger,
	ParsedCard,
	ProgramConfigOverrides,
	ProgramLedger,
	WorkProgramSettings,
} from "../shared/types.ts";
import { applyOverrides, parsePlanConfig } from "../config.ts";
import { parsePlanDependencies, phaseForState } from "./parse.ts";
import { defaultLaneBranch } from "../shared/paths.ts";

export function compareCardIds(a: string, b: string): number {
	const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const length = Math.max(pa.length, pb.length);
	for (let i = 0; i < length; i += 1) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va !== vb) return va - vb;
	}
	return a.localeCompare(b);
}

export function ledgerPath(programDir: string): string {
	return join(programDir, RUNTIME_DIR, LEDGER_FILE);
}

export function reviewPath(programDir: string, cardId: string, cycle: number): string {
	return join(programDir, RUNTIME_DIR, REVIEWS_DIR, `${cardId}-review-${cycle}.md`);
}

export function progressPath(programDir: string): string {
	return join(programDir, PROGRESS_FILE);
}

export function atlasPath(programDir: string): string {
	return join(programDir, ATLAS_FILE);
}

/** Lane handoff note maintained by the worker for whoever continues this lane.
 *  Machine state, not a record: it lives in the program's `.runtime` (gitignored)
 *  so it informs the next session without ever dirtying the repository the worker
 *  commits to. */
export function laneNotesPath(programDir: string, cardId: string): string {
	return join(programDir, RUNTIME_DIR, "lanes", `${cardId}.md`);
}

export function laneBranch(pattern: string, baseBranch: string, cardId: string): string {
	if (pattern.includes("{branch}") || pattern.includes("{id}")) {
		return pattern.replace("{branch}", baseBranch).replace("{id}", cardId);
	}
	return defaultLaneBranch(baseBranch, cardId);
}

export async function loadLedger(programDir: string): Promise<ProgramLedger | undefined> {
	const raw = await readJson<ProgramLedger>(ledgerPath(programDir));
	if (!raw || raw.version !== 1 || typeof raw.slug !== "string") return undefined;
	return raw;
}

export async function saveLedger(programDir: string, ledger: ProgramLedger): Promise<void> {
	await writeJsonAtomic(ledgerPath(programDir), ledger);
}

export function cardFromParsed(parsed: ParsedCard, planText: string): CardLedger {
	const planDeps = parsePlanDependencies(planText, parsed.path);
	const dependsOn = [...new Set([...parsed.dependsOn, ...planDeps])].sort(compareCardIds);
	const mapped = phaseForState(parsed.state);
	const card: CardLedger = {
		id: parsed.id,
		path: parsed.path,
		title: parsed.title,
		dependsOn,
		kind: parsed.kind,
		phase: mapped === "adopted-unknown" ? "blocked" : mapped === "review_pending" ? "review_pending" : mapped,
		cycles: 0,
		runs: 0,
		updatedAt: Date.now(),
	};
	if (parsed.reviewProfile) card.reviewProfile = parsed.reviewProfile;
	if (parsed.maxCycles !== undefined) card.maxCycles = parsed.maxCycles;
	if (parsed.workerAgent) card.workerAgent = parsed.workerAgent;
	if (parsed.workerModel) card.workerModel = parsed.workerModel;
	if (parsed.workerThinking) card.workerThinking = parsed.workerThinking;
	if (parsed.fixModel) card.fixModel = parsed.fixModel;
	if (parsed.fixThinking) card.fixThinking = parsed.fixThinking;
	if (parsed.reviewerAgent) card.reviewerAgent = parsed.reviewerAgent;
	if (parsed.reviewerModel) card.reviewerModel = parsed.reviewerModel;
	if (parsed.reviewerThinking) card.reviewerThinking = parsed.reviewerThinking;
	if (parsed.gates) card.gateCommands = parsed.gates;
	if (mapped === "adopted-unknown") {
		card.lastError = `adopted in state "${parsed.state || "unknown"}"; needs a decision (redispatch, mark done, or abandon)`;
	}
	return card;
}

export function buildLedger(input: {
	slug: string;
	title: string;
	dir: string;
	settings: WorkProgramSettings;
	overrides?: ProgramConfigOverrides;
	baseBranch: string;
	baseCommit: string;
	cards: ParsedCard[];
	planText: string;
	existing?: ProgramLedger;
}): ProgramLedger {
	const settings = input.overrides ? applyOverrides(input.settings, input.overrides) : input.settings;
	const cards: Record<string, CardLedger> = {};
	if (input.existing) {
		for (const [id, card] of Object.entries(input.existing.cards)) {
			if (card.phase !== "done" && card.phase !== "blocked") continue;
			cards[id] = card;
		}
	}
	for (const parsed of input.cards) {
		if (cards[parsed.id]) continue;
		cards[parsed.id] = cardFromParsed(parsed, input.planText);
	}
	const order = Object.keys(cards).sort(compareCardIds);
	return {
		version: 1,
		slug: input.slug,
		title: input.title,
		dir: input.dir,
		status: "planning",
		mode: settings.mode,
		maxParallel: settings.maxParallel,
		parallelExecution: settings.parallelExecution,
		reviewProfile: settings.review.profile,
		maxCycles: settings.review.maxCycles,
		onExhausted: settings.review.onExhausted,
		workerAgent: settings.worker.agent,
		reviewerAgent: settings.review.agent,
		reviewerResume: settings.review.resumeReviewer !== false,
		runTimeoutMs: settings.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
		resumeMaxWindowPeak: settings.resumeMaxWindowPeak ?? DEFAULT_RESUME_MAX_WINDOW_PEAK,
		resumeMaxDepth: settings.resumeMaxDepth ?? DEFAULT_RESUME_MAX_DEPTH,
		workerModel: settings.worker.model,
		workerThinking: settings.worker.thinking,
		...(settings.worker.fixModel ? { fixModel: settings.worker.fixModel } : {}),
		...(settings.worker.fixThinking ? { fixThinking: settings.worker.fixThinking } : {}),
		reviewerModel: settings.reviewer.model,
		reviewerThinking: settings.reviewer.thinking,
		gates: { card: [...settings.gates.card], program: [...settings.gates.program] },
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		laneBranchPattern: settings.laneBranchPattern,
		atlas: {
			enabled: settings.atlas?.enabled ?? true,
			agent: settings.atlas?.agent ?? "scout",
			...(settings.atlas?.model ? { model: settings.atlas.model } : {}),
			...(settings.atlas?.thinking ? { thinking: settings.atlas.thinking } : {}),
			pendingMerges: [],
			refreshes: 0,
		},
		cards,
		order,
		mergeQueue: [],
		decisions: [],
		createdAt: input.existing?.createdAt ?? Date.now(),
		updatedAt: Date.now(),
	};
}

export function configOverridesFromPlan(planText: string): ProgramConfigOverrides {
	const raw = parsePlanConfig(planText);
	const overrides: ProgramConfigOverrides = {};
	if (typeof raw.mode === "string") overrides.mode = raw.mode as ProgramConfigOverrides["mode"];
	if (typeof raw.maxParallel === "number") overrides.maxParallel = raw.maxParallel;
	if (typeof raw.parallelExecution === "string") {
		overrides.parallelExecution = raw.parallelExecution as ProgramConfigOverrides["parallelExecution"];
	}
	if (typeof raw.reviewProfile === "string") {
		overrides.reviewProfile = raw.reviewProfile as ProgramConfigOverrides["reviewProfile"];
	}
	if (typeof raw.maxCycles === "number") overrides.maxCycles = raw.maxCycles;
	if (typeof raw.laneBranchPattern === "string") overrides.laneBranchPattern = raw.laneBranchPattern;
	const review = isPlainRecord(raw.review) ? raw.review : undefined;
	if (review) {
		if (typeof review.profile === "string") overrides.reviewProfile = review.profile as ProgramConfigOverrides["reviewProfile"];
		if (typeof review.maxCycles === "number") overrides.maxCycles = review.maxCycles;
		if (typeof review.resumeReviewer === "boolean") overrides.reviewerResume = review.resumeReviewer;
	}
	const worker = isPlainRecord(raw.worker) ? raw.worker : undefined;
	if (worker) {
		if (typeof worker.agent === "string") overrides.workerAgent = worker.agent;
		if (typeof worker.model === "string") overrides.workerModel = worker.model;
		if (typeof worker.thinking === "string") overrides.workerThinking = worker.thinking;
		if (typeof worker.fixModel === "string") overrides.fixModel = worker.fixModel;
		if (typeof worker.fixThinking === "string") overrides.fixThinking = worker.fixThinking;
	}
	const reviewer = isPlainRecord(raw.reviewer) ? raw.reviewer : undefined;
	if (reviewer) {
		if (typeof reviewer.agent === "string") overrides.reviewerAgent = reviewer.agent;
		if (typeof reviewer.model === "string") overrides.reviewerModel = reviewer.model;
		if (typeof reviewer.thinking === "string") overrides.reviewerThinking = reviewer.thinking;
	}
	if (typeof raw.runTimeoutMs === "number") overrides.runTimeoutMs = raw.runTimeoutMs;
	if (typeof raw.resumeMaxWindowPeak === "number") overrides.resumeMaxWindowPeak = raw.resumeMaxWindowPeak;
	if (typeof raw.resumeMaxDepth === "number") overrides.resumeMaxDepth = raw.resumeMaxDepth;
	const gates = isPlainRecord(raw.gates) ? raw.gates : undefined;
	if (gates) {
		const card = Array.isArray(gates.card) ? gates.card.filter((v): v is string => typeof v === "string") : undefined;
		const program = Array.isArray(gates.program)
			? gates.program.filter((v): v is string => typeof v === "string")
			: undefined;
		overrides.gates = { ...(card ? { card } : {}), ...(program ? { program } : {}) };
	}
	const atlas = isPlainRecord(raw.atlas) ? raw.atlas : undefined;
	if (atlas) {
		if (typeof atlas.enabled === "boolean") overrides.atlasEnabled = atlas.enabled;
		if (typeof atlas.agent === "string") overrides.atlasAgent = atlas.agent;
		if (typeof atlas.model === "string") overrides.atlasModel = atlas.model;
		if (typeof atlas.thinking === "string") overrides.atlasThinking = atlas.thinking;
	}
	return overrides;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Per-card effective values: card front matter wins, program ledger is the fallback. */
export function effectiveReviewProfile(ledger: ProgramLedger, card: CardLedger): ProgramLedger["reviewProfile"] {
	return card.reviewProfile ?? ledger.reviewProfile;
}

export function effectiveMaxCycles(ledger: ProgramLedger, card: CardLedger): number {
	return card.maxCycles ?? ledger.maxCycles;
}

export function effectiveWorkerAgent(ledger: ProgramLedger, card: CardLedger): string {
	return card.workerAgent ?? ledger.workerAgent;
}

export function effectiveWorkerModel(ledger: ProgramLedger, card: CardLedger): string | undefined {
	return card.workerModel ?? ledger.workerModel;
}

export function effectiveWorkerThinking(ledger: ProgramLedger, card: CardLedger): string | undefined {
	return card.workerThinking ?? ledger.workerThinking;
}

/** Thinking level for FRESH fix dispatches (resumed fixes keep the retained child's own).
 *  Falls back to the worker lane so an unset key changes nothing. */
export function effectiveFixThinking(ledger: ProgramLedger, card: CardLedger): string | undefined {
	return card.fixThinking ?? ledger.fixThinking ?? effectiveWorkerThinking(ledger, card);
}

/** Model for FRESH fix dispatches; see {@link effectiveFixThinking}. */
export function effectiveFixModel(ledger: ProgramLedger, card: CardLedger): string | undefined {
	return card.fixModel ?? ledger.fixModel ?? effectiveWorkerModel(ledger, card);
}

export function effectiveReviewerAgent(ledger: ProgramLedger, card: CardLedger): string {
	return card.reviewerAgent ?? ledger.reviewerAgent;
}

export function effectiveReviewerModel(ledger: ProgramLedger, card: CardLedger): string | undefined {
	return card.reviewerModel ?? ledger.reviewerModel;
}

export function effectiveReviewerThinking(ledger: ProgramLedger, card: CardLedger): string | undefined {
	return card.reviewerThinking ?? ledger.reviewerThinking;
}

/** True when the card's review cycles should resume the same reviewer session. */
export function effectiveReviewerResume(ledger: ProgramLedger): boolean {
	return ledger.reviewerResume !== false;
}

/** Gate commands for a card: its front-matter `gates` win over the program default. */
export function effectiveCardGates(ledger: ProgramLedger, card: CardLedger): string[] {
	return card.gateCommands ?? ledger.gates.card;
}

/** Wall-clock timeout for card-run dispatches (ledger value, else the 4h default). */
export function effectiveRunTimeoutMs(ledger: ProgramLedger): number {
	return ledger.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
}

/** Context-peak threshold above which a retained session is abandoned for a fresh dispatch. */
export function effectiveResumeMaxWindowPeak(ledger: ProgramLedger): number {
	return ledger.resumeMaxWindowPeak ?? DEFAULT_RESUME_MAX_WINDOW_PEAK;
}

/** Consecutive-resume cap for one session before a fresh dispatch. */
export function effectiveResumeMaxDepth(ledger: ProgramLedger): number {
	return ledger.resumeMaxDepth ?? DEFAULT_RESUME_MAX_DEPTH;
}

/**
 * Fill ledger fields introduced after the ledger was first written (called when
 * a program is activated or started). Returns true when anything changed.
 */
export function migrateLedger(ledger: ProgramLedger, settings: WorkProgramSettings): boolean {
	let changed = false;
	if (ledger.reviewerResume === undefined) {
		ledger.reviewerResume = settings.review.resumeReviewer !== false;
		changed = true;
	}
	if (ledger.runTimeoutMs === undefined) {
		ledger.runTimeoutMs = settings.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
		changed = true;
	}
	if (ledger.resumeMaxWindowPeak === undefined) {
		ledger.resumeMaxWindowPeak = settings.resumeMaxWindowPeak ?? DEFAULT_RESUME_MAX_WINDOW_PEAK;
		changed = true;
	}
	if (ledger.resumeMaxDepth === undefined) {
		ledger.resumeMaxDepth = settings.resumeMaxDepth ?? DEFAULT_RESUME_MAX_DEPTH;
		changed = true;
	}
	// The builtin pi-subagents "reviewer" has no bash and cannot run gates;
	// the shipped work-program-reviewer replaced it as the default. An explicit
	// settings choice of the builtin agent (settings.review.agent) is respected.
	if (ledger.reviewerAgent === "reviewer" && settings.review.agent !== "reviewer") {
		ledger.reviewerAgent = "work-program-reviewer";
		changed = true;
	}
	// The builtin pi-subagents "worker" prompt carries no context/read discipline;
	// the shipped work-program-worker replaced it as the default. An explicit
	// settings choice of the builtin agent (settings.worker.agent) is respected.
	if (ledger.workerAgent === "worker" && settings.worker.agent !== "worker") {
		ledger.workerAgent = "work-program-worker";
		changed = true;
	}
	if (!ledger.atlas) {
		ledger.atlas = {
			enabled: settings.atlas?.enabled ?? true,
			agent: settings.atlas?.agent ?? "scout",
			...(settings.atlas?.model ? { model: settings.atlas.model } : {}),
			...(settings.atlas?.thinking ? { thinking: settings.atlas.thinking } : {}),
			pendingMerges: [],
			refreshes: 0,
		};
		changed = true;
	}
	return changed;
}


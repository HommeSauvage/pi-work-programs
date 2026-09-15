import { join, resolve } from "node:path";
import { LEDGER_FILE, PROGRESS_FILE, REVIEWS_DIR, RUNTIME_DIR } from "../constants.ts";
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
		workerModel: settings.worker.model,
		workerThinking: settings.worker.thinking,
		reviewerModel: settings.reviewer.model,
		reviewerThinking: settings.reviewer.thinking,
		gates: { card: [...settings.gates.card], program: [...settings.gates.program] },
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		laneBranchPattern: settings.laneBranchPattern,
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
	}
	const worker = isPlainRecord(raw.worker) ? raw.worker : undefined;
	if (worker) {
		if (typeof worker.agent === "string") overrides.workerAgent = worker.agent;
		if (typeof worker.model === "string") overrides.workerModel = worker.model;
		if (typeof worker.thinking === "string") overrides.workerThinking = worker.thinking;
	}
	const reviewer = isPlainRecord(raw.reviewer) ? raw.reviewer : undefined;
	if (reviewer) {
		if (typeof reviewer.agent === "string") overrides.reviewerAgent = reviewer.agent;
		if (typeof reviewer.model === "string") overrides.reviewerModel = reviewer.model;
		if (typeof reviewer.thinking === "string") overrides.reviewerThinking = reviewer.thinking;
	}
	const gates = isPlainRecord(raw.gates) ? raw.gates : undefined;
	if (gates) {
		const card = Array.isArray(gates.card) ? gates.card.filter((v): v is string => typeof v === "string") : undefined;
		const program = Array.isArray(gates.program)
			? gates.program.filter((v): v is string => typeof v === "string")
			: undefined;
		overrides.gates = { ...(card ? { card } : {}), ...(program ? { program } : {}) };
	}
	return overrides;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}


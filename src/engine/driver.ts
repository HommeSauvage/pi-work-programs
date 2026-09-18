import { loadResources } from "../protocol/resources.ts";
import { PACKET_WAKE_FORCE_AGE_MS, PACKET_WAKE_MIN_AGE_MS, SCOUT_TIMEOUT_MS } from "../constants.ts";
import {
	captainBrief,
	fixBrief,
	gateFixBrief,
	reReviewBrief,
	reconcilerBrief,
	reviewTask,
	scoutBrief,
	scoutRefreshBrief,
	workerBrief,
} from "../protocol/briefs.ts";
import { appendHarnessEvidence, gateEvidenceLines, setCardState } from "../program/card-edit.ts";
import {
	atlasPath,
	effectiveCardGates,
	effectiveMaxCycles,
	effectiveResumeMaxDepth,
	effectiveResumeMaxWindowPeak,
	effectiveReviewerAgent,
	effectiveReviewerModel,
	effectiveReviewerResume,
	effectiveReviewerThinking,
	effectiveReviewProfile,
	effectiveRunTimeoutMs,
	effectiveWorkerAgent,
	effectiveWorkerModel,
	effectiveWorkerThinking,
	laneBranch,
	reviewPath,
} from "../program/ledger.ts";
import {
	emptyTodoStore,
	ensureOperatorTodoFile,
	importInboxTodos,
	openTodos,
	operatorTodoPath,
	operatorTodosJsonPath,
	parseTodoStore,
	serializeTodoStore,
	type OperatorTodoItem,
	type TodoItem,
	type TodoStore,
} from "../program/operator-todos.ts";
import { parseEvidence } from "../program/parse.ts";
import { oneLine, formatTokens, truncateTail } from "../shared/text.ts";
import type {
	ActiveRunKind,
	CardLedger,
	CardSessionUsage,
	DriverPorts,
	FindingVerdict,
	GateResult,
	ProgramLedger,
	RunStatus,
	RunUsage,
} from "../shared/types.ts";
import {
	blockedDecisionMessage,
	cancelOpenDecisionsFor,
	createDecision,
	cycleDecisionMessage,
	packetText,
	programCompleteMessage,
	programGateDecisionMessage,
	resolveDecision,
	reviewDecisionMessage,
} from "./decisions.ts";
import {
	describeOpenDecisions,
	isAbandonedCard,
	isHeld,
	openDecisionFor,
	openDecisionOfKind,
	openDecisions,
	readyCards,
	writersInFlight,
} from "./phases.ts";

const UNKNOWN_RUN_GRACE_MS = 10 * 60_000;

/** Per-card cap on recorded per-run usage entries (aggregate keeps accumulating). */
const MAX_USAGE_RUNS = 24;

/** Merge one run's usage into an aggregate, keeping optional fields only when present. */
function mergeUsage(acc: RunUsage | undefined, usage: RunUsage): RunUsage {
	const merged: RunUsage = {
		input: (acc?.input ?? 0) + usage.input,
		output: (acc?.output ?? 0) + usage.output,
		total: (acc?.total ?? 0) + usage.total,
	};
	const windowPeak = Math.max(acc?.windowPeak ?? 0, usage.windowPeak ?? 0);
	if (windowPeak > 0) merged.windowPeak = windowPeak;
	const costUsd = (acc?.costUsd ?? 0) + (usage.costUsd ?? 0);
	if (costUsd > 0) merged.costUsd = costUsd;
	const turns = (acc?.turns ?? 0) + (usage.turns ?? 0);
	if (turns > 0) merged.turns = turns;
	const tools = (acc?.tools ?? 0) + (usage.tools ?? 0);
	if (tools > 0) merged.tools = tools;
	const cacheRead = (acc?.cacheRead ?? 0) + (usage.cacheRead ?? 0);
	if (cacheRead > 0) merged.cacheRead = cacheRead;
	const cacheWrite = (acc?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0);
	if (cacheWrite > 0) merged.cacheWrite = cacheWrite;
	return merged;
}

/** Sum session snapshots into the card aggregate (resume-safe: one row per session). */
function aggregateSessions(sessions: CardSessionUsage[]): RunUsage | undefined {
	if (sessions.length === 0) return undefined;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let total = 0;
	let costUsd = 0;
	let turns = 0;
	let tools = 0;
	let peak = 0;
	for (const session of sessions) {
		input += session.input;
		output += session.output;
		cacheRead += session.cacheRead;
		cacheWrite += session.cacheWrite;
		total += session.total;
		costUsd += session.costUsd ?? 0;
		turns += session.turns ?? 0;
		tools += session.tools ?? 0;
		peak = Math.max(peak, session.windowPeak ?? 0);
	}
	const aggregate: RunUsage = { input, output, total };
	if (cacheRead > 0) aggregate.cacheRead = cacheRead;
	if (cacheWrite > 0) aggregate.cacheWrite = cacheWrite;
	if (turns > 0) aggregate.turns = turns;
	if (tools > 0) aggregate.tools = tools;
	if (costUsd > 0) aggregate.costUsd = costUsd;
	if (peak > 0) aggregate.windowPeak = peak;
	return aggregate;
}

/**
 * Record a terminal run: a per-run history entry plus the session-accurate
 * cumulative snapshot. Resumed runs share their session key (status.json's
 * `sessionFile`), so the snapshot is REPLACED — never summed — and the card
 * aggregate stays truthful across resume chains. Token/cache numbers come from
 * the session transcript when available (status.json omits cache reads).
 */
function recordRunUsage(
	card: CardLedger,
	kind: ActiveRunKind,
	status: RunStatus,
	opts: { resumed?: boolean; runId?: string } = {},
): void {
	const session = status.sessionFile ?? opts.runId;
	const sessions = upsertSessionUsage(card.usageSessions ?? [], kind, status, opts.runId);
	if (sessions) {
		card.usageSessions = sessions;
		card.usage = aggregateSessions(sessions);
	} else if (status.usage) {
		card.usage = mergeUsage(card.usage, status.usage);
	}
	const runUsage = status.usage ?? status.sessionUsage;
	if (runUsage) {
		const runs = card.usageRuns ?? [];
		runs.push({
			...runUsage,
			kind,
			at: Date.now(),
			...(opts.resumed ? { resumed: true } : {}),
			...(session ? { session } : {}),
		});
		card.usageRuns = runs.slice(-MAX_USAGE_RUNS);
	}
}

/** Upsert one terminal run's session snapshot (resumed runs replace their session row). */
function upsertSessionUsage(
	sessions: CardSessionUsage[],
	kind: ActiveRunKind,
	status: RunStatus,
	runId?: string,
): CardSessionUsage[] | undefined {
	const session = status.sessionFile ?? runId;
	const sessionUsage = status.sessionUsage ?? status.usage;
	if (!session || !sessionUsage) return undefined;
	const windowPeak = status.usage?.windowPeak ?? status.sessionUsage?.windowPeak;
	const snapshot: CardSessionUsage = {
		session,
		kind,
		input: sessionUsage.input,
		output: sessionUsage.output,
		cacheRead: sessionUsage.cacheRead ?? 0,
		cacheWrite: sessionUsage.cacheWrite ?? 0,
		total: sessionUsage.total,
		...(sessionUsage.costUsd !== undefined ? { costUsd: sessionUsage.costUsd } : {}),
		...(windowPeak !== undefined ? { windowPeak } : {}),
		...(sessionUsage.turns !== undefined ? { turns: sessionUsage.turns } : {}),
		...(sessionUsage.tools !== undefined ? { tools: sessionUsage.tools } : {}),
		updatedAt: Date.now(),
	};
	const index = sessions.findIndex((entry) => entry.session === session);
	if (index >= 0) sessions[index] = snapshot;
	else sessions.push(snapshot);
	return sessions;
}

/** Latest session snapshot of a kind family (worker sessions end as worker|fix). */
function lastSessionFor(card: CardLedger, kind: "worker" | "reviewer" | "scout"): CardSessionUsage | undefined {
	const sessions = card.usageSessions ?? [];
	const kinds: ActiveRunKind[] = kind === "worker" ? ["worker", "fix"] : kind === "reviewer" ? ["reviewer"] : ["scout"];
	for (let index = sessions.length - 1; index >= 0; index -= 1) {
		const entry = sessions[index];
		if (entry && kinds.includes(entry.kind)) return entry;
	}
	return undefined;
}

/**
 * Decide whether to continue a retained session or dispatch fresh. Continuing
 * re-sends the whole history every turn: past the context-peak threshold or the
 * consecutive-resume cap, a fresh dispatch (which now starts atlas-armed) is
 * cheaper than one more round on top of a huge context.
 */
function resumeDecision(host: DriverHost, card: CardLedger, kind: "worker" | "reviewer"): { resume: boolean; reason?: string } {
	const limit = effectiveResumeMaxWindowPeak(host.ledger);
	const maxDepth = effectiveResumeMaxDepth(host.ledger);
	const depth = (kind === "worker" ? card.workerResumeDepth : card.reviewerResumeDepth) ?? 0;
	if (depth >= maxDepth) {
		return { resume: false, reason: `${depth} consecutive resumes (cap ${maxDepth})` };
	}
	const peak = lastSessionFor(card, kind)?.windowPeak;
	if (peak !== undefined && peak >= limit) {
		return { resume: false, reason: `session peaked at ${formatTokens(peak)} (limit ${formatTokens(limit)})` };
	}
	return { resume: true };
}

/** Compact usage label for progress lines and evidence: `71.0M tok (cache 68.1M) · 266 turns · $1.02`. */
function formatUsage(usage: RunUsage): string {
	const cache = usage.cacheRead !== undefined ? ` (cache ${formatTokens(usage.cacheRead)})` : "";
	const parts = [`${formatTokens(usage.total)} tok${cache}`];
	if (usage.turns !== undefined) parts.push(`${usage.turns} turns`);
	if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
	return parts.join(" · ");
}

export interface DriverHost {
	cwd: string;
	programDir: string;
	ledger: ProgramLedger;
	ports: DriverPorts;
	save(): Promise<void>;
	refreshUi(): void;
}

const TERMINAL_STATES = new Set(["complete", "failed", "stopped", "paused", "rejected", "not_found"]);
const MAX_RUN_INFRA_RETRIES = 2;
const MAX_MERGE_COMMIT_FAILURES = 5;
/** Passes per drive tick: a merge frees dependencies, which enables dispatches,
 *  which may free more merges. Bounded so one tick can never loop forever. */
const MAX_DRIVE_PASSES = 8;

/**
 * Cheap state signature for the drain loop: phases, live runs, dropped flags,
 * and the merge queue. Deliberately excludes lastError and attempt counters so
 * a parked retry does not re-enter the loop within the same tick.
 */
function stateSignature(host: DriverHost): string {
	const cards = host.ledger.order
		.map((id) => {
			const card = host.ledger.cards[id];
			if (!card) return `${id}?`;
			return `${id}:${card.phase}:${card.activeRun?.runId ?? "-"}:${card.abandoned === true ? "A" : "-"}`;
		})
		.join("|");
	return `${cards}#${host.ledger.mergeQueue.join(",")}#${host.ledger.status}#${host.ledger.atlas?.state ?? ""}:${host.ledger.atlas?.pendingMerges.length ?? 0}`;
}
const CAPTAIN_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		verdict: { type: "string" },
		commit: { type: "string" },
		reviewPath: { type: "string" },
		cycles: { type: "number" },
		findings: { type: "object" },
		gates: { type: "array" },
		blockers: { type: "array", items: { type: "string" } },
	},
	required: ["verdict"],
	additionalProperties: true,
};

function ledgerCards(ledger: ProgramLedger): CardLedger[] {
	return ledger.order
		.map((id) => ledger.cards[id])
		.filter((card): card is CardLedger => card !== undefined);
}

function cardPath(host: DriverHost, card: CardLedger): string {
	return `${host.programDir}/${card.path}`;
}

function planPath(host: DriverHost): string {
	return `${host.programDir}/plan.md`;
}

async function readCardText(host: DriverHost, card: CardLedger): Promise<string> {
	return host.ports.readCard(host.ledger, card);
}

async function writeCardText(host: DriverHost, card: CardLedger, text: string): Promise<void> {
	await host.ports.writeCard(host.ledger, card, text);
}

async function progress(host: DriverHost, line: string): Promise<void> {
	const match = /^(\S+)\s+(.*)$/.exec(line);
	const formatted = match ? `[card ${match[1]}] ${match[2]}` : `[program] ${line}`;
	await host.ports.appendProgress(formatted);
}

/** Program-level (not card-scoped) events: scout builds, atlas refreshes. */
async function progressProgram(host: DriverHost, line: string): Promise<void> {
	await host.ports.appendProgress(`[program] ${line}`);
}

async function runCardGates(host: DriverHost, card: CardLedger, cwd: string): Promise<{ ok: boolean; gates: GateResult[] }> {
	const commands = effectiveCardGates(host.ledger, card);
	const gates: GateResult[] = [];
	if (commands.length === 0) {
		card.gates = [];
		return { ok: true, gates };
	}
	card.phase = "verifying";
	await host.save();
	for (const command of commands) {
		const result = await host.ports.gates.run(command, cwd);
		gates.push(result);
	}
	card.gates = gates;
	return { ok: gates.every((gate) => gate.code === 0), gates };
}

function gateFailures(gates: GateResult[]): string[] {
	return gates.filter((gate) => gate.code !== 0).map((gate) => `${gate.command} (exit ${gate.code})`);
}

function isTerminal(status: RunStatus): boolean {
	return TERMINAL_STATES.has(status.state);
}

function activeRunOf(card: CardLedger): { kind: string; runId: string; asyncDir?: string; resumed?: boolean } | undefined {
	const active = card.activeRun;
	if (!active) return undefined;
	return {
		kind: active.kind,
		runId: active.runId,
		...(active.asyncDir ? { asyncDir: active.asyncDir } : {}),
		...(active.resumed ? { resumed: active.resumed } : {}),
	};
}

export async function drive(host: DriverHost): Promise<void> {
	const { ledger, ports } = host;
	if (ledger.status !== "active") return;
	if (!ports.runs.available()) {
		ports.notify("pi-subagents is not available; work program loop is paused", "warning");
		return;
	}

	try {
		// Drain until quiescent: completing a card (a merge, a review) changes what
		// is dispatchable, so a single pass can leave ready work stranded with no
		// event left to trigger another tick.
		// Cards whose merge was already attempted this tick: a parked failure must
		// wait for the next tick instead of retrying immediately.
		const gate = await syncTodoStore(host);
		const attemptedMerges = new Set<string>();
		for (let pass = 0; pass < MAX_DRIVE_PASSES; pass += 1) {
			const before = stateSignature(host);
			await reconcileRuns(host, gate);
			await reconcileScout(host);
			await resolveStaleBlocks(host);
			await resumeWaitingCards(host, gate);
			await ensureScout(host);
			if (ledger.mode === "managed" || ledger.mode === "captain") {
				await dispatchReadyCards(host, gate);
				await dispatchReviews(host, gate);
				await dispatchFixes(host, gate);
			}
			await finishApprovedCards(host, gate);
			await ensurePackets(host);
			await processMergeQueue(host, gate, attemptedMerges);
			await maybeRefreshAtlas(host);
			if (stateSignature(host) === before) break;
		}
		await maybeRunProgramGate(host);
		await host.save();
	} catch (error) {
		// Durable trace, not just a toast: the next session (or a `status` call)
		// must be able to see why the drive is wedged.
		const message = error instanceof Error ? error.message : String(error);
		ports.notify(`Work program drive error: ${oneLine(message, 120)}`, "error");
		await ports.appendProgress(`[program] drive error: ${oneLine(message, 120)}`).catch(() => undefined);
		await host.save().catch(() => undefined);
	}
	host.refreshUi();
}

async function reconcileRuns(host: DriverHost, gate: TodoGate): Promise<void> {
	for (const card of ledgerCards(host.ledger)) {
		const active = activeRunOf(card);
		if (!active) continue;
		const status = await host.ports.runs.status(active.runId, active.asyncDir);
		if (status.state === "unknown") {
			const startedAt = card.activeRun?.startedAt ?? 0;
			if (startedAt > 0 && Date.now() - startedAt > UNKNOWN_RUN_GRACE_MS) {
				card.activeRun = undefined;
				await blockCard(host, card, `run ${active.runId} state could not be determined; needs a decision`);
				await host.save();
			}
			continue;
		}
		if (!isTerminal(status)) continue;
		card.activeRun = undefined;
		const resumed = active.resumed === true;
		switch (active.kind) {
			case "worker":
				await onWorkerComplete(host, gate, card, status, active.runId, resumed);
				break;
			case "reviewer":
				await onReviewerComplete(host, card, status, active.runId, resumed);
				break;
			case "fix":
				await onFixComplete(host, gate, card, status, active.runId, resumed);
				break;
			case "captain":
				await onCaptainComplete(host, gate, card, status, active.runId, resumed);
				break;
			case "reconciler":
				await onReconcilerComplete(host, gate, card, status, active.runId, resumed);
				break;
		}
		await host.save();
	}
}

async function blockCard(host: DriverHost, card: CardLedger, reason: string): Promise<void> {
	if (card.phase !== "blocked") card.blockedFrom = card.phase;
	card.phase = "blocked";
	card.lastError = reason;
	cancelOpenDecisionsFor(host, card.id, reason);
	createDecision(host, {
		kind: "blocked",
		card: card.id,
		message: blockedDecisionMessage(card.id, reason),
		expectedAction: `work_program({ action: "unblock", card: "${card.id}", resolution: "redispatch" | "done" | "abandon" })`,
	});
	await progress(host, `${card.id} blocked: ${oneLine(reason, 100)}`);
	host.ports.notify(`Work program: card ${card.id} blocked — ${oneLine(reason, 100)}`, "error");
}

/* ---------------------------------------------------------------------------
 * Operator todos: structured waiting
 *
 * `.operator/todos.json` is the single source of truth (extension-owned).
 * `.operator/todo.md` is only the workers' append-only inbox — subagent
 * children have no tools, so they cannot call the todo actions; the drive
 * imports new inbox entries here automatically. A blocking todo that names a
 * card parks it: dispatches skip it, completions park instead of advancing,
 * and `todo_done` / `todo_drop` rearm it automatically.
 * ------------------------------------------------------------------------- */

export const WAITING_PREFIX = "waiting on operator";

/** Phases a card may be parked from without losing decision or merge state. */
const PARKABLE_PHASES = new Set(["pending", "ready", "review_pending", "approved", "queued"]);

function parkablePhase(card: CardLedger): boolean {
	if (PARKABLE_PHASES.has(card.phase)) return true;
	// A fix that has not dispatched yet keeps its intent via blockedFrom.
	return card.phase === "fixing" && !card.activeRun;
}

export function waitingReason(items: TodoItem[]): string {
	const first = items[0];
	const base = first ? `${WAITING_PREFIX} todo ${first.id}: ${oneLine(first.title, 90)}` : WAITING_PREFIX;
	return items.length > 1 ? `${base} (+${items.length - 1} more)` : base;
}

export interface TodoGate {
	store: TodoStore;
	stream: string;
	/** Open blocking todos by card id (active stream only). */
	byCard: Map<string, TodoItem[]>;
	/** True when the store file must be (re)written. */
	dirty: boolean;
}

export function buildTodoGate(store: TodoStore, stream: string): TodoGate {
	const byCard = new Map<string, TodoItem[]>();
	for (const item of store.items) {
		if (item.stream !== stream || item.state !== "open" || !item.blocking || !item.card) continue;
		const list = byCard.get(item.card) ?? [];
		list.push(item);
		byCard.set(item.card, list);
	}
	return { store, stream, byCard, dirty: false };
}

export function todosBlockingCard(gate: TodoGate, cardId: string): TodoItem[] {
	return gate.byCard.get(cardId) ?? [];
}

function todoAskText(ledger: ProgramLedger, card: CardLedger, items: TodoItem[]): string {
	const lines = [
		`[WORK PROGRAM] Card ${card.id} needs a human before it can proceed (${ledger.slug}).`,
		"",
	];
	for (const item of items.slice(0, 3)) {
		lines.push(`${item.id}: ${item.title}`);
		if (item.body) lines.push(oneLine(item.body, 220));
		for (const step of item.steps.slice(0, 6)) {
			lines.push(`- ${oneLine(step.text, 160)}${step.command ? ` — \`${step.command}\`` : ""}${step.dangerous ? " (STOP — may fail dangerously)" : ""}`);
		}
		lines.push(`When finished: work_program({ action: "todo_done", id: "${item.id}" }) — the card resumes on its own. To rewrite it first: work_program({ action: "todo_update", id: "${item.id}", title: "...", steps: [{ "text": "..." }] }).`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Park a card on open blocking todos. Quiescent cards transition to blocked
 * (decision points at `todo_done`); in-flight cards only record `waitingOn`
 * and the completion guards park them when the run lands.
 */
export async function parkForTodos(
	host: DriverHost,
	gate: TodoGate,
	card: CardLedger,
	items: TodoItem[],
	opts: { announce?: boolean; force?: boolean } = {},
): Promise<void> {
	if (items.length === 0) return;
	const ids = items.map((item) => item.id);
	card.waitingOn = Array.from(new Set([...(card.waitingOn ?? []), ...ids]));
	// Completion paths force the transition (the run has landed, so no decision
	// or merge is in flight); everywhere else only quiescent phases move.
	if (!opts.force && !parkablePhase(card)) {
		if (opts.announce === true) {
			host.ports.notify(`Work program: card ${card.id} will wait on operator todo ${ids.join(", ")} once its run lands`, "warning");
			host.ports.ask(todoAskText(host.ledger, card, items));
		}
		await host.save();
		return;
	}
	if (card.phase !== "blocked") card.blockedFrom = card.phase;
	card.phase = "blocked";
	card.lastError = waitingReason(items);
	cancelOpenDecisionsFor(host, card.id, card.lastError);
	createDecision(host, {
		kind: "blocked",
		card: card.id,
		message: `Card ${card.id} is ${card.lastError}.`,
		expectedAction: `work_program({ action: "todo_done", id: "${ids[0]}" }) when finished${ids.length > 1 ? ` (also ${ids.slice(1).join(", ")})` : ""} — or work_program({ action: "unblock", card: "${card.id}", resolution: "redispatch" }) to override`,
	});
	if (opts.announce === true) {
		const decision = openDecisionFor(host.ledger, card.id);
		if (decision) decision.packetSent = true;
	}
	await progress(host, `${card.id} waiting: ${ids.join(" ")}`);
	host.ports.notify(`Work program: card ${card.id} is waiting on operator todo ${ids.join(", ")} — ${oneLine(items[0]?.title ?? "", 90)}`, "warning");
	if (opts.announce === true) host.ports.ask(todoAskText(host.ledger, card, items));
	await host.save();
}

/**
 * Rearm cards whose blocking todos are all resolved, and park quiescent cards
 * that newly show open blocking todos. Covers tool mutations and hand-edited
 * JSON alike — the store is truth, the ledger follows.
 */
export async function resumeWaitingCards(host: DriverHost, gate: TodoGate): Promise<void> {
	for (const card of ledgerCards(host.ledger)) {
		if (isAbandonedCard(card)) {
			delete card.waitingOn;
			continue;
		}
		const open = todosBlockingCard(gate, card.id);
		if (open.length > 0) {
			card.waitingOn = open.map((item) => item.id);
			if (!(card.phase === "blocked" && card.lastError?.startsWith(WAITING_PREFIX))) {
				await parkForTodos(host, gate, card, open, {});
			}
			continue;
		}
		if (!card.waitingOn || card.waitingOn.length === 0) continue;
		delete card.waitingOn;
		if (card.merge?.state === "merged") {
			const decision = openDecisionFor(host.ledger, card.id);
			if (decision) resolveDecision(host, decision.id);
			card.lastError = undefined;
			await finishManualMerge(host, card);
			await progress(host, `${card.id} todos resolved — merge finalized`);
			continue;
		}
		if (card.phase === "blocked" && card.lastError?.startsWith(WAITING_PREFIX)) {
			const from = card.blockedFrom;
			card.phase =
				from === "reviewing"
					? "review_pending"
					: from === "verifying" || from === "fixing"
						? "fixing"
						: from === "approved" || from === "queued"
							? "approved"
							: "pending";
			card.blockedFrom = undefined;
			card.lastError = undefined;
			const decision = openDecisionFor(host.ledger, card.id);
			if (decision) resolveDecision(host, decision.id);
			await progress(host, `${card.id} todos resolved → ${card.phase}`);
		}
	}
	await host.save();
}

async function ensureTodoStoreFile(host: DriverHost): Promise<TodoStore> {
	const path = operatorTodosJsonPath(host.cwd);
	let raw = "";
	try {
		raw = await host.ports.readFile(path);
	} catch {
		raw = "";
	}
	if (raw.trim().length > 0) return parseTodoStore(raw);
	const store = emptyTodoStore();
	await host.ports.writeFile(path, serializeTodoStore(store));
	return store;
}

/**
 * Load the todo store, import new worker-inbox entries, persist when changed,
 * and park + announce for brand-new blocking todos. Once per drive tick.
 */
export async function syncTodoStore(host: DriverHost): Promise<TodoGate> {
	const store = await ensureTodoStoreFile(host);
	let dirty = false;
	let md = "";
	try {
		md = await host.ports.readFile(operatorTodoPath(host.cwd));
	} catch {
		md = "";
	}
	if (md.trim().length > 0) {
		const result = importInboxTodos(md, store, (cardId) => {
			const card = host.ledger.cards[cardId];
			return card !== undefined && card.phase !== "done" && !isAbandonedCard(card);
		});
		if (result.imported > 0) dirty = true;
	}
	// Announce open unannounced items of this stream — covers fresh imports and
	// items another program's session imported first (hashes are global).
	const gate = buildTodoGate(store, host.ledger.slug);
	const announcedCards = new Set<string>();
	for (const item of store.items) {
		if (item.stream !== host.ledger.slug || item.state !== "open" || item.announced === true) continue;
		item.announced = true;
		dirty = true;
		if (item.blocking && item.card) {
			if (announcedCards.has(item.card)) continue;
			announcedCards.add(item.card);
			const card = host.ledger.cards[item.card];
			if (card && !isAbandonedCard(card)) {
				await parkForTodos(host, gate, card, todosBlockingCard(gate, item.card), { announce: true });
			}
		} else {
			host.ports.notify(`Work program: new operator todo ${item.id}: ${oneLine(item.title, 100)}`, "info");
		}
	}
	if (dirty) {
		await host.ports.writeFile(operatorTodosJsonPath(host.cwd), serializeTodoStore(store));
		await host.save();
	}
	return buildTodoGate(store, host.ledger.slug);
}

/**
 * Runner/transport/provider blips — never a code failure, so retrying is safe.
 * Covers runner startup control timeouts, RPC/socket errors, and provider
 * outages ("Inference admission is unavailable", 502/503/504, capacity).
 */
export function isInfraError(error: unknown): boolean {
	return /timed out|timeout|runner startup|control .confirm|no run id|ECONN|EPIPE|EAI_AGAIN|socket hang up|(?:un)?available|overloaded|admission|capacity|outage|\b50[234]\b|server error|upstream/i.test(
		String(error),
	);
}

const QUOTA_PATTERN = /usage limit|usage_limit|rate.?limit|quota|GoUsageLimit|\b429\b/i;
/** Anchor phrases that introduce a reset delay — never match bare window names
 *  like "5-hour usage limit", which would read as a five-hour wait. */
const RESET_ANCHOR = /(?:resets?(?:\s+at|\s+in)?|retry(?:\s+in|\s+after)?|try again(?:\s+in)?|available(?:\s+in|\s+at)?|wait)\s*[:~≈]?\s*([^.;\n]{1,40})/i;
const HOURS_RE = /(\d+)\s*(?:hours|hour|hrs|hr|h)(?![a-z])/i;
const MINUTES_RE = /(\d+)\s*(?:minutes|minute|mins|min|m)(?![a-z])/i;
const SECONDS_RE = /(\d+)\s*(?:seconds|second|secs|sec|s)(?![a-z])/i;

/** Individual hold ceiling; longer reported waits are still held, then extended. */
export const MAX_QUOTA_HOLD_MS = 90 * 60_000;
const QUOTA_HOLD_SLACK_MS = 60_000;
const MAX_QUOTA_HOLDS = 3;

export interface QuotaHold {
	holdMs: number;
	/** The parsed reset fragment, quoted back so the operator can judge wait-vs-switch. */
	hint: string;
	reason: string;
}

/**
 * Classify a provider quota/rate-limit run failure and parse its reset hint.
 * Returns undefined for non-quota errors and for quota errors with no parseable
 * delay (those block as before, with the raw error text).
 */
export function classifyQuota(error: string): QuotaHold | undefined {
	const text = error.trim();
	if (text.length === 0 || !QUOTA_PATTERN.test(text)) return undefined;
	const anchored = RESET_ANCHOR.exec(text);
	if (!anchored) return undefined;
	const fragment = (anchored[1] ?? "").trim();
	if (fragment.length === 0) return undefined;
	const hours = Number(HOURS_RE.exec(fragment)?.[1] ?? 0);
	const minutes = Number(MINUTES_RE.exec(fragment)?.[1] ?? 0);
	const seconds = Number(SECONDS_RE.exec(fragment)?.[1] ?? 0);
	const raw = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000;
	if (raw <= 0) return undefined;
	const holdMs = Math.min(raw + QUOTA_HOLD_SLACK_MS, MAX_QUOTA_HOLD_MS);
	return {
		holdMs,
		hint: fragment,
		reason: `quota exhausted — parsed "${fragment}" from: ${oneLine(text, 140)}`,
	};
}

/**
 * Park a card until the provider's quota recovers instead of asking the
 * supervisor a question only "wait" can answer. Repeats (extending the hold)
 * up to a cap, then blocks with the reset time named.
 */
async function holdForQuota(host: DriverHost, card: CardLedger, quota: QuotaHold): Promise<boolean> {
	const attempts = (card.holdCount ?? 0) + 1;
	if (attempts > MAX_QUOTA_HOLDS) return false;
	card.holdCount = attempts;
	card.holdUntil = Date.now() + quota.holdMs;
	card.holdReason = quota.reason;
	card.activeRun = undefined;
	card.lastError = undefined;
	rearmCard(card);
	const until = new Date(card.holdUntil).toISOString().slice(11, 16);
	const detail = attempts > 1 ? `extended ${attempts}/${MAX_QUOTA_HOLDS} until ${until} UTC` : `held until ${until} UTC`;
	await progress(host, `${card.id} quota ${detail} (${quota.hint})`);
	await host.save();
	return true;
}

/**
 * Guards every operator-triggered path that would start an agent run. A pause
 * must mean "no new runs": the drive loop's own status check cannot cover
 * synchronous tool actions, which otherwise redispatch straight into an
 * exhausted quota.
 */
function requireActiveForDispatch(host: DriverHost): { ok: false; error: string } | undefined {
	if (host.ledger.status === "active") return undefined;
	return {
		ok: false,
		error: `program is ${host.ledger.status}; this would start a run — resume first (work_program({ action: "resume" })), or use a resolution that does not dispatch (done / abandon)`,
	};
}

/**
 * Drop a card's scope deliberately. Terminal, but never destructive: the
 * branch is kept for inspection, the record stays, and completion/close treat
 * it as resolved. Refuses while live cards still depend on it (rewire first),
 * while a run owns it, or when its lane holds uncommitted work.
 */
async function abandonCard(host: DriverHost, card: CardLedger): Promise<{ ok: boolean; error?: string }> {
	const cardId = card.id;
	if (card.activeRun) {
		return {
			ok: false,
			error: `card ${cardId} has a live ${card.activeRun.kind} run (${card.activeRun.runId}); stop it first (pause --hard) or wait for it`,
		};
	}
	const dependents = host.ledger.order.filter((id) => {
		if (id === cardId) return false;
		const other = host.ledger.cards[id];
		if (!other || other.phase === "done" || isAbandonedCard(other)) return false;
		return other.dependsOn.includes(cardId);
	});
	if (dependents.length > 0) {
		return {
			ok: false,
			error: `card ${cardId} is still a dependency of ${dependents.join(", ")}; rewire those cards (edit their front-matter \`dependsOn\` and sync) before abandoning it`,
		};
	}
	if (card.lane) {
		const dirty = await host.ports.git.statusPorcelain(card.lane.path).catch(() => "");
		if (dirty.trim().length > 0) {
			return {
				ok: false,
				error: `card ${cardId}'s lane has uncommitted work (${oneLine(dirty, 120)}); commit, stash, or discard it in ${card.lane.path} first`,
			};
		}
		const note = await releaseLane(host, card, { keepBranch: true });
		if (note) await progress(host, `${cardId} lane released`);
	}
	await host.ports.git.mergeAbort(host.cwd).catch(() => undefined);
	const index = host.ledger.mergeQueue.indexOf(cardId);
	if (index >= 0) host.ledger.mergeQueue.splice(index, 1);
	card.abandoned = true;
	card.phase = "blocked";
	card.activeRun = undefined;
	card.lastError = card.lastError ?? "abandoned by operator (scope dropped)";
	await progress(host, `${cardId} abandoned (branch kept)`);
	host.ports.notify(`Work program: card ${cardId} abandoned (scope dropped)`, "warning");
	return { ok: true };
}

/** Remove a lane worktree, optionally keeping the branch for inspection. */
async function releaseLane(host: DriverHost, card: CardLedger, opts: { keepBranch: boolean }): Promise<string | undefined> {
	const lane = card.lane;
	if (!lane) return undefined;
	try {
		await host.ports.git.worktreeRemove(host.cwd, lane.path);
		if (!opts.keepBranch) await host.ports.git.branchDelete(host.cwd, lane.branch).catch(() => undefined);
		card.lane = undefined;
		return `worktree removed, branch \`${lane.branch}\` kept`;
	} catch (error) {
		return `could not remove worktree ${lane.path}: ${oneLine(String(error), 120)}`;
	}
}

/**
 * Policy for a card file that disappeared from the plan. Drops only what is
 * safe: no live dependents, no live run, no lane holding work. Anything else
 * is kept and explained — never silently discarded. Dropping is additive to
 * `sync`, so a collapse (fold scope into survivors, rewire deps, delete files,
 * sync) works without hand-editing the ledger.
 */
export async function planCardRemoval(
	host: DriverHost,
	card: CardLedger,
): Promise<{ drop: boolean; reason?: string; note?: string }> {
	if (isAbandonedCard(card)) return { drop: true, note: "abandoned tombstone" };
	if (card.phase === "done") return { drop: false, reason: "done cards are records; deletion ignored" };
	if (["implementing", "reviewing", "fixing", "merging", "reconciling", "verifying"].includes(card.phase)) {
		return { drop: false, reason: `card is ${card.phase}; a run owns it` };
	}
	const dependents = host.ledger.order.filter((id) => {
		if (id === card.id) return false;
		const other = host.ledger.cards[id];
		if (!other || other.phase === "done" || isAbandonedCard(other)) return false;
		return other.dependsOn.includes(card.id);
	});
	if (dependents.length > 0) {
		return { drop: false, reason: `still a dependency of ${dependents.join(", ")}` };
	}
	if (card.lane) {
		const dirty = await host.ports.git.statusPorcelain(card.lane.path).catch(() => "");
		const committed = await host.ports.git.changedFiles(card.lane.path, card.lane.base, "HEAD").catch(() => ["?"]);
		if (dirty.trim().length > 0 || committed.length > 0) {
			return {
				drop: false,
				reason: `lane \`${card.lane.branch}\` holds work; inspect ${card.lane.path} (or abandon the card) before removing`,
			};
		}
		const note = await releaseLane(host, card, { keepBranch: false });
		return { drop: true, note: note ?? "empty lane cleaned" };
	}
	return { drop: true };
}

/**
 * Resolve `blocked` decisions whose card has already moved on (e.g. an
 * operator redispatch via `dispatch` advanced the card without resolving the
 * record). Stale records must never shadow later decisions or re-ask the
 * operator about a resolved block. Cards still blocked/reconciling keep theirs.
 */
async function resolveStaleBlocks(host: DriverHost): Promise<void> {
	let resolved = 0;
	for (const decision of host.ledger.decisions) {
		if (decision.status !== "open" || decision.kind !== "blocked" || !decision.card) continue;
		const card = host.ledger.cards[decision.card];
		if (!card) continue;
		if (card.phase === "blocked" || card.phase === "reconciling") continue;
		resolveDecision(host, decision.id);
		resolved += 1;
	}
	if (resolved > 0) await host.save();
}

/**
 * Dispatch with one immediate retry for infrastructure flakes (runner startup,
 * RPC timeouts). A failed dispatch creates no run, so a single retry is safe;
 * anything else blocks with detail instead of stalling the drive loop.
 */
async function dispatchWithInfraRetry(
	host: DriverHost,
	card: CardLedger,
	request: Parameters<typeof dispatchRun>[2],
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await dispatchRun(host, card, request);
		return { ok: true };
	} catch (error) {
		if (!isInfraError(error)) return { ok: false, error: oneLine(String(error), 200) };
		try {
			await dispatchRun(host, card, request);
			return { ok: true };
		} catch (retryError) {
			return {
				ok: false,
				error: `infra failure twice: ${oneLine(String(retryError), 160)} (first: ${oneLine(String(error), 120)})`,
			};
		}
	}
}

/**
 * Shared failure path for every run kind: hold while the provider's quota
 * recovers, retry runner-infra flakes for fixes, otherwise block with detail.
 * Returns true when the card was held or re-armed (no decision raised).
 */
async function handleRunFailure(
	host: DriverHost,
	card: CardLedger,
	status: RunStatus,
	runId: string,
	label: "worker" | "reviewer" | "fix" | "captain" | "reconciler",
	note?: string,
): Promise<"handled" | "blocked" | "salvaged"> {
	const error = status.error ?? "";
	const quota = classifyQuota(error);
	if (quota && (await holdForQuota(host, card, quota))) return "handled";
	// Two "the run is gone but the work landed" cases salvage into review:
	// pi-subagents' no-edit guard on an already-implemented lane, and a run whose
	// async record vanished (e.g. the program sat paused while /tmp was cleaned)
	// while the lane carries the committed implementation. Evidence is still
	// required by the caller, so a mid-work death without commits still blocks.
	if (label === "worker" && (NO_EDIT_GUARD.test(error) || status.state === "not_found") && (await laneHasCommits(host, card))) {
		await progress(
			host,
			`${card.id} worker ${status.state === "not_found" ? "run record lost" : "no edits"}, lane has commits — salvage → review`,
		);
		await host.save();
		return "salvaged";
	}
	if (isInfraError(error) && (card.infraRetries ?? 0) < MAX_RUN_INFRA_RETRIES) {
		// Runner/provider blips (not code failures) retry in place: the run is dead
		// but the card's intent survives, so the same tick's dispatch picks it back
		// up in the right phase. Capped — then it blocks loudly.
		card.infraRetries = (card.infraRetries ?? 0) + 1;
		const from = card.phase;
		rearmCard(card);
		await progress(host, `${card.id} ${label} blip — retry ${card.infraRetries}/${MAX_RUN_INFRA_RETRIES} (${from}→${card.phase})`);
		await host.save();
		return "handled";
	}
	card.infraRetries = 0;
	await blockCard(
		host,
		card,
		`${label} run ${runId} ended as ${status.state}${error ? `: ${error}` : " (no error reported)"}${note ?? ""}`,
	);
	return "blocked";
}

/** pi-subagents' completion-mutation guard wording. */
const NO_EDIT_GUARD = /without making edits|made no edits|no edits for an implementation/i;

/** True when the lane carries commits beyond its base (work already landed). */
async function laneHasCommits(host: DriverHost, card: CardLedger): Promise<boolean> {
	if (!card.lane) return false;
	try {
		const changed = await host.ports.git.changedFiles(card.lane.path, card.lane.base, "HEAD");
		return changed.length > 0;
	} catch {
		return false;
	}
}

/**
 * True when this card needs no new implementation: its lane already carries
 * commits and the card record still says `State: review`. Dispatching an
 * implementation worker there produces no edits (and pi-subagents hard-fails
 * that), so the card goes straight to review instead.
 */
async function laneAlreadyImplemented(host: DriverHost, card: CardLedger): Promise<boolean> {
	if (!(await laneHasCommits(host, card))) return false;
	try {
		const text = await host.ports.readCard(host.ledger, card);
		return /^##\s*State:\s*review/im.test(text);
	} catch {
		return false;
	}
}

async function onWorkerComplete(host: DriverHost, gate: TodoGate, card: CardLedger, status: RunStatus, runId: string, resumed = false): Promise<void> {
	recordRunUsage(card, "worker", status, { resumed, runId });
	if (status.state === "paused") {
		await blockCard(host, card, `worker run ${runId} paused by operator — redispatch to continue from the lane state`);
		return;
	}
	if (status.state !== "complete") {
		const outcome = await handleRunFailure(host, card, status, runId, "worker");
		// "salvaged": the lane already holds the implementation, so fall through and
		// validate it (gate + review) instead of asking for another worker.
		if (outcome !== "salvaged") return;
	}
	const waiting = todosBlockingCard(gate, card.id);
	const text = await readCardText(host, card);
	if (!parseEvidence(text)) {
		// A worker stopped by a human need parks on the todo, not on missing evidence.
		if (waiting.length > 0) {
			await parkForTodos(host, gate, card, waiting, { force: true });
			return;
		}
		await blockCard(host, card, "worker finished without an `## Evidence` section");
		return;
	}
	card.workerSummary = status.output ? truncateTail(status.output, 6_000) : "";
	const outcome = await runCardGates(host, card, host.ports.runCwd(host.ledger, card));
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "implementation", gate);
		return;
	}
	if (waiting.length > 0) {
		await parkForTodos(host, gate, card, waiting, { force: true });
		return;
	}
	card.phase = "review_pending";
	card.holdUntil = undefined;
	card.holdReason = undefined;
	card.holdCount = 0;
	await progress(host, `${card.id} implemented (gates green)`);
}

async function startGateFix(
	host: DriverHost,
	card: CardLedger,
	gates: GateResult[],
	origin: "implementation" | "merge" | "captain",
	gate?: TodoGate,
): Promise<void> {
	if (gate) {
		const waiting = todosBlockingCard(gate, card.id);
		if (waiting.length > 0) {
			// Gate fixes run after a run landed: force the park (no attempt consumed).
			await parkForTodos(host, gate, card, waiting, { force: true });
			return;
		}
	}
	const attempts = (card.gateAttempts ?? 0) + 1;
	card.gateAttempts = attempts;
	if (attempts > 3) {
		await blockCard(host, card, `gates still failing after ${attempts - 1} fix attempts: ${gateFailures(gates).join("; ")}`);
		return;
	}
	card.fixReason = "gate";
	card.lastError = undefined;
	const task = gateFixBrief({ ledger: host.ledger, card, failures: gates, origin, repoRoot: host.cwd });
	const cwd = card.merge?.state === "merged" ? host.cwd : host.ports.runCwd(host.ledger, card);
	const dispatched = await dispatchWithInfraRetry(host, card, {
		kind: "fix",
		agent: effectiveWorkerAgent(host.ledger, card),
		task,
		cwd,
		model: effectiveWorkerModel(host.ledger, card),
		thinking: effectiveWorkerThinking(host.ledger, card),
		label: `wp ${host.ledger.slug} card ${card.id} gate fix`,
	});
	if (!dispatched.ok) {
		await blockCard(host, card, `gate-fix dispatch failed: ${dispatched.error}`);
		return;
	}
	// A gate fix starts a fresh worker session: reset the resume chain.
	card.workerResumeDepth = 0;
}

async function onReviewerComplete(host: DriverHost, card: CardLedger, status: RunStatus, runId: string, resumed = false): Promise<void> {
	recordRunUsage(card, "reviewer", status, { resumed, runId });
	if (status.state === "paused") {
		await blockCard(host, card, `reviewer run ${runId} paused by operator — redispatch to re-run the review`);
		return;
	}
	if (status.state !== "complete") {
		await handleRunFailure(host, card, status, runId, "reviewer");
		return;
	}
	const cycle = card.cycles + 1;
	const path = reviewPath(host.programDir, card.id, cycle);
	const written = (await host.ports.readFile(path))?.trim() ?? "";
	const output = status.output?.trim() ?? "";
	const review = written.length > 0 ? written : output;
	if (review.length === 0) {
		await blockCard(host, card, "reviewer returned no findings");
		return;
	}
	if (written.length === 0) await host.ports.writeFile(path, `${review}\n`);
	card.cycles = cycle;
	card.phase = "triaging";
	const profile = effectiveReviewProfile(host.ledger, card);
	createDecision(host, {
		kind: "review-triage",
		card: card.id,
		reviewPath: path,
		summary: oneLine(output, 300),
		message: reviewDecisionMessage(host.ledger, card.id, cycle, profile),
		expectedAction: `work_program({ action: "triage", card: "${card.id}", verdicts: [{ "finding": "<label>", "verdict": "approve" | "reject" | "defer", "note": "..." }] })`,
	});
	await progress(host, `${card.id} review ${cycle} → triage`);
}

async function onFixComplete(host: DriverHost, gate: TodoGate, card: CardLedger, status: RunStatus, runId: string, resumed = false): Promise<void> {
	recordRunUsage(card, "fix", status, { resumed, runId });
	const wasMerged = card.merge?.state === "merged";
	if (status.state === "paused") {
		await blockCard(host, card, `fix run ${runId} paused by operator — redispatch to retry the pending fixes`);
		return;
	}
	if (status.state !== "complete") {
		await handleRunFailure(host, card, status, runId, "fix");
		return;
	}
	card.fixReason = undefined;
	card.infraRetries = 0;
	const cwd = wasMerged ? host.cwd : host.ports.runCwd(host.ledger, card);
	const outcome = await runCardGates(host, card, cwd);
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, wasMerged ? "merge" : "implementation", gate);
		return;
	}
	if (wasMerged) {
		await markDoneAndCommit(host, card, [`merge: recorded manually (${(card.merge?.commit ?? "").slice(0, 7)})`]);
		await finalizeMergedCard(host, card, card.merge?.commit ?? "");
		return;
	}
	if (todosBlockingCard(gate, card.id).length > 0) {
		await parkForTodos(host, gate, card, todosBlockingCard(gate, card.id), { force: true });
		return;
	}
	card.phase = "review_pending";
	card.holdUntil = undefined;
	card.holdReason = undefined;
	card.holdCount = 0;
	await progress(host, `${card.id} fixes applied → re-review`);
}

async function onCaptainComplete(host: DriverHost, gate: TodoGate, card: CardLedger, status: RunStatus, runId: string, resumed = false): Promise<void> {
	recordRunUsage(card, "captain", status, { resumed, runId });
	if (status.state === "paused") {
		await blockCard(host, card, `captain run ${runId} paused by operator — redispatch to restart the card loop`);
		return;
	}
	if (status.state !== "complete") {
		await handleRunFailure(host, card, status, runId, "captain");
		return;
	}
	const structured = status.structured as Record<string, unknown> | undefined;
	if (!structured || typeof structured.verdict !== "string") {
		await blockCard(host, card, "captain did not return structured output");
		return;
	}
	card.workerSummary = status.output ? truncateTail(status.output, 6_000) : "";
	if (structured.verdict === "done") {
		const reviewFile = typeof structured.reviewPath === "string" ? structured.reviewPath : "";
		const reviewText = await host.ports.readFile(reviewFile).catch(() => "");
		const cycles = typeof structured.cycles === "number" ? structured.cycles : 0;
		if (reviewFile.length === 0 || reviewText.trim().length === 0 || cycles < 1) {
			await blockCard(host, card, "captain reported done without a recorded review pass");
			return;
		}
		card.cycles = Math.max(card.cycles, cycles);
	}
	if (structured.verdict !== "done") {
		const blockers = Array.isArray(structured.blockers)
			? structured.blockers.filter((entry): entry is string => typeof entry === "string")
			: [];
		await blockCard(host, card, blockers.length > 0 ? blockers.join("; ") : "captain reported a blocker");
		return;
	}
	const outcome = await runCardGates(host, card, host.ports.runCwd(host.ledger, card));
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "captain", gate);
		return;
	}
	if (todosBlockingCard(gate, card.id).length > 0) {
		await parkForTodos(host, gate, card, todosBlockingCard(gate, card.id), { force: true });
		return;
	}
	card.phase = "approved";
	await progress(host, `${card.id} captain done (gates green)`);
}

async function dispatchRun(
	host: DriverHost,
	card: CardLedger,
	request: {
		kind: "worker" | "reviewer" | "fix" | "captain" | "reconciler";
		agent: string;
		task: string;
		cwd: string;
		model?: string;
		thinking?: string;
		label: string;
		outputSchema?: Record<string, unknown>;
	},
): Promise<void> {
	const result = await host.ports.runs.dispatch({
		kind: request.kind,
		agent: request.agent,
		task: request.task,
		cwd: request.cwd,
		label: request.label,
		// Every card run carries an explicit wall-clock budget: pi-subagents kills
		// single async runs at 30m otherwise, and a killed worker re-explores.
		timeoutMs: effectiveRunTimeoutMs(host.ledger),
		...(request.model ? { model: request.model } : {}),
		...(request.thinking ? { thinking: request.thinking } : {}),
		...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
	});
	card.activeRun = {
		kind: request.kind,
		runId: result.runId,
		startedAt: Date.now(),
		...(result.asyncDir ? { asyncDir: result.asyncDir } : {}),
	};
	card.runs += 1;
	card.blockedFrom = undefined;
	if (request.kind === "worker") {
		card.workerRun = result.runId;
		card.phase = "implementing";
	} else if (request.kind === "reviewer") {
		card.reviewRun = result.runId;
		card.phase = "reviewing";
	} else if (request.kind === "fix") {
		card.fixRuns = [...(card.fixRuns ?? []), result.runId];
		card.workerRun = result.runId;
		card.phase = "fixing";
	} else if (request.kind === "captain") {
		card.captainRun = result.runId;
		card.phase = "implementing";
	} else {
		card.reconcilerRun = result.runId;
		card.phase = "reconciling";
	}
	await host.save();
}

/* ---------------------------------------------------------------------------
 * Program atlas: scout-built orientation (atlas.md)
 *
 * One scout explores the repo once and writes atlas.md; workers and reviewers
 * get its path in their briefs instead of re-deriving the codebase per run.
 * The atlas file is the source of truth; the scout session is a warm cache —
 * post-merge refreshes resume it when possible and fall back to a fresh scout
 * (which re-reads the existing atlas instead of exploring from zero).
 * The first build gates worker dispatch (the whole point is workers starting
 * WITH the atlas); refreshes never gate.
 * ------------------------------------------------------------------------- */

/** Atlas path injected into briefs only when the file should exist and be current-ish. */
function atlasNotePath(host: DriverHost): string | undefined {
	const atlas = host.ledger.atlas;
	if (!atlas?.enabled) return undefined;
	if (atlas.state !== "ready" && atlas.state !== "refreshing") return undefined;
	return atlasPath(host.programDir);
}

async function dispatchScout(host: DriverHost, task: string, state: "building" | "refreshing"): Promise<boolean> {
	const atlas = host.ledger.atlas;
	if (!atlas?.enabled) return false;
	try {
		const result = await host.ports.runs.dispatch({
			kind: "scout",
			agent: atlas.agent ?? "scout",
			task,
			cwd: host.cwd,
			// Exploration, not implementation: a shorter leash than card runs.
			timeoutMs: SCOUT_TIMEOUT_MS,
			...(atlas.model ? { model: atlas.model } : {}),
			...(atlas.thinking ? { thinking: atlas.thinking } : {}),
			label: `wp ${host.ledger.slug} atlas scout`,
		});
		atlas.state = state;
		atlas.runId = result.runId;
		atlas.startedAt = Date.now();
		atlas.nextRefreshAt = undefined;
		if (result.asyncDir) atlas.asyncDir = result.asyncDir;
		atlas.lastError = undefined;
		await host.save();
		return true;
	} catch (error) {
		atlas.state = "failed";
		atlas.lastError = oneLine(String(error), 160);
		await progressProgram(host, `atlas scout dispatch failed: ${oneLine(String(error), 120)}`);
		await host.save();
		return false;
	}
}

/** Adopt an existing atlas.md in any mode; auto-dispatch the first build only
 *  in managed/captain (session mode drives its own runs — bring your own atlas). */
async function ensureScout(host: DriverHost): Promise<void> {
	const atlas = host.ledger.atlas;
	if (!atlas?.enabled || atlas.state !== undefined) return;
	// An atlas written by the operator or left by an earlier program run is adopted as-is.
	const existing = (await host.ports.readFile(atlasPath(host.programDir))).trim();
	if (existing.length > 0) {
		atlas.state = "ready";
		atlas.builtAt = Date.now();
		await progressProgram(host, "atlas adopted (existing file)");
		await host.save();
		return;
	}
	if (host.ledger.mode === "session") return;
	const dispatched = await dispatchScout(
		host,
		scoutBrief({
			ledger: host.ledger,
			planPath: planPath(host),
			tasksDir: `${host.programDir}/tasks`,
			atlasPath: atlasPath(host.programDir),
			cwd: host.cwd,
			cardCount: host.ledger.order.length,
		}),
		"building",
	);
	if (dispatched) await progressProgram(host, "atlas scout dispatched (first build gates workers)");
}

/** Track the in-flight scout run: complete → ready (and gate release), failure → failed (workers proceed atlas-less). */
async function reconcileScout(host: DriverHost): Promise<void> {
	const atlas = host.ledger.atlas;
	if (!atlas?.enabled) return;
	if (atlas.state !== "building" && atlas.state !== "refreshing") return;
	if (!atlas.runId) {
		atlas.state = "failed";
		atlas.lastError = "scout run id missing";
		await host.save();
		return;
	}
	const status = await host.ports.runs.status(atlas.runId, atlas.asyncDir);
	if (status.state === "unknown") {
		if ((atlas.startedAt ?? 0) > 0 && Date.now() - (atlas.startedAt ?? 0) > UNKNOWN_RUN_GRACE_MS) {
			atlas.state = "failed";
			atlas.lastError = `scout run ${atlas.runId} state could not be determined`;
			await progressProgram(host, `atlas scout ${atlas.lastError}`);
			await host.save();
		}
		return;
	}
	if (!isTerminal(status)) return;
	if (status.usage) atlas.usage = mergeUsage(atlas.usage, status.usage);
	const atlasSessions = upsertSessionUsage(atlas.usageSessions ?? [], "scout", status, atlas.runId);
	if (atlasSessions) {
		atlas.usageSessions = atlasSessions;
		atlas.usage = aggregateSessions(atlasSessions);
	}
	const wasBuilding = atlas.state === "building";
	if (status.state !== "complete") {
		atlas.state = "failed";
		atlas.lastError = status.error ?? `scout run ${status.state}`;
		await progressProgram(host, `atlas scout ${wasBuilding ? "build" : "refresh"} failed: ${oneLine(atlas.lastError, 120)}`);
		await host.save();
		return;
	}
	const text = (await host.ports.readFile(atlasPath(host.programDir))).trim();
	if (text.length === 0) {
		atlas.state = "failed";
		atlas.lastError = "scout completed without writing atlas.md";
		await progressProgram(host, "atlas scout produced no atlas.md");
		await host.save();
		return;
	}
	const mergedCount = atlas.pendingMerges.length;
	atlas.pendingMerges = [];
	atlas.state = "ready";
	atlas.updatedAt = Date.now();
	if (wasBuilding) {
		atlas.builtAt = atlas.updatedAt;
		await progressProgram(host, `atlas built${status.usage ? ` (${formatUsage(status.usage)})` : ""} — worker dispatch unblocked`);
	} else {
		atlas.refreshes += 1;
		await progressProgram(host, `atlas refreshed (${mergedCount} merge${mergedCount === 1 ? "" : "s"})`);
	}
	await host.save();
}

/** Record a landed card for the next atlas refresh (both merge modes call this). */
function queueAtlasRefresh(host: DriverHost, card: CardLedger, commit: string | undefined): void {
	const atlas = host.ledger.atlas;
	if (!atlas?.enabled) return;
	if (atlas.state !== "ready" && atlas.state !== "refreshing") return;
	atlas.pendingMerges.push({ id: card.id, ...(commit ? { commit } : {}) });
}

/** Refresh the atlas after merges: resume the retained scout when possible, fresh scout otherwise.
 *  A failed refresh dispatch stays retryable (state returns to ready, pending merges kept)
 *  and is throttled to one attempt per 5 minutes so a dead runner cannot spam every tick. */
async function maybeRefreshAtlas(host: DriverHost): Promise<void> {
	const atlas = host.ledger.atlas;
	if (!atlas?.enabled || atlas.state !== "ready" || atlas.pendingMerges.length === 0) return;
	if ((atlas.nextRefreshAt ?? 0) > Date.now()) return;
	const merged = atlas.pendingMerges.map((entry) => ({
		id: entry.id,
		title: host.ledger.cards[entry.id]?.title ?? entry.id,
		...(entry.commit ? { commit: entry.commit } : {}),
	}));
	const label = merged.map((entry) => entry.id).join(",");
	// Hand the scout the merged diff instead of letting it go looking: a refresh
	// should be a few surgical edits, not a re-exploration. Best-effort — the
	// brief degrades to "use git log" when the diff cannot be read.
	let diffContext: { headSha?: string; commitLog?: string; diffStat?: string; changedFiles?: string[] } = {};
	const mergeCommits = merged.map((entry) => entry.commit).filter((sha): sha is string => Boolean(sha));
	if (mergeCommits.length > 0) {
		const base = `${mergeCommits[0]}~1`;
		try {
			const [headSha, commitLog, diffStat, changedFiles] = await Promise.all([
				host.ports.git.head(host.cwd),
				host.ports.git.commitLog(host.cwd, `${base}..HEAD`),
				host.ports.git.diffStat(host.cwd, base, "HEAD"),
				host.ports.git.changedFiles(host.cwd, base, "HEAD"),
			]);
			diffContext = { headSha, commitLog, diffStat, changedFiles };
		} catch {
			diffContext = {};
		}
	}
	if (atlas.runId) {
		try {
			const result = await host.ports.runs.resume(
				atlas.runId,
				scoutRefreshBrief({
					ledger: host.ledger,
					atlasPath: atlasPath(host.programDir),
					cwd: host.cwd,
					merged,
					fresh: false,
					...diffContext,
				}),
			);
			atlas.state = "refreshing";
			atlas.runId = result.runId;
			atlas.startedAt = Date.now();
			if (result.asyncDir) atlas.asyncDir = result.asyncDir;
			await progressProgram(host, `atlas refresh dispatched (resume; cards ${label})`);
			await host.save();
			return;
		} catch {
			await progressProgram(host, "atlas scout resume failed → fresh refresh");
		}
	}
	const dispatched = await dispatchScout(
		host,
		scoutRefreshBrief({
			ledger: host.ledger,
			atlasPath: atlasPath(host.programDir),
			cwd: host.cwd,
			merged,
			fresh: true,
			...diffContext,
		}),
		"refreshing",
	);
	if (dispatched) {
		await progressProgram(host, `atlas refresh dispatched (fresh; cards ${label})`);
	} else {
		// dispatchScout marked the atlas failed; a refresh failure must not kill the
		// existing atlas — stay ready, keep the pending merges, retry in 5 minutes.
		atlas.state = "ready";
		atlas.nextRefreshAt = Date.now() + 5 * 60_000;
		await host.save();
	}
}

async function ensureLane(host: DriverHost, card: CardLedger): Promise<void> {
	if (host.ledger.parallelExecution !== "worktrees") return;
	if (card.lane) return;
	const base = await host.ports.git.head(host.cwd);
	const branch = laneBranch(host.ledger.laneBranchPattern, host.ledger.baseBranch, card.id);
	const path = `${host.ports.worktreeBase(host.ledger)}/${card.id}`;
	await host.ports.git.worktreeAdd(host.cwd, path, branch, base);
	card.lane = { path, branch, base };
	await host.save();
}

export async function startWorkerFor(host: DriverHost, card: CardLedger): Promise<void> {
	const ledger = host.ledger;
	card.gateAttempts = 0;
	card.lastError = undefined;
	// The worker brief points at the operator todo file; make sure it exists.
	// Best-effort: a missing file never blocks the card (the brief stands alone).
	await ensureOperatorTodoFile({
		readFile: (path) => host.ports.readFile(path).then((text) => (text.trim().length > 0 ? text : undefined)),
		writeFile: (path, content) => host.ports.writeFile(path, content),
		cwd: host.cwd,
	});
	try {
		await ensureLane(host, card);
	} catch (error) {
		await blockCard(host, card, `lane setup failed: ${oneLine(String(error), 200)}`);
		return;
	}
	if (await laneAlreadyImplemented(host, card)) {
		// Nothing left to implement: the lane already carries the committed work,
		// so validate and review it instead of dispatching a no-op worker.
		card.phase = "review_pending";
		await progress(host, `${card.id} lane has commits — skip worker → review`);
		await host.save();
		return;
	}
	if (ledger.mode === "captain") {
		const reviewProfile = effectiveReviewProfile(ledger, card);
		const path = reviewPath(host.programDir, card.id, card.cycles + 1);
		const task = captainBrief({
			ledger,
			card,
			cardPath: cardPath(host, card),
			planPath: planPath(host),
			cwd: host.ports.runCwd(ledger, card),
			gates: effectiveCardGates(ledger, card),
			reviewProfile,
			reviewPath: path,
			repoRoot: host.cwd,
			maxCycles: effectiveMaxCycles(ledger, card),
			atlasPath: atlasNotePath(host),
		});
		const dispatched = await dispatchWithInfraRetry(host, card, {
			kind: "captain",
			agent: "work-program-captain",
			task,
			cwd: host.ports.runCwd(ledger, card),
			label: `wp ${ledger.slug} card ${card.id} captain`,
			outputSchema: CAPTAIN_OUTPUT_SCHEMA,
		});
		if (!dispatched.ok) {
			await blockCard(host, card, `captain dispatch failed: ${dispatched.error}`);
		}
		return;
	}
	const task = workerBrief({
		ledger,
		card,
		cardPath: cardPath(host, card),
		planPath: planPath(host),
		cwd: host.ports.runCwd(ledger, card),
		gates: effectiveCardGates(ledger, card),
		repoRoot: host.cwd,
		atlasPath: atlasNotePath(host),
	});
	try {
		const dispatched = await dispatchWithInfraRetry(host, card, {
			kind: "worker",
			agent: effectiveWorkerAgent(ledger, card),
			task,
			cwd: host.ports.runCwd(ledger, card),
			model: effectiveWorkerModel(ledger, card),
			thinking: effectiveWorkerThinking(ledger, card),
			label: `wp ${ledger.slug} card ${card.id}`,
		});
		if (!dispatched.ok) {
			await blockCard(host, card, `worker dispatch failed: ${dispatched.error}`);
		}
	} catch (error) {
		await blockCard(host, card, `worker dispatch failed: ${oneLine(String(error), 200)}`);
	}
}

async function dispatchReadyCards(host: DriverHost, gate: TodoGate): Promise<void> {
	const ledger = host.ledger;
	// The atlas's first build gates worker dispatch: the entire point is that
	// workers start WITH orientation instead of paying the exploration tax.
	// A failed/absent build never gates — workers then explore as before.
	if (ledger.atlas?.enabled && ledger.atlas.state === "building") return;
	const capacity = ledger.parallelExecution === "direct" ? 1 : ledger.maxParallel;
	const ready = readyCards(ledger);
	if (ready.length === 0) return;
	const inFlight = writersInFlight(ledger);
	let slots = Math.max(0, capacity - inFlight);
	for (const card of ready) {
		if (slots <= 0) break;
		// Waiting on a human: hold the slot for cards that can proceed.
		if (todosBlockingCard(gate, card.id).length > 0) continue;
		slots -= 1;
		await startWorkerFor(host, card);
		if (card.phase === "blocked") continue;
		await progress(host, `${card.id} dispatched`);
		host.ports.notify(`Work program: card ${card.id} dispatched`, "info");
	}
}

export async function startReviewFor(host: DriverHost, card: CardLedger): Promise<void> {
	const ledger = host.ledger;
	const profile = effectiveReviewProfile(ledger, card);
	const cwd = host.ports.runCwd(ledger, card);
	const base = card.lane?.base ?? (await host.ports.git.head(cwd));
	const branch = card.lane?.branch ?? (await host.ports.git.currentBranch(cwd));
	const [commitLog, diffStat, changedFiles, headSha] = await Promise.all([
		host.ports.git.commitLog(cwd, `${base}..HEAD`),
		host.ports.git.diffStat(cwd, base, "HEAD"),
		host.ports.git.changedFiles(cwd, base, "HEAD"),
		host.ports.git.head(cwd),
	]);
	const path = reviewPath(host.programDir, card.id, card.cycles + 1);
	await host.ports.writeFile(path, "");

	// Cycle 2+: resume the same reviewer session. It already holds the diff
	// understanding from cycle 1, so re-review pays only for the fix delta
	// instead of re-deriving the whole card. Independence is per card (reviewer
	// ≠ worker); a fresh pair of eyes per cycle only re-reads the same files.
	if (effectiveReviewerResume(ledger) && card.reviewRun && card.cycles > 0 && card.lastReviewedSha) {
		const decision = resumeDecision(host, card, "reviewer");
		if (!decision.resume) {
			await progress(host, `${card.id} review ${card.cycles + 1}: fresh reviewer — ${decision.reason}`);
		} else {
			const decisionLog = [...ledger.decisions]
				.reverse()
				.find((entry) => entry.card === card.id && entry.kind === "review-triage" && entry.status === "resolved");
			const approved = (decisionLog?.verdicts ?? []).filter((verdict) => verdict.verdict === "approve");
			const [fixLog, fixStat] = await Promise.all([
				host.ports.git.commitLog(cwd, `${card.lastReviewedSha}..HEAD`),
				host.ports.git.diffStat(cwd, card.lastReviewedSha, "HEAD"),
			]);
			const task = reReviewBrief({
			ledger,
			card,
			cycle: card.cycles + 1,
			previousReviewPath: reviewPath(host.programDir, card.id, card.cycles),
			reviewPath: path,
			sinceSha: card.lastReviewedSha,
			fixLog,
			fixStat,
			approved,
			gates: card.gates ?? [],
			atlasPath: atlasNotePath(host),
		});
		try {
			const result = await host.ports.runs.resume(card.reviewRun, task);
			card.activeRun = {
				kind: "reviewer",
				runId: result.runId,
				startedAt: Date.now(),
				resumed: true,
				...(result.asyncDir ? { asyncDir: result.asyncDir } : {}),
			};
			card.reviewRun = result.runId;
			card.lastReviewedSha = headSha;
			card.reviewerResumeDepth = (card.reviewerResumeDepth ?? 0) + 1;
			card.phase = "reviewing";
			card.runs += 1;
			card.blockedFrom = undefined;
			await progress(host, `${card.id} review ${card.cycles + 1} dispatched (resume ${card.reviewerResumeDepth})`);
			await host.save();
			return;
		} catch (error) {
			host.ports.notify(
				`Work program: could not resume the retained reviewer for card ${card.id} (${oneLine(String(error), 120)}); dispatching a fresh reviewer.`,
				"warning",
			);
			await progress(host, `${card.id} reviewer resume failed → fresh review`);
		}
		}
	}

	const task = reviewTask({
		resources: loadResources(),
		ledger,
		card,
		profile,
		cardPath: cardPath(host, card),
		reviewPath: path,
		cwd,
		branch,
		base,
		commitLog,
		diffStat,
		changedFiles,
		workerSummary: card.workerSummary ?? "",
		gates: card.gates ?? [],
		atlasPath: atlasNotePath(host),
	});
	try {
		await dispatchRun(host, card, {
			kind: "reviewer",
			agent: effectiveReviewerAgent(ledger, card),
			task,
			cwd,
			model: effectiveReviewerModel(ledger, card),
			thinking: effectiveReviewerThinking(ledger, card),
			label: `wp ${ledger.slug} card ${card.id} review`,
		});
	} catch (error) {
		await blockCard(host, card, `reviewer dispatch failed: ${oneLine(String(error), 200)}`);
		return;
	}
	card.lastReviewedSha = headSha;
	card.reviewerResumeDepth = 0;
	await host.save();
	await progress(host, `${card.id} review ${card.cycles + 1} dispatched`);
}

async function dispatchReviews(host: DriverHost, gate: TodoGate): Promise<void> {
	const ledger = host.ledger;
	const reviewing = ledgerCards(ledger).filter((card) => card.phase === "reviewing").length;
	let slots = Math.max(0, ledger.maxParallel - reviewing);
	for (const card of ledgerCards(ledger)) {
		if (card.phase !== "review_pending") continue;
		if (isHeld(card)) continue;
		if (todosBlockingCard(gate, card.id).length > 0) continue;
		if (slots <= 0) break;
		slots -= 1;
		await startReviewFor(host, card);
	}
}

async function dispatchFixes(host: DriverHost, gate: TodoGate): Promise<void> {
	const ledger = host.ledger;
	for (const card of ledgerCards(ledger)) {
		if (card.phase !== "fixing" || card.activeRun) continue;
		if (isHeld(card)) continue;
		if (todosBlockingCard(gate, card.id).length > 0) continue;
		// Only an untriaged review holds fixes back — never a stale record of
		// another kind (a stale `blocked` decision is cleared via unblock/sweep).
		if (openDecisionOfKind(ledger, card.id, "review-triage")) continue;
		if (!card.lane) {
			try {
				await ensureLane(host, card);
			} catch (error) {
				await blockCard(host, card, `lane setup failed: ${oneLine(String(error), 200)}`);
				continue;
			}
		}
		const decision = [...ledger.decisions]
			.reverse()
			.find((entry) => entry.card === card.id && entry.kind === "review-triage" && entry.status === "resolved");
		const verdicts = decision?.verdicts ?? [];
		const approved = verdicts.filter((verdict) => verdict.verdict === "approve");
		if (approved.length === 0) {
			card.phase = "approved";
			continue;
		}
		card.fixReason = "review";
		const task = fixBrief({
			ledger,
			card,
			reviewPath: decision?.reviewPath ?? "",
			verdicts,
			gates: effectiveCardGates(ledger, card),
			repoRoot: host.cwd,
		});
		const cwd = host.ports.runCwd(ledger, card);
		if (card.workerRun) {
			const decision = resumeDecision(host, card, "worker");
			if (!decision.resume) {
				await progress(host, `${card.id} fix: fresh session — ${decision.reason}`);
			} else {
				try {
					const result = await host.ports.runs.resume(card.workerRun, task);
					card.activeRun = {
						kind: "fix",
						runId: result.runId,
						startedAt: Date.now(),
						resumed: true,
						...(result.asyncDir ? { asyncDir: result.asyncDir } : {}),
					};
					card.fixRuns = [...(card.fixRuns ?? []), result.runId];
					card.workerRun = result.runId;
					card.workerResumeDepth = (card.workerResumeDepth ?? 0) + 1;
					card.runs += 1;
					card.blockedFrom = undefined;
					await progress(host, `${card.id} fix dispatched (resume ${card.workerResumeDepth})`);
					await host.save();
					continue;
				} catch (error) {
					host.ports.notify(
						`Work program: could not resume the retained worker for card ${card.id} (${oneLine(String(error), 120)}); dispatching a fresh worker.`,
						"warning",
					);
					await progress(host, `${card.id} resume failed → fresh fix`);
				}
			}
		}
		const dispatched = await dispatchWithInfraRetry(host, card, {
			kind: "fix",
			agent: effectiveWorkerAgent(ledger, card),
			task:
				task +
				[
					"",
					"This is a FRESH session continuing an existing lane: the previous session's history is unavailable to you.",
					"Reconstruct state before changing anything: the card's `## Evidence` section, the lane's commits and diff (`git log --oneline -20`, `git diff HEAD~'<n>'`), and the program atlas named above.",
				].join("\n"),
			cwd,
			model: effectiveWorkerModel(ledger, card),
			thinking: effectiveWorkerThinking(ledger, card),
			label: `wp ${ledger.slug} card ${card.id} review fixes`,
		});
		if (!dispatched.ok) {
			await blockCard(host, card, `fix dispatch failed: ${dispatched.error}`);
			continue;
		}
		card.workerResumeDepth = 0;
		await progress(host, `${card.id} fix dispatched (fresh session)`);
	}
}

async function finishApprovedCards(host: DriverHost, gate: TodoGate): Promise<void> {
	for (const card of ledgerCards(host.ledger)) {
		if (card.phase !== "approved") continue;
		// Approved but waiting on a human: hold the merge until the todo resolves.
		if (todosBlockingCard(gate, card.id).length > 0) continue;
		await finishCard(host, card);
	}
}

export async function finishCard(host: DriverHost, card: CardLedger): Promise<void> {
	const ledger = host.ledger;
	if (ledger.parallelExecution === "worktrees") {
		card.phase = "queued";
		card.merge = { state: "queued", attempts: card.merge?.attempts ?? 0 };
		if (!ledger.mergeQueue.includes(card.id)) ledger.mergeQueue.push(card.id);
		await progress(host, `${card.id} approved → merge queue`);
	} else {
		await completeDirectCard(host, card);
	}
	await host.save();
	host.refreshUi();
	host.ports.notify(`Work program: card ${card.id} approved`, "info");
}

async function completeDirectCard(host: DriverHost, card: CardLedger): Promise<void> {
	const text = await readCardText(host, card);
	let updated = setCardState(text, "done");
	updated = appendHarnessEvidence(updated, [
		...gateEvidenceLines(card.gates ?? [], "gate"),
		`review: ${card.cycles} cycle(s) completed`,
		...(card.usage ? [`usage: ${formatUsage(card.usage)} (${card.usageRuns?.length ?? card.runs} runs)`] : []),
		`completed: ${new Date().toISOString()}`,
	]);
	await writeCardText(host, card, updated);
	const commit = await commitRecordPaths(host, card, `wp(${host.ledger.slug}): card ${card.id} done`, [
		`${host.programDir}/${card.path}`,
		`${host.programDir}/plan.md`,
		`${host.programDir}/progress.md`,
	]);
	card.phase = "done";
	card.activeRun = undefined;
	await progress(host, `${card.id} done (${commit.slice(0, 7)})`);
	queueAtlasRefresh(host, card, commit);
}

/**
 * Commit program records tolerantly: repos that gitignore their program folder
 * (`.agents/`) keep the records on disk untracked instead of wedging the card.
 * Returns the resulting HEAD, warning once when paths had to be skipped.
 */
async function commitRecordPaths(host: DriverHost, card: CardLedger, message: string, paths: string[]): Promise<string> {
	const { commit, skipped } = await host.ports.git.commitRecords(host.cwd, message, paths);
	if (skipped.length > 0) {
		host.ports.notify(
			`Work program: program records not committed (${skipped.length} path(s) ignored or missing); records remain on disk untracked`,
			"warning",
		);
		await progress(host, `${card.id} records not committed (${skipped.length} unstageable)`);
	}
	return commit;
}

/**
 * Deliver decision packets — but only as wake-ups for an idle session.
 *
 * The per-turn program brief already lists open decisions (pull), so a packet
 * exists to wake a stalled agent, not to announce a decision the agent is
 * already handling. A packet queues only when the decision is still open, is
 * older than the minimum age, and the session is idle; a session that never
 * goes idle still gets packets once a decision passes the force age, so nothing
 * is starved. Deferred decisions keep `packetSent = false` and are re-evaluated
 * on the next tick.
 */
async function ensurePackets(host: DriverHost, now: number = Date.now()): Promise<void> {
	const pending = openDecisions(host.ledger).filter((decision) => !decision.packetSent);
	if (pending.length === 0) return;
	const idle = host.ports.sessionIdle();
	const ready = pending.filter((decision) => {
		const age = now - (decision.createdAt ?? now);
		if (age < PACKET_WAKE_MIN_AGE_MS) return false;
		return idle || age >= PACKET_WAKE_FORCE_AGE_MS;
	});
	if (ready.length === 0) return;
	// Re-check open state immediately before queueing: resolving between the
	// filter above and here must not produce a stale announcement.
	const stillOpen = ready.filter((decision) => decision.status === "open");
	if (stillOpen.length === 0) return;
	for (const decision of stillOpen) decision.packetSent = true;
	host.ports.ask(packetText(host.ledger, stillOpen, now));
	await host.save();
}

export function rearmPackets(ledger: ProgramLedger): void {
	for (const decision of ledger.decisions) {
		if (decision.status === "open") decision.packetSent = false;
	}
}

/**
 * Rearm cards left run-less in a flight phase (e.g. after a hard pause stopped
 * their runs). Only touches cards with no active run; cards with live runs
 * (soft-paused, or runs that could not be stopped) are left alone so their
 * results reconcile normally. Returns human-readable notes for progress.
 * Fixing cards keep their fix intent (dispatchFixes re-dispatches from the
 * resolved triage); reconciling cards are picked back up by the merge queue.
 */
/**
 * Rearm one card left run-less in a flight phase so it is dispatchable again
 * (used by hard pause and by quota holds). Returns a note when it moved.
 */
function rearmCard(card: CardLedger): string | undefined {
	const from = card.phase;
	if (from === "implementing") {
		card.phase = "pending";
	} else if (from === "reviewing") {
		card.phase = "review_pending";
	} else if (from === "verifying") {
		const failed = (card.gates ?? []).some((gate) => gate.code !== 0);
		card.phase = failed ? "fixing" : "review_pending";
	} else {
		return undefined;
	}
	card.lastError = undefined;
	return `${card.id} ${from}→${card.phase}`;
}

export function rearmPausedCards(host: DriverHost): string[] {
	const notes: string[] = [];
	for (const card of ledgerCards(host.ledger)) {
		if (card.activeRun) continue;
		const note = rearmCard(card);
		if (note) notes.push(note);
	}
	return notes;
}

/** Porcelain entries outside the program's own record folder and lane worktrees. */
async function foreignChanges(host: DriverHost): Promise<string[]> {
	const raw = await host.ports.git.statusPorcelain(host.cwd);
	const excluded = new Set<string>();
	const cwd = host.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const programAbs = host.programDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const programRel = programAbs.startsWith(`${cwd}/`) ? programAbs.slice(cwd.length + 1) : programAbs;
	excluded.add(programRel);
	// The operator todo file is operator-owned scratch space: operator edits must
	// never pause the merge queue.
	excluded.add(".operator");
	for (const id of host.ledger.order) {
		const lane = host.ledger.cards[id]?.lane;
		if (!lane) continue;
		const laneRel = lane.path.replace(/\\/g, "/").replace(/\/+$/, "");
		excluded.add(laneRel.startsWith(`${cwd}/`) ? laneRel.slice(cwd.length + 1) : laneRel);
	}
	return raw
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.filter((line) => {
			const body = line.length > 3 ? line.slice(3).trim() : line.trim();
			const path = body.includes(" -> ") ? (body.split(" -> ").pop() ?? body) : body;
			const normalized = path.replace(/^"|"$/g, "").replace(/\\/g, "/");
			for (const prefix of excluded) {
				if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return false;
			}
			return true;
		});
}

async function processMergeQueue(host: DriverHost, gate: TodoGate, attempted: Set<string> = new Set()): Promise<void> {
	const ledger = host.ledger;
	if (ledger.parallelExecution !== "worktrees") return;
	while (ledger.mergeQueue.length > 0) {
		const headId = ledger.mergeQueue[0];
		if (headId === undefined) return;
		const card = ledger.cards[headId];
		if (!card) {
			ledger.mergeQueue.shift();
			continue;
		}
		// Waiting on a human: hold the merge until the todo resolves.
		if (todosBlockingCard(gate, headId).length > 0) return;
		if (card.phase === "done") {
			ledger.mergeQueue.shift();
			continue;
		}
		if (card.phase === "blocked") {
			if (card.merge?.state === "conflict" || card.merge?.state === "merging") {
				// A merge is mid-flight (conflict markers / MERGE_HEAD on disk). Park the
				// queue here so unblock+redispatch continues the same merge instead of
				// losing the queue position. Surfaced via status/doctor; no progress spam.
				return;
			}
			ledger.mergeQueue.shift();
			await progress(host, `${card.id} dequeued (blocked)`);
			await host.save();
			continue;
		}
		if (card.phase === "reconciling" && !card.activeRun) {
			// Run-less reconciling head (e.g. its reconciler was stopped by a hard
			// pause): pick the preserved merge back up instead of parking the queue.
			const unmergedNow = await host.ports.git.unmergedPaths(host.cwd);
			const mergingNow = await host.ports.git.merging(host.cwd);
			if (unmergedNow.length > 0 || mergingNow) {
				await beginReconcile(host, card, { conflicted: unmergedNow, output: "" }, true);
				return;
			}
			card.phase = "queued";
			card.merge = { state: "queued", attempts: card.merge?.attempts ?? 0 };
			await host.save();
			continue;
		}
		if (card.phase === "fixing" || card.phase === "reconciling" || card.activeRun) return;
		const dirty = await foreignChanges(host);
		if (dirty.length > 0) {
			if (!ledger.mergeQueuePaused) {
				ledger.mergeQueuePaused = true;
				host.ports.notify("Work program: merge queue paused (program worktree is dirty)", "warning");
			}
			return;
		}
		if (ledger.mergeQueuePaused) {
			ledger.mergeQueuePaused = false;
			host.ports.notify("Work program: merge queue resumed", "info");
		}
		if (card.phase === "queued") {
			card.phase = "merging";
			card.merge = { state: "merging", attempts: card.merge?.attempts ?? 0 };
			await host.save();
		}
		if (card.phase !== "merging" || !card.lane) return;
		if (attempted.has(card.id)) return;
		attempted.add(card.id);
		if (await host.ports.git.merging(host.cwd)) {
			// A previous tick merged but never committed (commit crashed after a
			// good merge): resume at the commit step instead of re-merging.
			await finishMergeCommit(host, card, gate);
			return;
		}
		const result = await host.ports.git.mergeNoCommit(host.cwd, card.lane.branch);
		card.merge = { state: "merging", attempts: (card.merge?.attempts ?? 0) + 1 };
		await host.save();
		if (result.conflicted.length > 0) {
			card.merge.state = "conflict";
			await beginReconcile(host, card, result);
			return;
		}
		if (result.code !== 0) {
			await host.ports.git.mergeAbort(host.cwd).catch(() => undefined);
			card.merge = { state: "queued", attempts: card.merge?.attempts ?? 1 };
			await blockCard(host, card, `git merge failed (exit ${result.code}): ${oneLine(result.output, 200)}`);
			ledger.mergeQueue.shift();
			await host.save();
			continue;
		}
		await finishMergeCommit(host, card, gate);
		if (card.merge?.state === "merged") continue;
		// Parked (commit failure) or handed to a gate fix: stop draining the queue.
		return;
	}
}

async function beginReconcile(
	host: DriverHost,
	card: CardLedger,
	merge: { conflicted: string[]; output: string },
	force = false,
): Promise<void> {
	const ledger = host.ledger;
	const attempts = (card.reconcileAttempts ?? 0) + 1;
	card.reconcileAttempts = attempts;
	if (attempts > 3) {
		await blockCard(host, card, `merge conflicts unresolved after ${attempts - 1} reconciliation attempts`);
		return;
	}
	if (ledger.mode === "session" && !force) {
		card.phase = "reconciling";
		createDecision(host, {
			kind: "blocked",
			card: card.id,
			message: `Merging card ${card.id} hit conflicts in: ${merge.conflicted.join(", ")}.`,
			expectedAction: `work_program({ action: "dispatch", card: "${card.id}", role: "reconciler" }) — or resolve manually and call work_program({ action: "merge_resolved", card: "${card.id}" })`,
		});
		return;
	}
	const existingIntent = await host.ports.git.commitLog(host.cwd, "-8");
	const task = reconcilerBrief({
		ledger,
		card,
		branch: card.lane?.branch ?? "",
		cwd: host.cwd,
		conflicted: merge.conflicted,
		mergeOutput: merge.output,
		incomingIntent: `Card ${card.id} scope: ${card.title}`,
		existingIntent,
		gateCommands: effectiveCardGates(ledger, card),
		atlasPath: atlasNotePath(host),
	});
	const dispatched = await dispatchWithInfraRetry(host, card, {
		kind: "reconciler",
		agent: "work-program-reconciler",
		task,
		cwd: host.cwd,
		label: `wp ${ledger.slug} card ${card.id} reconcile`,
	});
	if (!dispatched.ok) {
		await blockCard(
			host,
			card,
			`reconciler dispatch failed: ${dispatched.error} (conflict in ${merge.conflicted.join(", ") || "unknown paths"} preserved)`,
		);
		return;
	}
	await progress(host, `${card.id} conflict → reconciler`);
}

/** Complete a clean merge: commit it, gate it, record it — parking (never
 *  crash-looping) when the commit step fails. Bounded: past the cap the card
 *  blocks loudly with a decision instead of retrying forever. */
async function finishMergeCommit(host: DriverHost, card: CardLedger, gate: TodoGate): Promise<void> {
	try {
		await completeMerge(host, card, gate);
	} catch (error) {
		const attempts = (card.merge?.attempts ?? 0) + 1;
		card.merge = { state: "merging", attempts };
		card.lastError = `merge commit failed (attempt ${attempts}): ${oneLine(String(error), 160)}`;
		await progress(host, `${card.id} merge commit failed (attempt ${attempts}, parked)`);
		if (attempts > MAX_MERGE_COMMIT_FAILURES) {
			await blockCard(host, card, `merge commit failed ${attempts} times: ${oneLine(String(error), 160)}`);
			const index = host.ledger.mergeQueue.indexOf(card.id);
			if (index >= 0) host.ledger.mergeQueue.splice(index, 1);
		}
		await host.save();
	}
}

async function onReconcilerComplete(host: DriverHost, gate: TodoGate, card: CardLedger, status: RunStatus, runId: string, resumed = false): Promise<void> {
	recordRunUsage(card, "reconciler", status, { resumed, runId });
	if (status.state === "paused") {
		await blockCard(
			host,
			card,
			`reconciler run ${runId} paused by operator — the merge conflict is preserved; unblock with redispatch to continue`,
		);
		return;
	}
	if (status.state !== "complete") {
		await handleRunFailure(host, card, status, runId, "reconciler", " (conflict preserved)");
		return;
	}
	const unmerged = await host.ports.git.unmergedPaths(host.cwd);
	if (unmerged.length > 0) {
		await beginReconcile(host, card, {
			conflicted: unmerged,
			output: status.output ?? "",
		});
		return;
	}
	if (await host.ports.git.merging(host.cwd)) {
		// Commit only what the merge staged — never `add`, so stray files stay out.
		await host.ports.git.commitMerge(host.cwd);
	}
	await finishMergeCommit(host, card, gate);
}

function recordPaths(host: DriverHost, card: CardLedger): string[] {
	return [...programRecordPaths(host), `${host.programDir}/${card.path}`];
}

function programRecordPaths(host: DriverHost): string[] {
	const paths = [`${host.programDir}/plan.md`, `${host.programDir}/progress.md`];
	for (const id of host.ledger.order) {
		const card = host.ledger.cards[id];
		if (card) paths.push(`${host.programDir}/${card.path}`);
	}
	return paths;
}

/** Write `State: done` plus harness evidence into the main card and commit the program records. */
async function markDoneAndCommit(host: DriverHost, card: CardLedger, extraLines: string[] = []): Promise<string> {
	const mainCardPath = `${host.programDir}/${card.path}`;
	const baseText = (await host.ports.readFile(mainCardPath)) || (await readCardText(host, card));
	let updated = setCardState(baseText, "done");
	updated = appendHarnessEvidence(updated, [
		...gateEvidenceLines(card.gates ?? [], "gate"),
		...extraLines,
		...(card.usage ? [`usage: ${formatUsage(card.usage)} (${card.usageRuns?.length ?? card.runs} runs)`] : []),
		`completed: ${new Date().toISOString()}`,
	]);
	await host.ports.writeFile(mainCardPath, updated);
	return commitRecordPaths(host, card, `wp(${host.ledger.slug}): card ${card.id} done`, recordPaths(host, card));
}

async function completeMerge(host: DriverHost, card: CardLedger, gate: TodoGate): Promise<void> {
	// Commit exactly what the merge staged (never `add`), tolerating an
	// open-but-empty merge instead of failing the card.
	const commit = await host.ports.git.commitMerge(host.cwd);
	card.merge = { state: "merged", commit, attempts: card.merge?.attempts ?? 1 };
	const outcome = await runCardGates(host, card, host.cwd);
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "merge", gate);
		return;
	}
	// The merge is committed; a human need now parks the record instead of landing it.
	const waiting = todosBlockingCard(gate, card.id);
	if (waiting.length > 0) {
		await parkForTodos(host, gate, card, waiting, {});
		// parkForTodos skips non-parkable phases (merging): force the record park —
		// the resume sweep finalizes this exact state via finishManualMerge.
		if (card.phase !== "blocked") {
			card.blockedFrom = "merging";
			card.phase = "blocked";
			card.lastError = waitingReason(waiting);
			cancelOpenDecisionsFor(host, card.id, card.lastError);
			createDecision(host, {
				kind: "blocked",
				card: card.id,
				message: `Card ${card.id} is ${card.lastError} (merge ${commit.slice(0, 7)} committed, not yet recorded).`,
				expectedAction: `work_program({ action: "todo_done", id: "${waiting[0]?.id}" }) when finished — or work_program({ action: "unblock", card: "${card.id}", resolution: "redispatch" }) to override`,
			});
			await progress(host, `${card.id} waiting: ${waiting.map((item) => item.id).join(" ")} (merge committed)`);
			await host.save();
		}
		return;
	}
	await markDoneAndCommit(host, card, [
		`merge: lane ${card.lane?.branch ?? "?"} → ${host.ledger.baseBranch} (${commit.slice(0, 7)})`,
	]);
	await finalizeMergedCard(host, card, commit);
}

async function finalizeMergedCard(host: DriverHost, card: CardLedger, commit: string): Promise<void> {
	card.phase = "done";
	card.activeRun = undefined;
	const index = host.ledger.mergeQueue.indexOf(card.id);
	if (index >= 0) host.ledger.mergeQueue.splice(index, 1);
	await progress(host, `${card.id} merged (${commit.slice(0, 7)})`);
	await host.save();
	queueAtlasRefresh(host, card, commit);
	if (card.lane) {
		const lane = card.lane;
		try {
			const landed = await host.ports.git.isAncestor(host.cwd, lane.branch, "HEAD");
			if (!landed) {
				host.ports.notify(
					`Work program: lane ${lane.branch} is not merged into HEAD; keeping worktree and branch for inspection.`,
					"warning",
				);
			} else {
				await host.ports.git.worktreeRemove(host.cwd, lane.path);
				await host.ports.git.branchDelete(host.cwd, lane.branch);
				card.lane = undefined;
			}
		} catch (error) {
			host.ports.notify(`Work program: lane cleanup failed for card ${card.id}: ${oneLine(String(error), 120)}`, "warning");
		}
	}
	host.ports.notify(`Work program: card ${card.id} merged`, "info");
}

/** Finalize a merge that a human or the orchestrator already resolved and committed. */
export async function finishManualMerge(host: DriverHost, card: CardLedger, gate?: TodoGate): Promise<void> {
	const commit = await host.ports.git.head(host.cwd);
	card.merge = { state: "merged", commit, attempts: card.merge?.attempts ?? 1 };
	const outcome = await runCardGates(host, card, host.cwd);
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "merge", gate);
		return;
	}
	await markDoneAndCommit(host, card, [`merge: recorded manually (${commit.slice(0, 7)})`]);
	await finalizeMergedCard(host, card, commit);
}

async function maybeRunProgramGate(host: DriverHost): Promise<void> {
	const ledger = host.ledger;
	if (ledger.status !== "active") return;
	const cards = ledgerCards(ledger);
	if (cards.length === 0) return;
	if (!cards.every((card) => card.phase === "done" || isAbandonedCard(card))) return;
	// Only an open program-gate decision holds completion: with every card done,
	// any other open record is stale and must not wedge the program.
	if (openDecisions(ledger).some((decision) => decision.kind === "gate-failed")) return;
	const commands = ledger.gates.program;
	if (commands.length === 0) {
		await completeProgram(host, "no gate");
		return;
	}
	const results: GateResult[] = [];
	for (const command of commands) {
		results.push(await host.ports.gates.run(command, host.cwd));
	}
	ledger.programGate = results;
	const failed = results.filter((gate) => gate.code !== 0);
	if (failed.length > 0) {
		createDecision(host, {
			kind: "gate-failed",
			message: programGateDecisionMessage(gateFailures(failed)),
			expectedAction: `work_program({ action: "program_gate", card: "${cards[0]?.id ?? ""}", choice: "retry" | "block" })`,
		});
		return;
	}
	await completeProgram(host, "gate green");
}

/** Finalize a completed program: record it, clear the way for the UI to go quiet,
 *  and hand the session agent a summary + close question (answered on confirm only). */
async function completeProgram(host: DriverHost, how: string): Promise<void> {
	const ledger = host.ledger;
	ledger.status = "complete";
	// Cards are done, so nothing consumes the atlas any more: close out a scout
	// run left in flight instead of leaving the ledger stuck on "refreshing".
	// The file is the source of truth — a landed atlas.md is simply "ready".
	const atlas = ledger.atlas;
	if (atlas?.enabled && (atlas.state === "building" || atlas.state === "refreshing")) {
		const previous = atlas.state;
		let atlasText = "";
		try {
			atlasText = (await host.ports.readFile(atlasPath(host.programDir))).trim();
		} catch {
			atlasText = "";
		}
		atlas.pendingMerges = [];
		atlas.runId = undefined;
		atlas.asyncDir = undefined;
		atlas.startedAt = undefined;
		atlas.nextRefreshAt = undefined;
		if (atlasText.length > 0) {
			atlas.state = "ready";
			atlas.updatedAt = Date.now();
			if (previous === "building") atlas.builtAt = atlas.updatedAt;
			await progressProgram(host, `atlas close-out at program completion (${previous} → ready)`);
		} else {
			atlas.state = "failed";
			atlas.lastError = `program completed before the scout produced atlas.md (was ${previous})`;
			await progressProgram(host, `atlas close-out at program completion (${previous} → failed: no atlas.md)`);
		}
	}
	await progress(host, `program complete (${how})`);
	try {
		await host.ports.git.commitRecords(
			host.cwd,
			`wp(${ledger.slug}): program complete`,
			programRecordPaths(host),
		);
	} catch {
		// Records stay on disk; completion is not blocked by an unstageable path.
	}
	host.ports.notify(`Work program ${ledger.slug} complete`, "info");
	host.ports.ask(programCompleteMessage(ledger, await openOperatorTodos(host, ledger.slug)));
}

/** Open operator todos for this program's stream, if the store exists. Never throws. */
async function openOperatorTodos(host: DriverHost, stream: string): Promise<OperatorTodoItem[]> {
	try {
		const text = await host.ports.readFile(operatorTodosJsonPath(host.cwd));
		if (!text || text.trim().length === 0) return [];
		return openTodos(parseTodoStore(text), stream).map((item) => ({ title: item.title, done: false }));
	} catch {
		return [];
	}
}

/* ---------------------------------------------------------------------------
 * Tool-facing mutations
 * ------------------------------------------------------------------------- */

export function applyTriage(host: DriverHost, cardId: string, verdicts: FindingVerdict[]): { ok: boolean; error?: string } {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	// Kind-scoped: a stale `blocked` record must never shadow the live review.
	const decision = openDecisionOfKind(host.ledger, cardId, "review-triage");
	if (!decision) {
		return { ok: false, error: `card ${cardId} has no open review decision (${describeOpenDecisions(host.ledger, cardId)})` };
	}
	const approved = verdicts.filter((verdict) => verdict.verdict === "approve");
	resolveDecision(host, decision.id, { verdicts });
	if (approved.length === 0) {
		card.phase = "approved";
		return { ok: true };
	}
	const cap = effectiveMaxCycles(host.ledger, card);
	if (card.cycles >= cap) {
		if (host.ledger.onExhausted === "accept") {
			card.phase = "approved";
			return { ok: true };
		}
		if (host.ledger.onExhausted === "block") {
			card.phase = "blocked";
			card.lastError = `review cycle limit (${cap}) reached with approved findings`;
			return { ok: true };
		}
		card.phase = "triaging";
		createDecision(host, {
			kind: "cycle-exhausted",
			card: cardId,
			summary: `${approved.length} approved finding(s) remain`,
			message: cycleDecisionMessage(cardId, cap),
			expectedAction: `work_program({ action: "cycle_decision", card: "${cardId}", choice: "accept" | "block" })`,
		});
		return { ok: true };
	}
	card.phase = "fixing";
	card.infraRetries = 0;
	return { ok: true };
}

export async function applyUnblock(
	host: DriverHost,
	cardId: string,
	resolution: "redispatch" | "done" | "abandon",
): Promise<{ ok: boolean; error?: string }> {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	if (card.phase !== "blocked" && card.phase !== "reconciling") {
		// The card already moved on (e.g. an operator redispatch via `dispatch`),
		// but a `blocked` record stayed open: clear the orphan without touching
		// the phase, instead of deadlocking every action on it.
		const stale = openDecisionOfKind(host.ledger, cardId, "blocked");
		if (stale) {
			resolveDecision(host, stale.id);
			await progress(host, `${cardId} stale blocked decision cleared (card is ${card.phase})`);
			return { ok: true };
		}
		return { ok: false, error: `card ${cardId} is ${card.phase}; only a blocked card can be unblocked (${describeOpenDecisions(host.ledger, cardId)})` };
	}
	const decision = openDecisionFor(host.ledger, cardId);
	if (decision) resolveDecision(host, decision.id);
	// An explicit operator override also releases todo waiting (the drive would
	// otherwise re-park the card on the next tick while the todos stay open).
	delete card.waitingOn;
	if (resolution === "abandon") {
		return abandonCard(host, card);
	}
	// Redispatch can start a run (gate fix, reconciler, fresh worker): refused
	// while paused so a pause actually stops spending.
	const dispatchGate = requireActiveForDispatch(host);
	if (dispatchGate) return dispatchGate;
	const reviewed = host.ledger.decisions.some(
		(entry) => entry.card === cardId && entry.kind === "review-triage" && entry.status === "resolved",
	);
	const blockedFrom = card.blockedFrom;
	const needsFix = card.fixReason !== undefined || blockedFrom === "fixing" || blockedFrom === "verifying";
	card.lastError = undefined;
	card.activeRun = undefined;
	card.blockedFrom = undefined;
	card.infraRetries = 0;
	if (card.abandoned === true) {
		// Redispatch of a dropped card re-adopts its scope.
		card.abandoned = false;
		await progress(host, `${cardId} re-adopted`);
	}
	if (resolution === "done") {
		if (!reviewed) {
			return { ok: false, error: `card ${cardId} has no completed review; use "redispatch" instead` };
		}
		card.fixReason = undefined;
		if (host.ledger.parallelExecution === "worktrees" && card.lane) {
			card.phase = "approved";
			await finishCard(host, card);
			return { ok: true };
		}
		await completeDirectCard(host, card);
		return { ok: true };
	}
	const unmerged = await host.ports.git.unmergedPaths(host.cwd);
	if (unmerged.length > 0) {
		card.phase = "reconciling";
		await beginReconcile(host, card, { conflicted: unmerged, output: "" }, true);
		return { ok: true };
	}
	if (card.merge?.state === "merged") {
		card.phase = "merging";
		await finishManualMerge(host, card);
		return { ok: true };
	}
	if (host.ledger.parallelExecution === "worktrees" && card.lane) {
		if (blockedFrom === "reviewing") {
			// The review run was the thing that failed: re-enter review, do not send
			// an implementation worker at already-committed work.
			card.phase = "review_pending";
			return { ok: true };
		}
		if (needsFix) {
			// A fix was in flight when the card blocked — go back to fixing so the
			// approved findings are actually applied instead of skipped to merge.
			if (card.fixReason === "gate") {
				const failures = (card.gates ?? []).filter((gate) => gate.code !== 0);
				if (failures.length > 0 && (card.gateAttempts ?? 0) <= 3) {
					await startGateFix(host, card, failures, "implementation");
					return { ok: true };
				}
			}
			if (reviewed) {
				card.phase = "fixing";
				return { ok: true };
			}
			card.phase = "pending";
			card.gateAttempts = 0;
			card.fixReason = undefined;
			return { ok: true };
		}
		if (!reviewed) {
			card.phase = "pending";
			card.gateAttempts = 0;
			return { ok: true };
		}
		card.fixReason = undefined;
		card.phase = "approved";
		await finishCard(host, card);
		return { ok: true };
	}
	card.phase = "pending";
	card.gateAttempts = 0;
	card.fixReason = undefined;
	return { ok: true };
}

/**
 * Approved findings from the card's most recent triage — the debt that an
 * `accept` at the cycle cap leaves unfixed. Recorded on the card so the merge
 * keeps the record instead of quietly dropping it.
 */
function unfixedApprovedFindings(host: DriverHost, cardId: string): string[] {
	const latest = [...host.ledger.decisions]
		.reverse()
		.find((entry) => entry.card === cardId && entry.kind === "review-triage" && entry.status === "resolved");
	const verdicts = latest?.verdicts ?? [];
	return verdicts.filter((verdict) => verdict.verdict === "approve").map((verdict) => verdict.finding);
}

export function applyCycleDecision(
	host: DriverHost,
	cardId: string,
	choice: "accept" | "block",
): { ok: boolean; error?: string } {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	const decision = openDecisionOfKind(host.ledger, cardId, "cycle-exhausted");
	if (!decision) {
		return { ok: false, error: `card ${cardId} has no open cycle decision (${describeOpenDecisions(host.ledger, cardId)})` };
	}
	resolveDecision(host, decision.id);
	if (choice === "accept") {
		// No further review rounds: land the card, but record the findings that were
		// approved and never fixed, so accepting at the cap cannot silently drop
		// real debt into a merge.
		card.acceptedFindings = unfixedApprovedFindings(host, cardId);
		card.phase = "approved";
		return { ok: true };
	}
	card.phase = "blocked";
	card.lastError = "cycle limit reached; blocked by decision";
	return { ok: true };
}

export function applyProgramGateDecision(
	host: DriverHost,
	choice: "retry" | "block",
): { ok: boolean; error?: string } {
	const decision = openDecisions(host.ledger).find((entry) => entry.kind === "gate-failed");
	if (!decision) return { ok: false, error: "no open program gate decision" };
	resolveDecision(host, decision.id);
	if (choice === "retry") {
		host.ledger.programGate = [];
		return { ok: true };
	}
	host.ledger.status = "paused";
	return { ok: true };
}

export async function dispatchManual(
	host: DriverHost,
	cardId: string,
	role: "worker" | "reviewer" | "reconciler",
): Promise<{ ok: boolean; error?: string }> {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	const dispatchGate = requireActiveForDispatch(host);
	if (dispatchGate) return dispatchGate;
	if (card.activeRun) return { ok: false, error: `card ${cardId} already has an active run` };
	// An explicit operator dispatch moves the card forward, so it also retires
	// any open `blocked` record — otherwise the record goes stale and shadows
	// later decisions (the card advances, the block does not).
	const staleBlocked = openDecisionOfKind(host.ledger, cardId, "blocked");
	if (role === "worker") {
		const depBlocked = card.dependsOn.some((dep) => host.ledger.cards[dep]?.phase !== "done");
		if (depBlocked) return { ok: false, error: `card ${cardId} has unmet dependencies` };
		if (card.phase !== "pending" && card.phase !== "ready" && card.phase !== "blocked") {
			return { ok: false, error: `card ${cardId} is ${card.phase}, not ready for a worker` };
		}
		if (staleBlocked) resolveDecision(host, staleBlocked.id);
		card.infraRetries = 0;
		await startWorkerFor(host, card);
		return { ok: true };
	}
	if (role === "reviewer") {
		const depBlocked = card.dependsOn.some((dep) => host.ledger.cards[dep]?.phase !== "done");
		if (depBlocked) return { ok: false, error: `card ${cardId} has unmet dependencies` };
		if (card.phase !== "review_pending") {
			return { ok: false, error: `card ${cardId} is ${card.phase}; only a pending review can be dispatched` };
		}
		if (staleBlocked) resolveDecision(host, staleBlocked.id);
		card.infraRetries = 0;
		await startReviewFor(host, card);
		return { ok: true };
	}
	const unmerged = await host.ports.git.unmergedPaths(host.cwd);
	if (unmerged.length === 0) {
		return { ok: false, error: `card ${cardId} has no unresolved merge conflict` };
	}
	const decision = openDecisionFor(host.ledger, cardId);
	if (decision) resolveDecision(host, decision.id);
	card.phase = "reconciling";
	await beginReconcile(host, card, { conflicted: unmerged, output: "" }, true);
	return { ok: true };
}

export type { FindingVerdict };

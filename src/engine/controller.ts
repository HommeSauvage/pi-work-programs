import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DECISION_CUSTOM_TYPE, DRIVE_TICK_MS, SESSION_ENTRY_TYPE } from "../constants.ts";
import {
	DEFAULT_SETTINGS,
	applyOverrides,
	isMode,
	isPackageConfigured,
	isParallelExecution,
	isReviewProfile,
	loadSettings,
	mergeCardFrontmatter,
	mergePlanConfig,
	normalizeCardPatch,
	overridesToPlanFrontmatter,
} from "../config.ts";
import { stringifyFrontmatter } from "../shared/frontmatter.ts";
import { buildBrief, planInstructions } from "../brief.ts";
import { loadResources } from "../protocol/resources.ts";
import {
	adoptProgram,
	appendProgress,
	listCardFiles,
	listProgramRefs,
	readPlan,
	scaffoldProgram,
	syncCards,
	type ProgramRef,
} from "../program/create.ts";
import {
	buildLedger,
	configOverridesFromPlan,
	loadLedger,
	migrateLedger,
	reviewPath,
	saveLedger,
} from "../program/ledger.ts";
import { formatProblems, validatePlanFiles } from "../program/validate.ts";
import { defaultWorktreeDir } from "../shared/paths.ts";
import { oneLine, slugify, formatAgo, formatDuration, formatTokens } from "../shared/text.ts";
import { readTextOrUndefined, writeTextAtomic } from "../shared/fsx.ts";
import { PLAN_FILE } from "../constants.ts";
import {
	addTodo as storeAddTodo,
	closeTodo as storeCloseTodo,
	ensureOperatorTodoFile,
	formatTodoList,
	normalizeTodoSteps,
	openBlockingForCard,
	operatorTodosJsonPath,
	parseTodoStore,
	serializeTodoStore,
	summarizeTodosSync,
	updateTodo as storeUpdateTodo,
	type TodoStep,
	type TodoStore,
	type TodoSummary,
} from "../program/operator-todos.ts";
import type {
	CardLedger,
	DriverPorts,
	FindingVerdict,
	Mode,
	ParallelExecution,
	ProgramConfigOverrides,
	ProgramLedger,
	ReviewProfile,
	WorkProgramSettings,
} from "../shared/types.ts";
import {
	applyCycleDecision,
	applyProgramGateDecision,
	applyTriage,
	applyUnblock,
	buildTodoGate,
	dispatchManual,
	drive,
	finishManualMerge,
	parkForTodos,
	planCardRemoval,
	rearmPackets,
	rearmPausedCards,
	resumeWaitingCards,
	syncTodoStore,
} from "./driver.ts";
import { createDecision, resolveDecision } from "./decisions.ts";
import { counts, isAbandonedCard, isHeld, openDecisionFor, openDecisions, phaseSymbol } from "./phases.ts";
import { Git } from "../platform/git.ts";
import { Gates } from "../platform/gates.ts";
import { SubagentsRpc } from "../platform/runs.ts";
import { DependencyProbe, type DependencyStatus } from "../platform/deps.ts";

export interface ActiveProgram {
	slug: string;
	absDir: string;
	ledger: ProgramLedger;
}

/**
 * Append the findings accepted at the cycle cap to the card record. Additive and
 * idempotent: the block is replaced if it already exists, so a re-accept does not
 * stack duplicates.
 */
export function appendAcceptedFindings(cardText: string, findings: string[]): string {
	const block = [
		"",
		"## Accepted findings (approved at the review-cycle cap, carried unfixed)",
		"",
		...findings.map((finding) => `- ${finding}`),
		"",
	].join("\n");
	const existing = /\n## Accepted findings \(approved at the review-cycle cap, carried unfixed\)[\s\S]*?(?=\n## |$)/;
	if (existing.test(cardText)) return cardText.replace(existing, block.trimEnd());
	return `${cardText.trimEnd()}\n${block}`;
}

/** Runtime knobs an orchestrator may retune while the program runs.
 *  With `card` set, the patch applies to one card's front matter instead of
 *  the program (reviewProfile, maxCycles, worker/reviewer agent+model+thinking).
 */
export interface ProgramConfigPatch {
	card?: string;
	mode?: Mode;
	reviewProfile?: ReviewProfile;
	maxCycles?: number;
	onExhausted?: "ask" | "accept" | "block";
	maxParallel?: number;
	parallelExecution?: ParallelExecution;
	workerAgent?: string;
	workerModel?: string;
	workerThinking?: string;
	reviewerAgent?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
	reviewerResume?: boolean;
	runTimeoutMs?: number;
	atlasEnabled?: boolean;
	atlasAgent?: string;
	atlasModel?: string;
	atlasThinking?: string;
}

export interface ActionResult {
	ok: boolean;
	text: string;
}

const MODE_LABELS: Array<{ mode: Mode; label: string }> = [
	{ mode: "managed", label: "managed — the extension runs the loop; this agent decides at review checkpoints" },
	{ mode: "session", label: "session — this agent dispatches every step; the extension enforces and records" },
	{ mode: "captain", label: "captain — one fresh orchestrator per card; this agent handles program gates" },
];

/** One-line atlas state for status: build state, refreshes, scout usage. */
function atlasStatusLine(ledger: ProgramLedger): string | undefined {
	const atlas = ledger.atlas;
	if (!atlas) return undefined;
	if (!atlas.enabled) return "atlas: off";
	const state = atlas.state ?? "not built";
	const parts = [`atlas: ${state}`];
	if (atlas.state === "ready" || atlas.state === "refreshing") {
		parts.push(`${atlas.refreshes} refresh${atlas.refreshes === 1 ? "" : "es"}`);
	}
	if (atlas.pendingMerges.length > 0) parts.push(`${atlas.pendingMerges.length} merge(s) pending`);
	if (atlas.usage) parts.push(`${formatTokens(atlas.usage.total)} tok`);
	if (atlas.lastError) parts.push(oneLine(atlas.lastError, 80));
	return parts.join(" · ");
}

/** Program token totals line: summed card usage + scout usage. */
function tokensStatusLine(ledger: ProgramLedger): string | undefined {
	let total = 0;
	let out = 0;
	let cost = 0;
	let runs = 0;
	let has = false;
	for (const id of ledger.order) {
		const card = ledger.cards[id];
		if (!card?.usage) continue;
		has = true;
		total += card.usage.total;
		out += card.usage.output;
		cost += card.usage.costUsd ?? 0;
		runs += card.usageRuns?.length ?? 0;
	}
	if (ledger.atlas?.usage) {
		has = true;
		total += ledger.atlas.usage.total;
		out += ledger.atlas.usage.output;
		cost += ledger.atlas.usage.costUsd ?? 0;
	}
	if (!has) return undefined;
	return `tokens: ${formatTokens(total)} total · ${formatTokens(out)} out${cost > 0 ? ` · $${cost.toFixed(2)}` : ""} (${runs} card runs)`;
}

/** Suggested next step for a blocked card, shown in status/doctor Issues. */
function unblockHint(card: CardLedger): string {
	if (card.waitingOn !== undefined && card.waitingOn.length > 0) {
		return ` → todo_done ${card.waitingOn.join("/")} when finished`;
	}
	if (card.fixReason !== undefined || card.blockedFrom === "fixing" || card.blockedFrom === "verifying") {
		return ` → redispatch retries the pending ${card.fixReason ?? "fix"}`;
	}
	if (card.merge?.state === "conflict" || card.merge?.state === "merging") {
		return " → resolve the conflict or redispatch the reconciler";
	}
	return "";
}

export class WorkProgramController {
	readonly runs: SubagentsRpc;
	private readonly depsProbe: DependencyProbe;
	private readonly git: Git;
	private readonly gates: Gates;
	readonly ports: DriverPorts;
	private sessionCtx: ExtensionContext | undefined;
	private active: ActiveProgram | undefined;
	private settings: WorkProgramSettings = DEFAULT_SETTINGS;
	private deps: DependencyStatus | undefined;
	private sessionStarted = false;
	private intercomReady = false;
	private driving = false;
	private driveQueued = false;
	/** Safety tick: the drive is event-driven, so a missed event (a lost
	 *  completion, a late RPC bridge) must not freeze a live program forever. */
	private tickTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly pi: ExtensionAPI) {
		this.runs = new SubagentsRpc(pi);
		this.runs.attach();
		this.depsProbe = new DependencyProbe(pi, this.runs);
		this.git = new Git(pi);
		this.gates = new Gates(pi);
		this.ports = this.buildPorts();
	}

	/* ------------------------------------------------------------------ */
	/* Lifecycle                                                           */
	/* ------------------------------------------------------------------ */

	async initialize(ctx: ExtensionContext): Promise<void> {
		this.sessionCtx = ctx;
		this.sessionStarted = true;
		this.settings = await loadSettings(ctx.cwd, CONFIG_DIR_NAME);
		this.deps = await this.safeDependencyCheck();
		if (!this.deps.ok) {
			ctx.ui.notify(
				`Work programs are blocked: missing ${this.deps.missing.join(", ")}. Install with: ${this.deps.hints.join(" && ")}`,
				"warning",
			);
			this.refreshUi();
			return;
		}
		const stored = this.lastStoredProgram(ctx);
		if (stored) {
			const ref = await this.refFromSlug(stored);
			if (ref) {
				await this.activate(ref);
				return;
			}
		}
		await this.autoActivate();
	}

	shutdown(): void {
		this.stopTick();
		this.runs.dispose();
		this.active = undefined;
		this.sessionCtx = undefined;
		this.sessionStarted = false;
	}

	/** Idempotent periodic drive tick while a program is loaded (no-op when paused). */
	private startTick(): void {
		if (this.tickTimer !== undefined) return;
		this.tickTimer = setInterval(() => {
			if (!this.active || this.active.ledger.status !== "active") return;
			this.scheduleDrive();
		}, DRIVE_TICK_MS);
	}

	private stopTick(): void {
		if (this.tickTimer === undefined) return;
		clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	async onDependenciesChanged(): Promise<void> {
		if (!this.sessionStarted) return;
		const wasOk = this.deps?.ok ?? false;
		this.deps = await this.safeDependencyCheck();
		if (!wasOk && this.deps.ok) {
			this.sessionCtx?.ui.notify("Work programs: dependencies are now available", "info");
			if (!this.active) await this.autoActivate();
			if (this.active) this.scheduleDrive();
		}
		this.refreshUi();
	}

	markIntercomReady(): void {
		this.intercomReady = true;
	}

	private async safeDependencyCheck(): Promise<DependencyStatus> {
		try {
			const intercomConfigured = await isPackageConfigured(this.cwd, CONFIG_DIR_NAME, "pi-intercom").catch(() => false);
			return await this.depsProbe.check({ intercomReady: this.intercomReady, intercomConfigured });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				subagents: { installed: false, ready: false, tool: false, methods: [], error: message },
				intercom: { installed: false, tool: false, signaled: false },
				missing: ["pi-subagents", "pi-intercom"],
				hints: ["pi install npm:pi-subagents", "pi install npm:pi-intercom"],
			};
		}
	}

	dependencyStatus(): DependencyStatus | undefined {
		return this.deps;
	}

	requireDependencies(): string | undefined {
		if (this.deps?.ok) return undefined;
		const missing = this.deps?.missing.join(", ") ?? "pi-subagents, pi-intercom";
		const hints = this.deps?.hints.join(" && ") ?? "pi install npm:pi-subagents && pi install npm:pi-intercom";
		return `Work programs are blocked: missing ${missing}. Install with: ${hints} and /reload.`;
	}

	getActive(): ActiveProgram | undefined {
		return this.active;
	}

	private lastStoredProgram(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { slug?: unknown } } | undefined;
			if (entry?.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
			const slug = entry.data?.slug;
			if (typeof slug === "string" && slug.length > 0) return slug;
		}
		return undefined;
	}

	private async refFromSlug(slug: string): Promise<ProgramRef | undefined> {
		const refs = await listProgramRefs(this.cwd, this.settings);
		return refs.find((ref) => ref.slug === slug);
	}

	private async autoActivate(): Promise<void> {
		const refs = await listProgramRefs(this.cwd, this.settings);
		for (const ref of refs) {
			const ledger = await loadLedger(ref.absDir);
			if (ledger?.status === "active") {
				await this.activate(ref);
				return;
			}
		}
		this.refreshUi();
	}

	async activate(ref: ProgramRef): Promise<void> {
		let ledger = await loadLedger(ref.absDir);
		if (!ledger) {
			ledger = await adoptProgram({ cwd: this.cwd, settings: this.settings, ref });
		}
		// Backfill fields introduced after this ledger was written (atlas,
		// reviewerResume) so resumed programs pick up current behaviour.
		if (migrateLedger(ledger, this.settings)) {
			await appendProgress(ref.absDir, "ledger migrated (atlas / reviewer-resume)");
		}
		this.active = { slug: ref.slug, absDir: ref.absDir, ledger };
		// Pick up file-driven edits (folded/dropped cards, rewired deps) at session
		// start instead of waiting for an explicit sync.
		const syncResult = await this.syncFromDisk().catch(() => undefined);
		if (syncResult && !syncResult.ok && syncResult.text.length > 0) {
			this.sessionCtx?.ui.notify(`Work program: ${oneLine(syncResult.text, 200)}`, "warning");
		}
		// The worker briefs point at the operator todo file; make sure it exists
		// (verbatim header, created once — never touches existing content).
		await ensureOperatorTodoFile({
			readFile: (path) => readTextOrUndefined(path),
			writeFile: (path, content) => writeTextAtomic(path, content),
			cwd: this.cwd,
		});
		this.recoverStuckCards(ledger);
		rearmPackets(ledger);
		await this.save();
		this.pi.appendEntry(SESSION_ENTRY_TYPE, { slug: ref.slug, dir: ref.relDir });
		this.pi.setSessionName(`wp: ${ledger.slug}`);
		await appendProgress(ref.absDir, `session attached (${ledger.order.length} cards)`);
		this.startTick();
		this.refreshUi();
		if (ledger.status === "active") this.scheduleDrive();
	}

	async shutdownProgram(): Promise<void> {
		this.active = undefined;
		this.refreshUi();
	}

	/* ------------------------------------------------------------------ */
	/* DriverHost implementation                                           */
	/* ------------------------------------------------------------------ */

	get cwd(): string {
		return this.sessionCtx?.cwd ?? process.cwd();
	}

	get programDir(): string {
		return this.active?.absDir ?? "";
	}

	get ledger(): ProgramLedger {
		if (!this.active) throw new Error("no active work program");
		return this.active.ledger;
	}

	async save(): Promise<void> {
		if (!this.active) return;
		this.active.ledger.updatedAt = Date.now();
		await saveLedger(this.active.absDir, this.active.ledger);
	}

	refreshUi(): void {
		const ui = this.sessionCtx?.ui;
		if (!ui) return;
		if (!this.active) {
			ui.setStatus("work-program", undefined);
			ui.setWidget("work-program", undefined);
			return;
		}
		if (this.active.ledger.status !== "active" && this.active.ledger.status !== "paused") {
			// Completed programs go quiet: the agent delivers the summary + close
			// question as a normal message, and the records wait for an explicit close.
			ui.setStatus("work-program", undefined);
			ui.setWidget("work-program", undefined);
			return;
		}
		const { done, total, blocked, abandoned } = counts(this.active.ledger);
		const todoSummary = summarizeTodosSync(this.cwd, this.active.slug);
		const blockingTodos = todoSummary?.blocking ?? [];
		ui.setStatus(
			"work-program",
			`wp ${this.active.slug} ${done}/${total}${abandoned > 0 ? ` · ${abandoned} dropped` : ""}${blocked > 0 ? ` · ${blocked} blocked` : ""}${blockingTodos.length > 0 ? ` · !${blockingTodos.length} todo${blockingTodos.length === 1 ? "" : "s"}` : ""}${this.deps && !this.deps.ok ? " · blocked (deps)" : ""}`,
		);
		const lines = [`${this.active.slug} · ${this.active.ledger.mode}`, this.boardText()];
		// Blocking human input leads: it is the one thing agents cannot resolve.
		for (const item of blockingTodos.slice(0, 2)) {
			lines.push(`! ${item.id} blocks ${item.card ?? "—"}: ${oneLine(item.title, 48)}`);
		}
		for (const id of this.active.ledger.order) {
			const card = this.active.ledger.cards[id];
			if (!card?.activeRun) continue;
			if (lines.length >= 5) break;
			lines.push(`◔ ${card.id} ${card.phase} · ${this.snapshotLine(card)}`);
		}
		if (todoSummary && blockingTodos.length === 0 && todoSummary.open.length > 0 && lines.length < 7) {
			lines.push(`☐ ${todoSummary.open.length} operator todo(s) — work_program todos`);
		}
		for (const decision of openDecisions(this.active.ledger).slice(0, 2)) {
			lines.push(`! ${decision.message ?? "decision required"}`);
		}
		ui.setWidget("work-program", lines);
	}

	boardText(): string {
		if (!this.active) return "(no active work program)";
		return this.active.ledger.order
			.map((id) => `${id}${phaseSymbol(this.active?.ledger.cards[id]?.phase ?? "pending")}`)
			.join(" ");
	}

	private buildPorts(): DriverPorts {
		return {
			readFile: async (path) => (await readTextOrUndefined(path)) ?? "",
			writeFile: writeTextAtomic,
			appendProgress: async (line) => {
				if (this.active) await appendProgress(this.active.absDir, line);
			},
			notify: (message, level) => this.sessionCtx?.ui.notify(message, level ?? "info"),
			ask: (message) => {
				this.pi.sendMessage(
					{ customType: DECISION_CUSTOM_TYPE, content: message, display: true },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			sessionIdle: () => this.sessionIdle(),
			git: this.git,
			gates: this.gates,
			runs: this.runs,
			persist: async (ledger) => {
				if (this.active) await saveLedger(this.active.absDir, ledger);
			},
			readCard: async (_ledger, card) => (await readTextOrUndefined(this.cardFilePath(card))) ?? "",
			writeCard: async (_ledger, card, content) => writeTextAtomic(this.cardFilePath(card), content),
			worktreeBase: () => this.worktreeBaseFor(),
			runCwd: (_ledger, card) => this.runCwdFor(card),
		};
	}

	private cardFilePath(card: CardLedger): string {
		return join(this.programDir, card.path);
	}

	private runCwdFor(card: CardLedger): string {
		if (this.active?.ledger.parallelExecution === "worktrees" && card.lane) return card.lane.path;
		return this.cwd;
	}

	/** Commit the program records (plan, cards, progress) in the main checkout. */
	async commitRecords(message: string): Promise<string | undefined> {
		if (!this.active) return undefined;
		const paths = [join(this.active.absDir, "plan.md"), join(this.active.absDir, "progress.md")];
		for (const id of this.active.ledger.order) {
			const card = this.active.ledger.cards[id];
			if (card) paths.push(join(this.active.absDir, card.path));
		}
		const existing = paths.filter((path) => path !== undefined);
		try {
			const { commit, skipped } = await this.git.commitRecords(this.cwd, message, existing);
			if (skipped.length > 0) {
				this.sessionCtx?.ui.notify(
					`Work program: program records not committed (${skipped.length} path(s) ignored or missing); records remain on disk untracked.`,
					"warning",
				);
			}
			return commit;
		} catch (error) {
			this.sessionCtx?.ui.notify(
				`Work program: could not commit program records (${oneLine(String(error), 120)}); records remain on disk untracked.`,
				"warning",
			);
			return undefined;
		}
	}

	private worktreeBaseFor(): string {
		const base = this.settings.worktreeDir ?? defaultWorktreeDir(this.cwd);
		return join(resolve(base), this.active?.slug ?? "program");
	}

	/* ------------------------------------------------------------------ */
	/* Drive scheduling                                                    */
	/* ------------------------------------------------------------------ */

	scheduleDrive(): void {
		if (!this.active || this.active.ledger.status !== "active") return;
		if (this.deps && !this.deps.ok) return;
		this.driveQueued = true;
		if (this.driving) return;
		void this.driveLoop();
	}

	private async driveLoop(): Promise<void> {
		this.driving = true;
		try {
			while (this.driveQueued) {
				this.driveQueued = false;
				if (!this.active || this.active.ledger.status !== "active") break;
				try {
					await drive(this);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.sessionCtx?.ui.notify(`Work program drive error: ${message}`, "error");
				}
			}
		} finally {
			this.driving = false;
			this.refreshUi();
		}
	}

	/* ------------------------------------------------------------------ */
	/* Recovery                                                            */
	/* ------------------------------------------------------------------ */

	private recoverStuckCards(ledger: ProgramLedger): void {
		for (const id of ledger.order) {
			const card = ledger.cards[id];
			if (!card) continue;
			if (card.phase === "verifying" && !card.activeRun) {
				const failed = (card.gates ?? []).some((gate) => gate.code !== 0);
				card.phase = failed ? "fixing" : "review_pending";
				continue;
			}
			if (["implementing", "reviewing", "fixing", "reconciling"].includes(card.phase) && !card.activeRun) {
				const wasPhase = card.phase;
				card.phase = "blocked";
				card.lastError = "run state was lost across sessions; needs a decision";
				createDecision(
					{ programDir: this.programDir, ledger },
					{
						kind: "blocked",
						card: id,
						message: `Card ${id} was mid-${wasPhase} when the session ended and its run is not tracked.`,
						expectedAction: `work_program({ action: "unblock", card: "${id}", resolution: "redispatch" | "done" | "abandon" })`,
					},
				);
				continue;
			}
			if (card.phase === "triaging" && !openDecisionFor(ledger, id)) {
				card.phase = "pending";
				card.lastError = "review triage state was lost; needs a decision";
				createDecision(
					{ programDir: this.programDir, ledger },
					{
						kind: "blocked",
						card: id,
						message: `Card ${id} had an untriaged review; the review artifact is in ${ledger.dir}/.runtime/reviews/.`,
						expectedAction: `work_program({ action: "unblock", card: "${id}", resolution: "redispatch" | "done" | "abandon" })`,
					},
				);
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Operations                                                          */
	/* ------------------------------------------------------------------ */

	async suggestWorkProgram(input: {
		title: string;
		brief: string;
		mode?: Mode;
		confirmed?: boolean;
	}): Promise<ActionResult> {
		if (!this.deps?.ok) {
			return {
				ok: false,
				text: `Work programs are blocked. Missing: ${this.deps?.missing.join(", ") ?? "unknown"}. Install with: ${this.deps?.hints.join(" && ") ?? ""}`,
			};
		}
		if (this.active) {
			return { ok: false, text: `A work program is already active: ${this.active.slug}. Pause or close it first.` };
		}
		const ctx = this.sessionCtx;
		if (!ctx) return { ok: false, text: "No active session context." };
		const details = input.brief.trim().length > 0 ? input.brief.trim() : "(no brief provided)";
		const confirmed = input.confirmed === true
			? true
			: ctx.hasUI
				? await ctx.ui.confirm(`Create a work program?`, `"${input.title}"\n\n${details}`)
				: true;
		if (!confirmed) return { ok: true, text: "Work program creation declined." };
		let mode: Mode = input.mode ?? this.settings.mode;
		if (ctx.hasUI && !input.mode) {
			const choice = await ctx.ui.select(
				"Orchestration mode",
				MODE_LABELS.map((entry) => entry.label),
			);
			const matched = MODE_LABELS.find((entry) => entry.label === choice);
			if (matched) mode = matched.mode;
		}
		const refs = await listProgramRefs(this.cwd, this.settings);
		const baseSlug = slugify(input.title);
		let slug = baseSlug;
		let counter = 2;
		while (refs.some((ref) => ref.slug === slug)) {
			slug = `${baseSlug}-${counter}`;
			counter += 1;
		}
		const overrides: ProgramConfigOverrides = { mode };
		const ref = await scaffoldProgram({
			cwd: this.cwd,
			settings: this.settings,
			slug,
			title: input.title,
			brief: input.brief,
			configComment: stringifyFrontmatter(overridesToPlanFrontmatter(overrides)),
		});
		const settings = applyOverrides(this.settings, overrides);
		const ledger = buildLedger({
			slug,
			title: input.title,
			dir: ref.relDir,
			settings,
			overrides,
			baseBranch: await this.git.currentBranch(this.cwd),
			baseCommit: await this.git.head(this.cwd),
			cards: [],
			planText: "",
		});
		ledger.status = "planning";
		this.active = { slug, absDir: ref.absDir, ledger };
		await saveLedger(ref.absDir, ledger);
		this.pi.appendEntry(SESSION_ENTRY_TYPE, { slug, dir: ref.relDir });
		this.pi.setSessionName(`wp: ${slug}`);
		this.refreshUi();
		return { ok: true, text: planInstructions(ref.absDir) };
	}

	async finalizePlan(): Promise<ActionResult> {
		const depError = this.requireDependencies();
		if (depError) return { ok: false, text: depError };
		const active = this.active;
		if (!active) return { ok: false, text: "No active work program." };
		if (active.ledger.status !== "planning" && active.ledger.status !== "paused" && active.ledger.status !== "active") {
			return { ok: false, text: `Program is ${active.ledger.status}; cannot finalize.` };
		}
		const running = Object.values(active.ledger.cards).filter((card) => card.activeRun || card.lane);
		if (running.length > 0) {
			return {
				ok: false,
				text: `Cannot re-finalize while cards have lanes or running work (${running.map((card) => card.id).join(", ")}). Pause or wait, then use sync for record edits.`,
			};
		}
		const planText = await readPlan(active.absDir);
		const cardFiles = await listCardFiles(active.absDir);
		const validation = validatePlanFiles(planText, cardFiles);
		if (validation.problems.length > 0) {
			return { ok: false, text: formatProblems(validation.problems, validation.warnings) };
		}
		const overrides = configOverridesFromPlan(planText);
		const settings = applyOverrides(this.settings, overrides);
		const existing = active.ledger;
		const ledger = buildLedger({
			slug: active.slug,
			title: validation.plan.title.replace(/^Work program\s*[—:-]\s*/i, "") || active.slug,
			dir: active.ledger.dir,
			settings,
			overrides,
			baseBranch: existing.baseBranch || (await this.git.currentBranch(this.cwd)),
			baseCommit: existing.baseCommit || (await this.git.head(this.cwd)),
			cards: validation.cards,
			planText,
			existing,
		});
		ledger.decisions = existing.decisions;
		ledger.mergeQueue = existing.mergeQueue;
		ledger.programGate = existing.programGate;
		// Finalize validates and stages only — it never starts execution.
		// The operator must review the plan/cards and explicitly start via resume.
		ledger.status = "paused";
		this.active = { ...active, ledger };
		await this.save();
		await appendProgress(active.absDir, `plan finalized — ${validation.cards.length} cards (${ledger.mode}, parallel ${ledger.maxParallel}) — staged`);
		await this.commitRecords(`wp(${ledger.slug}): plan — ${validation.cards.length} cards`);
		this.refreshUi();
		const warnings = validation.warnings.length > 0 ? `\n${formatProblems([], validation.warnings)}` : "";
		return {
			ok: true,
			text: `Plan validated: ${validation.cards.length} cards (${ledger.mode}, maxParallel ${ledger.maxParallel}, ${ledger.parallelExecution}). Execution is NOT started. STOP here: present the plan and cards to the operator for review and wait for an explicit start. Only after the operator explicitly says to start, call work_program({ action: "resume" }).${warnings}`,
		};
	}

	async syncFromDisk(): Promise<ActionResult> {
		const active = this.active;
		if (!active) return { ok: false, text: "No active work program." };
		const planText = await readPlan(active.absDir);
		const cardFiles = await listCardFiles(active.absDir);
		const validation = validatePlanFiles(planText, cardFiles);
		const notes = await syncCards(active.ledger, validation.cards, planText, {
			onRemoved: (card) => planCardRemoval(this, card),
		});
		const overrides = configOverridesFromPlan(planText);
		const settings = applyOverrides(this.settings, overrides);
		if (overrides.mode) active.ledger.mode = overrides.mode;
		if (overrides.maxParallel !== undefined) active.ledger.maxParallel = settings.maxParallel;
		if (overrides.parallelExecution) active.ledger.parallelExecution = overrides.parallelExecution;
		if (overrides.laneBranchPattern) active.ledger.laneBranchPattern = overrides.laneBranchPattern;
		if (overrides.reviewProfile) active.ledger.reviewProfile = settings.review.profile;
		if (overrides.maxCycles !== undefined) active.ledger.maxCycles = settings.review.maxCycles;
		active.ledger.workerAgent = settings.worker.agent;
		active.ledger.workerModel = settings.worker.model;
		active.ledger.workerThinking = settings.worker.thinking;
		active.ledger.reviewerAgent = settings.review.agent;
		active.ledger.reviewerModel = settings.reviewer.model;
		active.ledger.reviewerThinking = settings.reviewer.thinking;
		active.ledger.reviewerResume = settings.review.resumeReviewer !== false;
		active.ledger.runTimeoutMs = settings.runTimeoutMs;
		// Atlas config keys follow plan front matter; runtime state (state, runId,
		// pendingMerges, refreshes, usage) is never touched by a sync.
		if (active.ledger.atlas) {
			active.ledger.atlas.enabled = settings.atlas?.enabled ?? true;
			if (settings.atlas?.agent) active.ledger.atlas.agent = settings.atlas.agent;
			if (settings.atlas?.model) active.ledger.atlas.model = settings.atlas.model;
			else delete active.ledger.atlas.model;
			if (settings.atlas?.thinking) active.ledger.atlas.thinking = settings.atlas.thinking;
			else delete active.ledger.atlas.thinking;
		}
		active.ledger.gates = { card: [...settings.gates.card], program: [...settings.gates.program] };
		// Import worker-inbox todos (blocking ones park + announce via the drive path).
		await syncTodoStore(this);
		await this.save();
		this.scheduleDrive();
		const problems = validation.problems.length > 0 ? `\n${formatProblems(validation.problems, [])}` : "";
		return { ok: true, text: `Synced.${notes.length > 0 ? ` ${notes.join("; ")}` : ""}${problems}` };
	}

	async startProgram(target: string): Promise<ActionResult> {
		const depError = this.requireDependencies();
		if (depError) return { ok: false, text: depError };
		if (this.active) {
			if (this.active.slug === target) {
				// Same program already loaded: "start" is the operator asking for motion,
				// so resume instead of refusing with "already active".
				const resumed = await this.resume();
				return resumed.ok ? { ok: true, text: `${resumed.text} (already loaded; start = resume)` } : resumed;
			}
			return {
				ok: false,
				text: `Already active: ${this.active.slug} (${this.active.ledger.status}). Resume it with /work-program resume, or pause/close it before starting ${target}.`,
			};
		}
		const refs = await listProgramRefs(this.cwd, this.settings);
		const ref =
			refs.find((entry) => entry.slug === target) ??
			refs.find((entry) => entry.absDir === resolve(this.cwd, target));
		if (!ref) return { ok: false, text: `No work program named "${target}" under ${this.settings.dir}.` };
		await this.activate(ref);
		return { ok: true, text: `Activated work program ${ref.slug}.` };
	}

	async pause(hard = false): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const ledger = this.active.ledger;
		const flying = Object.values(ledger.cards).filter((card) => card.activeRun);
		if (!hard) {
			ledger.status = "paused";
			await this.save();
			await appendProgress(
				this.active.absDir,
				`paused (soft)${flying.length > 0 ? ` — in flight: ${flying.map((card) => `${card.id} ${card.activeRun?.kind}`).join(", ")}` : ""}`,
			);
			this.refreshUi();
			return {
				ok: true,
				text: `Paused ${ledger.slug} (soft). In-flight runs keep going; resume reconciles their results.`,
			};
		}
		const stopped: string[] = [];
		const unstopped: string[] = [];
		for (const card of flying) {
			const run = card.activeRun;
			if (!run) continue;
			try {
				await this.runs.stop(run.runId);
				card.activeRun = undefined;
				stopped.push(`${card.id} ${run.kind}`);
			} catch (error) {
				// Leave the run and phase untouched: a live writer plus a resumed
				// duplicate would violate one-writer-per-lane. It reconciles on resume.
				unstopped.push(`${card.id} ${run.kind} (${oneLine(String(error), 100)})`);
			}
		}
		const rearmed = rearmPausedCards(this);
		// A scout run is program-level, not card-level: stop and rearm it the same
		// way (building → redispatch on resume; refreshing → stays ready, pending
		// merges preserved and re-sent on the next drive tick).
		const atlas = ledger.atlas;
		if (atlas?.enabled && (atlas.state === "building" || atlas.state === "refreshing") && atlas.runId) {
			try {
				await this.runs.stop(atlas.runId);
				stopped.push("atlas scout");
				atlas.state = atlas.state === "building" ? undefined : "ready";
				atlas.startedAt = undefined;
			} catch (error) {
				unstopped.push(`atlas scout (${oneLine(String(error), 100)})`);
			}
		}
		ledger.status = "paused";
		await this.save();
		await appendProgress(
			this.active.absDir,
				`paused (hard)${stopped.length > 0 ? ` — stopped: ${stopped.join(", ")}` : ""}${rearmed.length > 0 ? `; rearmed: ${rearmed.join(", ")}` : ""}${unstopped.length > 0 ? `; unstopped: ${unstopped.join(", ")}` : ""}`,
			);
		this.refreshUi();
		this.sessionCtx?.ui.notify(`Work program: hard-paused ${ledger.slug} — stopped ${stopped.length} run(s)`, "warning");
		return {
			ok: true,
			text: `Paused ${ledger.slug} (hard). Stopped ${stopped.length} run(s); cards rearmed (${rearmed.join(", ") || "none"}).${unstopped.length > 0 ? ` Could not stop: ${unstopped.join(", ")} — left running, reconciles on resume.` : " Resume to restart."}`,
		};
	}

	async resume(): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		this.active.ledger.status = "active";
		// Rearm before syncing: sync may schedule a drive tick, and rearm is
		// synchronous, so run-less flight phases are normalized first either way.
		const rearmed = rearmPausedCards(this);
		await this.syncFromDisk();
		await appendProgress(
			this.active.absDir,
			`resumed${rearmed.length > 0 ? ` — rearmed: ${rearmed.join(", ")}` : ""}`,
		);
		await this.save();
		this.scheduleDrive();
		this.refreshUi();
		return { ok: true, text: `Resumed ${this.active.slug}.` };
	}

	async setMode(mode: Mode): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const busy = Object.values(this.active.ledger.cards).some((card) => card.activeRun);
		if (busy) return { ok: false, text: "Cannot change mode while runs are in flight; pause first." };
		this.active.ledger.mode = mode;
		await this.save();
		await appendProgress(this.active.absDir, `mode → ${mode}`);
		this.refreshUi();
		return { ok: true, text: `Mode set to ${mode}.` };
	}

	/**
	 * Retune a running program: review rounds, profile, parallelism, mode, models.
	 * Applies to the live ledger, persists into the plan's front matter (so
	 * `sync` and reload keep it), records a progress line, and — when
	 * `onExhausted: "accept"` is set — resolves open cycle decisions instead of
	 * making the orchestrator answer them one by one.
	 */
	async setConfig(patch: ProgramConfigPatch): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		if (patch.card !== undefined) return this.setCardConfig(patch.card, patch);
		const ledger = this.active.ledger;
		const overrides: ProgramConfigOverrides = {};
		const changes: string[] = [];
		if (patch.mode !== undefined) {
			if (!isMode(patch.mode)) return { ok: false, text: `mode must be session | managed | captain` };
			const busy = Object.values(ledger.cards).some((card) => card.activeRun);
			if (busy && patch.mode !== ledger.mode) {
				return { ok: false, text: "Cannot change mode while runs are in flight; pause first (or set the other knobs)." };
			}
			if (patch.mode !== ledger.mode) changes.push(`mode ${ledger.mode}→${patch.mode}`);
			overrides.mode = patch.mode;
		}
		if (patch.reviewProfile !== undefined) {
			if (!isReviewProfile(patch.reviewProfile)) return { ok: false, text: "reviewProfile must be light | enhanced" };
			if (patch.reviewProfile !== ledger.reviewProfile) {
				changes.push(`reviewProfile ${ledger.reviewProfile}→${patch.reviewProfile}`);
			}
			overrides.reviewProfile = patch.reviewProfile;
		}
		if (patch.maxCycles !== undefined) {
			const cycles = Math.floor(patch.maxCycles);
			if (!Number.isFinite(cycles) || cycles < 0 || cycles > 32) {
				return { ok: false, text: "maxCycles must be a number between 0 and 32" };
			}
			if (cycles !== ledger.maxCycles) changes.push(`maxCycles ${ledger.maxCycles}→${cycles}`);
			overrides.maxCycles = cycles;
		}
		if (patch.onExhausted !== undefined) {
			if (patch.onExhausted !== "ask" && patch.onExhausted !== "accept" && patch.onExhausted !== "block") {
				return { ok: false, text: "onExhausted must be ask | accept | block" };
			}
			if (patch.onExhausted !== ledger.onExhausted) {
				changes.push(`onExhausted ${ledger.onExhausted}→${patch.onExhausted}`);
			}
		}
		if (patch.maxParallel !== undefined) {
			const parallel = Math.floor(patch.maxParallel);
			if (!Number.isFinite(parallel) || parallel < 1 || parallel > 32) {
				return { ok: false, text: "maxParallel must be between 1 and 32" };
			}
			if (parallel !== ledger.maxParallel) changes.push(`maxParallel ${ledger.maxParallel}→${parallel}`);
			overrides.maxParallel = parallel;
		}
		if (patch.parallelExecution !== undefined) {
			if (!isParallelExecution(patch.parallelExecution)) {
				return { ok: false, text: "parallelExecution must be worktrees | direct" };
			}
			if (patch.parallelExecution !== ledger.parallelExecution) {
				changes.push(`parallelExecution ${ledger.parallelExecution}→${patch.parallelExecution}`);
			}
			overrides.parallelExecution = patch.parallelExecution;
		}
		if (patch.workerAgent !== undefined) {
			changes.push(`workerAgent ${ledger.workerAgent}→${patch.workerAgent}`);
			overrides.workerAgent = patch.workerAgent;
		}
		if (patch.workerModel !== undefined) {
			changes.push(`workerModel ${ledger.workerModel ?? "(default)"}→${patch.workerModel === "" ? "(default)" : patch.workerModel}`);
			overrides.workerModel = patch.workerModel;
		}
		if (patch.workerThinking !== undefined) {
			changes.push(`workerThinking ${ledger.workerThinking ?? "(default)"}→${patch.workerThinking === "" ? "(default)" : patch.workerThinking}`);
			overrides.workerThinking = patch.workerThinking;
		}
		if (patch.reviewerAgent !== undefined) {
			changes.push(`reviewerAgent ${ledger.reviewerAgent}→${patch.reviewerAgent}`);
			overrides.reviewerAgent = patch.reviewerAgent;
		}
		if (patch.reviewerModel !== undefined) {
			changes.push(`reviewerModel ${ledger.reviewerModel ?? "(default)"}→${patch.reviewerModel === "" ? "(default)" : patch.reviewerModel}`);
			overrides.reviewerModel = patch.reviewerModel;
		}
		if (patch.reviewerThinking !== undefined) {
			changes.push(`reviewerThinking ${ledger.reviewerThinking ?? "(default)"}→${patch.reviewerThinking === "" ? "(default)" : patch.reviewerThinking}`);
			overrides.reviewerThinking = patch.reviewerThinking;
		}
		if (patch.reviewerResume !== undefined) {
			if (typeof patch.reviewerResume !== "boolean") return { ok: false, text: "reviewerResume must be a boolean" };
			if (patch.reviewerResume !== ledger.reviewerResume) {
				changes.push(`reviewerResume ${ledger.reviewerResume !== false}→${patch.reviewerResume}`);
			}
			overrides.reviewerResume = patch.reviewerResume;
		}
		if (patch.runTimeoutMs !== undefined) {
			const timeout = Math.floor(patch.runTimeoutMs);
			if (!Number.isFinite(timeout) || timeout < 60_000) {
				return { ok: false, text: "runTimeoutMs must be at least 60000 (1 minute)" };
			}
			if (timeout !== ledger.runTimeoutMs) changes.push(`runTimeoutMs ${ledger.runTimeoutMs ?? "(default)"}→${timeout}`);
			overrides.runTimeoutMs = timeout;
		}
		if (patch.atlasEnabled !== undefined) {
			if (typeof patch.atlasEnabled !== "boolean") return { ok: false, text: "atlasEnabled must be a boolean" };
			if (patch.atlasEnabled !== (ledger.atlas?.enabled ?? true)) {
				changes.push(`atlas ${ledger.atlas?.enabled !== false ? "on" : "off"}→${patch.atlasEnabled ? "on" : "off"}`);
			}
			overrides.atlasEnabled = patch.atlasEnabled;
		}
		if (patch.atlasAgent !== undefined) {
			changes.push(`atlasAgent ${ledger.atlas?.agent ?? "scout"}→${patch.atlasAgent === "" ? "(default)" : patch.atlasAgent}`);
			overrides.atlasAgent = patch.atlasAgent;
		}
		if (patch.atlasModel !== undefined) {
			changes.push(`atlasModel ${ledger.atlas?.model ?? "(default)"}→${patch.atlasModel === "" ? "(default)" : patch.atlasModel}`);
			overrides.atlasModel = patch.atlasModel;
		}
		if (patch.atlasThinking !== undefined) {
			changes.push(`atlasThinking ${ledger.atlas?.thinking ?? "(default)"}→${patch.atlasThinking === "" ? "(default)" : patch.atlasThinking}`);
			overrides.atlasThinking = patch.atlasThinking;
		}
		if (Object.keys(overrides).length === 0 && patch.onExhausted === undefined) {
			return { ok: false, text: "Nothing to change; pass at least one of maxCycles, onExhausted, reviewProfile, maxParallel, parallelExecution, mode, workerAgent, workerModel, workerThinking, reviewerAgent, reviewerModel, reviewerThinking, reviewerResume, runTimeoutMs, atlasEnabled, atlasAgent, atlasModel, atlasThinking." };
		}

		// Apply to the live ledger via the same normalization the plan path uses.
		const settings = applyOverrides(this.settings, overrides);
		if (overrides.mode) ledger.mode = settings.mode;
		if (overrides.maxParallel !== undefined) ledger.maxParallel = settings.maxParallel;
		if (overrides.parallelExecution) ledger.parallelExecution = settings.parallelExecution;
		if (overrides.reviewProfile) ledger.reviewProfile = settings.review.profile;
		if (overrides.maxCycles !== undefined) ledger.maxCycles = settings.review.maxCycles;
		if (patch.onExhausted !== undefined) ledger.onExhausted = patch.onExhausted;
		if (patch.workerAgent !== undefined) ledger.workerAgent = settings.worker.agent;
		if (patch.workerModel !== undefined) ledger.workerModel = patch.workerModel === "" ? undefined : patch.workerModel;
		if (patch.workerThinking !== undefined) ledger.workerThinking = patch.workerThinking === "" ? undefined : patch.workerThinking;
		if (patch.reviewerAgent !== undefined) ledger.reviewerAgent = settings.review.agent;
		if (patch.reviewerModel !== undefined) ledger.reviewerModel = patch.reviewerModel === "" ? undefined : patch.reviewerModel;
		if (patch.reviewerThinking !== undefined) ledger.reviewerThinking = patch.reviewerThinking === "" ? undefined : patch.reviewerThinking;
		if (patch.reviewerResume !== undefined) ledger.reviewerResume = patch.reviewerResume;
		if (patch.runTimeoutMs !== undefined) ledger.runTimeoutMs = patch.runTimeoutMs;
		if (
			patch.atlasEnabled !== undefined ||
			patch.atlasAgent !== undefined ||
			patch.atlasModel !== undefined ||
			patch.atlasThinking !== undefined
		) {
			const atlas = ledger.atlas ?? { enabled: true, pendingMerges: [], refreshes: 0 };
			if (patch.atlasEnabled !== undefined) atlas.enabled = patch.atlasEnabled;
			if (patch.atlasAgent !== undefined && patch.atlasAgent !== "") atlas.agent = patch.atlasAgent;
			if (patch.atlasModel !== undefined) {
				if (patch.atlasModel === "") delete atlas.model;
				else atlas.model = patch.atlasModel;
			}
			if (patch.atlasThinking !== undefined) {
				if (patch.atlasThinking === "") delete atlas.thinking;
				else atlas.thinking = patch.atlasThinking;
			}
			// A config change resurrects a failed atlas: next drive rebuilds it.
			if (atlas.state === "failed") {
				atlas.state = undefined;
				atlas.lastError = undefined;
			}
			ledger.atlas = atlas;
		}

		// Persist into the plan so sync/reload keep the change.
		const planText = await readPlan(this.active.absDir);
		if (planText.trim().length > 0) {
			await writeTextAtomic(join(this.active.absDir, PLAN_FILE), mergePlanConfig(planText, overrides));
		}

		// Accept-on-exhaustion makes pending cycle decisions answerable in bulk.
		let accepted = 0;
		if (patch.onExhausted === "accept") {
			for (const decision of openDecisions(ledger)) {
				if (decision.kind !== "cycle-exhausted" || !decision.card) continue;
				const card = ledger.cards[decision.card];
				if (!card || card.phase !== "triaging") continue;
				resolveDecision(this, decision.id);
				card.phase = "approved";
				accepted += 1;
			}
		}

		await this.save();
		if (changes.length > 0 || accepted > 0) {
			await appendProgress(
				this.active.absDir,
				`config: ${changes.join(", ")}${accepted > 0 ? `${changes.length > 0 ? "; " : ""}${accepted} cycle decision(s) accepted` : ""}`,
			);
		}
		this.refreshUi();
		this.scheduleDrive();
		return {
			ok: true,
			text: `Config updated: ${changes.length > 0 ? changes.join(", ") : "(no effective change)"}.${accepted > 0 ? ` Accepted ${accepted} open cycle decision(s).` : ""}`,
		};
	}

	/**
	 * Retune one card: reviewProfile, maxCycles, worker/reviewer agent+model+thinking.
	 * Applies to the live ledger row and persists into the card file's front
	 * matter (so `sync` and reload keep it). An empty-string model/thinking
	 * clears the override so the card inherits the program default.
	 */
	async setCardConfig(cardId: string, patch: ProgramConfigPatch): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const card = this.active.ledger.cards[cardId];
		if (!card) return { ok: false, text: `Unknown card ${cardId}.` };
		for (const key of ["mode", "maxParallel", "parallelExecution", "onExhausted", "reviewerResume", "runTimeoutMs", "atlasEnabled", "atlasAgent", "atlasModel", "atlasThinking"] as const) {
			if (patch[key] !== undefined) {
				return { ok: false, text: `${key} is program-level; omit card to set it (work_program({ action: "config", ${key}: ... }))` };
			}
		}
		const changes: string[] = [];
	const frontPatch: Record<string, unknown> = {};
		if (patch.reviewProfile !== undefined) {
			if (!isReviewProfile(patch.reviewProfile)) return { ok: false, text: "reviewProfile must be light | enhanced" };
			const before = card.reviewProfile ?? this.active.ledger.reviewProfile;
			if (before !== patch.reviewProfile) changes.push(`card ${cardId} review ${before}→${patch.reviewProfile}`);
			card.reviewProfile = patch.reviewProfile;
			frontPatch.review = patch.reviewProfile;
		}
		if (patch.maxCycles !== undefined) {
			const cycles = Math.floor(patch.maxCycles);
			if (!Number.isFinite(cycles) || cycles < 0 || cycles > 32) {
				return { ok: false, text: "maxCycles must be a number between 0 and 32" };
			}
			const before = card.maxCycles ?? this.active.ledger.maxCycles;
			if (before !== cycles) changes.push(`card ${cardId} maxCycles ${before}→${cycles}`);
			card.maxCycles = cycles;
			frontPatch.maxCycles = cycles;
		}
		const modelKeys = ["workerAgent", "workerModel", "workerThinking", "reviewerAgent", "reviewerModel", "reviewerThinking"] as const;
		let sawModelKey = false;
		for (const key of modelKeys) {
			const value = patch[key];
			if (value === undefined) continue;
			sawModelKey = true;
			const trimmed = value.trim();
			if (trimmed === "") {
				delete card[key];
				frontPatch[key] = undefined;
				changes.push(`card ${cardId} ${key} cleared (inherits program default)`);
				continue;
			}
			if ((card[key] ?? "") !== trimmed) changes.push(`card ${cardId} ${key} ${card[key] ?? "(default)"}→${trimmed}`);
			card[key] = trimmed;
			frontPatch[key] = trimmed;
		}
		if (changes.length === 0 && !sawModelKey && patch.reviewProfile === undefined && patch.maxCycles === undefined) {
			return { ok: false, text: `Nothing to change for card ${cardId}; pass reviewProfile, maxCycles, workerModel, workerThinking, reviewerModel, reviewerThinking (empty string clears a model override).` };
		}
		card.updatedAt = Date.now();
		// Persist into the card file so sync/reload keep the change.
		try {
			const cardPath = join(this.active.absDir, card.path);
			const text = (await readTextOrUndefined(cardPath)) ?? "";
			if (text.trim().length > 0) {
				const normalized = normalizeCardPatch(frontPatch);
				const fullPatch: Record<string, unknown> = { ...normalized };
				// Preserve explicit clears: normalize drops empty strings, so re-add undefined.
				for (const [key, value] of Object.entries(frontPatch)) {
					if (value === undefined) fullPatch[key] = undefined;
				}
				await writeTextAtomic(cardPath, mergeCardFrontmatter(text, fullPatch as Parameters<typeof mergeCardFrontmatter>[1]));
			}
		} catch (error) {
			return { ok: false, text: `Card ${cardId} ledger updated but the card file could not be written: ${oneLine(String(error), 140)}` };
		}
		await this.save();
		if (changes.length > 0) await appendProgress(this.active.absDir, `${cardId} config: ${changes.join(", ")}`);
		this.refreshUi();
		this.scheduleDrive();
		return { ok: true, text: `Card ${cardId} updated: ${changes.join(", ") || "(no effective change)"}.` };
	}

	/* ---- operator todos (structured, chat-driven) ---- */

	private todoStorePath(): string {
		return operatorTodosJsonPath(this.cwd);
	}

	private async readTodoStore(): Promise<TodoStore> {
		return parseTodoStore(await readTextOrUndefined(this.todoStorePath()));
	}

	private async writeTodoStore(store: TodoStore): Promise<void> {
		await writeTextAtomic(this.todoStorePath(), serializeTodoStore(store));
	}

	private liveTodoCard(cardId: string): CardLedger | undefined {
		const card = this.active?.ledger.cards[cardId];
		if (!card || card.phase === "done" || isAbandonedCard(card)) return undefined;
		return card;
	}

	async todoList(): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		return { ok: true, text: formatTodoList(await this.readTodoStore(), this.active.slug) };
	}

	async todoAdd(input: {
		title: string;
		body?: string;
		steps?: unknown;
		card?: string;
		blocking?: boolean;
	}): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const ledger = this.active.ledger;
		const title = input.title?.trim() ?? "";
		if (title.length === 0) return { ok: false, text: "todo_add requires a non-empty title" };
		if (title.length > 200) return { ok: false, text: "title must be 200 characters or fewer" };
		const body = (input.body ?? "").trim().slice(0, 4000);
		if (input.steps !== undefined && !Array.isArray(input.steps)) {
			return { ok: false, text: "steps must be an array of { text, command?, dangerous? }" };
		}
		const steps = normalizeTodoSteps(input.steps) ?? [];
		let card: CardLedger | undefined;
		if (input.card !== undefined) {
			card = ledger.cards[input.card];
			if (!card) return { ok: false, text: `Unknown card ${input.card}.` };
		}
		const live = card !== undefined && card.phase !== "done" && !isAbandonedCard(card);
		const blocking = input.blocking ?? live;
		if (blocking && !card) return { ok: false, text: "blocking todos need a card — pass card, or set blocking: false" };
		if (blocking && !live) return { ok: false, text: `card ${card?.id} is ${card?.phase}; only a live card can be blocked` };
		const store = await this.readTodoStore();
		const item = storeAddTodo(store, {
			title,
			body,
			steps,
			stream: this.active.slug,
			...(card ? { card: card.id } : {}),
			blocking,
		});
		// Created live in conversation: no separate wake-up needed.
		item.announced = true;
		await this.writeTodoStore(store);
		if (card && blocking) {
			card.waitingOn = Array.from(new Set([...(card.waitingOn ?? []), item.id]));
			await parkForTodos(this, buildTodoGate(store, ledger.slug), card, openBlockingForCard(store, ledger.slug, card.id), {});
		}
		await this.save();
		await appendProgress(
			this.active.absDir,
			card
				? `${card.id} todo ${item.id} added (blocking): ${oneLine(title, 60)}`
				: `todo ${item.id} added: ${oneLine(title, 60)}`,
		);
		this.refreshUi();
		this.scheduleDrive();
		return {
			ok: true,
			text: `Todo ${item.id} added${card && blocking ? ` — card ${card.id} parked until it resolves (todo_done ${item.id} when finished)` : ""}.`,
		};
	}

	async todoUpdate(input: {
		id: string;
		title?: string;
		body?: string;
		steps?: unknown;
		card?: string;
		blocking?: boolean;
	}): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const ledger = this.active.ledger;
		const store = await this.readTodoStore();
		const item = store.items.find((entry) => entry.id === input.id);
		if (!item) return { ok: false, text: `Unknown todo ${input.id}. Use todos to list.` };
		if (item.stream !== this.active.slug) {
			return { ok: false, text: `Todo ${input.id} belongs to stream ${item.stream}; switch programs first.` };
		}
		if (item.state !== "open") return { ok: false, text: `Todo ${input.id} is already ${item.state}.` };
		const patch: { title?: string; body?: string; steps?: TodoStep[]; card?: string; blocking?: boolean } = {};
		const changes: string[] = [];
		if (input.title !== undefined) {
			const title = input.title.trim();
			if (title.length === 0) return { ok: false, text: "title cannot be empty" };
			if (title.length > 200) return { ok: false, text: "title must be 200 characters or fewer" };
			if (title !== item.title) changes.push("title");
			patch.title = title;
		}
		if (input.body !== undefined) {
			patch.body = input.body.trim().slice(0, 4000);
			if (patch.body !== item.body) changes.push("body");
		}
		if (input.steps !== undefined) {
			if (!Array.isArray(input.steps)) return { ok: false, text: "steps must be an array of { text, command?, dangerous? }" };
			patch.steps = normalizeTodoSteps(input.steps) ?? [];
			changes.push(`steps (${patch.steps.length})`);
		}
		if (input.card !== undefined) {
			if (input.card.length > 0) {
				if (!ledger.cards[input.card]) return { ok: false, text: `Unknown card ${input.card}.` };
				if (input.card !== item.card) changes.push(`card ${item.card ?? "—"}→${input.card}`);
				patch.card = input.card;
			} else {
				if (item.card) changes.push(`card ${item.card}→—`);
				patch.card = "";
			}
		}
		if (input.blocking !== undefined) {
			if (input.blocking !== item.blocking) changes.push(input.blocking ? "blocking on" : "blocking off");
			patch.blocking = input.blocking;
		}
		if (changes.length === 0) return { ok: false, text: `Nothing to change for ${input.id}; pass title, body, steps, card, or blocking.` };
		const targetCard = patch.card !== undefined ? (patch.card.length > 0 ? patch.card : undefined) : item.card;
		const wantBlocking = patch.blocking ?? item.blocking;
		if (wantBlocking) {
			if (!targetCard) return { ok: false, text: `blocking todos need a card — pass card, or set blocking: false` };
			if (!this.liveTodoCard(targetCard)) {
				return { ok: false, text: `card ${targetCard} is not live; only a live card can be blocked` };
			}
		}
		storeUpdateTodo(store, item.id, patch);
		item.announced = true;
		await this.writeTodoStore(store);
		const gate = buildTodoGate(store, ledger.slug);
		if (wantBlocking && targetCard) {
			const card = ledger.cards[targetCard];
			if (card) {
				card.waitingOn = Array.from(new Set([...(card.waitingOn ?? []), item.id]));
				await parkForTodos(this, gate, card, openBlockingForCard(store, ledger.slug, card.id), {});
			}
		}
		// Release cards that no longer have open blocking todos (e.g. the old
		// card after a move, or this card after blocking was switched off).
		await resumeWaitingCards(this, gate);
		await this.save();
		await appendProgress(this.active.absDir, `${targetCard ?? "—"} todo ${item.id} updated (${changes.join(", ")})`);
		this.refreshUi();
		this.scheduleDrive();
		return { ok: true, text: `Todo ${item.id} updated: ${changes.join(", ")}.` };
	}

	private async closeTodo(id: string, state: "done" | "dropped", verb: string, note: string | undefined): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const store = await this.readTodoStore();
		const item = store.items.find((entry) => entry.id === id);
		if (!item) return { ok: false, text: `Unknown todo ${id}. Use todos to list.` };
		if (item.stream !== this.active.slug) {
			return { ok: false, text: `Todo ${id} belongs to stream ${item.stream}; switch programs first.` };
		}
		if (item.state === state) return { ok: true, text: `Todo ${id} is already ${state}.` };
		storeCloseTodo(store, id, state);
		await this.writeTodoStore(store);
		await resumeWaitingCards(this, buildTodoGate(store, this.active.slug));
		await this.save();
		await appendProgress(
			this.active.absDir,
			`${item.card ?? "—"} todo ${id} ${verb}${note?.trim() ? `: ${oneLine(note.trim(), 60)}` : ""}`,
		);
		this.refreshUi();
		this.scheduleDrive();
		return { ok: true, text: `Todo ${id} ${verb}.${item.card ? " Waiting cards resume on their own." : ""}` };
	}

	async todoDone(input: { id: string; note?: string }): Promise<ActionResult> {
		return this.closeTodo(input.id, "done", "done", input.note);
	}

	async todoDrop(input: { id: string; reason?: string }): Promise<ActionResult> {
		return this.closeTodo(input.id, "dropped", "dropped", input.reason);
	}

	async statusText(): Promise<string> {
		if (!this.active) return "No active work program. Use /work-program start <slug> or work_program({action:'list'}).";
		const ledger = this.active.ledger;
		const { done, total, blocked, abandoned } = counts(ledger);
		const lines = [
			`${ledger.title}`,
			`slug: ${ledger.slug} · status: ${ledger.status} · mode: ${ledger.mode} · ${done}/${total} done${abandoned ? ` · ${abandoned} dropped` : ""}${blocked ? ` · ${blocked} blocked` : ""}`,
			`parallel: ${ledger.parallelExecution} (max ${ledger.maxParallel}) · review: ${ledger.reviewProfile} · cycles: ${ledger.maxCycles}`,
			`dir: ${ledger.dir}`,
			...(atlasStatusLine(ledger) ? [atlasStatusLine(ledger)] : []),
			...(tokensStatusLine(ledger) ? [tokensStatusLine(ledger)] : []),
			"",
			"Cards:",
		];
		for (const id of ledger.order) {
			const card = ledger.cards[id];
			if (!card) continue;
			const deps = card.dependsOn.length > 0 ? ` (deps: ${card.dependsOn.join(",")})` : "";
			const parts: string[] = [];
			if (card.abandoned === true) {
				parts.push(card.lastError ? `dropped — ${oneLine(card.lastError, 90)}` : "dropped (scope abandoned)");
			}
			if (card.activeRun) parts.push(await this.heartbeatLine(card));
			if ((card.phase === "queued" || card.phase === "merging" || card.phase === "reconciling") && card.merge) {
				parts.push(`merge ${card.merge.state}${card.lane ? ` · lane ${card.lane.branch}` : ""}`);
			}
			if (card.fixReason !== undefined && card.phase !== "blocked") parts.push(`pending ${card.fixReason} fix`);
			if (isHeld(card)) {
				parts.push(`held until ${new Date(card.holdUntil ?? 0).toISOString().slice(11, 16)} UTC (${oneLine(card.holdReason ?? "provider quota", 80)})`);
			}
			if (card.lastError && card.abandoned !== true) parts.push(card.lastError);
			lines.push(
				`  ${phaseSymbol(card.phase, card.abandoned === true)} ${id} ${card.abandoned === true ? "abandoned" : card.phase}${deps}${parts.length > 0 ? ` — ${parts.join("; ")}` : ""}`,
			);
		}
		if (ledger.mergeQueue.length > 0) {
			lines.push(
				"",
				`Merge queue: ${ledger.mergeQueue.join(" → ")}${ledger.mergeQueuePaused ? " (paused — worktree dirty)" : ""}`,
			);
		}
		const todos = await this.operatorTodoSummary();
		if (todos && todos.open.length > 0) {
			lines.push("", `Operator todos (${ledger.slug}): ${todos.open.length} open${todos.blocking.length > 0 ? `, ${todos.blocking.length} blocking` : ""} — work_program({ action: "todos" }) to list`);
			for (const item of todos.open.slice(0, 6)) {
				lines.push(
					item.blocking
						? `  ! ${item.id} BLOCKS card ${item.card ?? "—"}: ${oneLine(item.title, 90)} — todo_done ${item.id} when finished`
						: `  · ${item.id}: ${oneLine(item.title, 90)}`,
				);
			}
		}
		try {
			const [unmerged, merging] = await Promise.all([
				this.git.unmergedPaths(this.cwd),
				this.git.merging(this.cwd),
			]);
			if (merging || unmerged.length > 0) {
				lines.push(
				`Merge in progress: ${unmerged.length} unmerged path(s)${unmerged.length > 0 ? ` (${unmerged.slice(0, 5).join(", ")})` : ""} — finish the merge or unblock the card to redispatch the reconciler`,
				);
			}
		} catch {
			// git unavailable — omit merge state rather than fail status.
		}
		const blockedCards = ledger.order
			.map((id) => ledger.cards[id])
			.filter((card): card is CardLedger => card?.phase === "blocked" && card.abandoned !== true);
		if (blockedCards.length > 0) {
			lines.push("", "Issues:");
			for (const card of blockedCards) {
				lines.push(`  ! ${card.id}: ${card.lastError ?? "blocked"}${unblockHint(card)}`);
			}
		}
		const decisions = openDecisions(ledger);
		if (decisions.length > 0) {
			lines.push("", "Open decisions:");
			for (const decision of decisions) lines.push(`  ${decision.id}: ${decision.message ?? ""}`);
		}
		return lines.join("\n");
	}

	async listPrograms(): Promise<string> {
		const refs = await listProgramRefs(this.cwd, this.settings);
		if (refs.length === 0) return `No work programs under ${this.settings.dir}.`;
		const lines: string[] = [];
		for (const ref of refs) {
			const ledger = await loadLedger(ref.absDir);
			lines.push(
				ledger
					? `- ${ref.slug} · ${ledger.status} · ${ledger.mode} · ${counts(ledger).done}/${ledger.order.length} · ${ref.relDir}`
					: `- ${ref.slug} · no ledger (use start to adopt) · ${ref.relDir}`,
			);
		}
		return lines.join("\n");
	}

	async doctor(): Promise<string> {
		const deps = this.deps ?? (await this.depsProbe.check());
		const lines = [
			`pi-work-programs doctor`,
			`cwd: ${this.cwd}`,
			`program dir setting: ${this.settings.dir}`,
			`pi-subagents: ${deps.subagents.ready ? "ready" : "MISSING"}${deps.subagents.version ? ` (rpc v${deps.subagents.version})` : ""}${deps.subagents.error ? ` — ${deps.subagents.error}` : ""}${deps.subagents.ready && !deps.subagents.tool ? " · note: the `subagent` tool is not visible to the model (session mode needs it)" : ""}`,
			`pi-intercom: ${deps.intercom.installed ? "installed" : "MISSING"}${deps.intercom.signaled ? " (bridge ready)" : ""}`,
			`active program: ${this.active ? `${this.active.slug} (${this.active.ledger.status})` : "none"}`,
		];
		if (!deps.ok) lines.push(`install: ${deps.hints.join(" && ")}`);
		if (this.active) {
			const ledger = this.active.ledger;
			const busy = Object.values(ledger.cards).filter((card) => card.activeRun);
			lines.push(`in-flight runs: ${busy.length}`);
			for (const card of busy) lines.push(`  ${card.id}: ${await this.heartbeatLine(card)}`);
			if (ledger.mergeQueue.length > 0) {
				lines.push(
					`merge queue: ${ledger.mergeQueue.join(" → ")}${ledger.mergeQueuePaused ? " (paused — worktree dirty)" : ""}`,
				);
			}
			const todos = await this.operatorTodoSummary();
			if (todos && todos.open.length > 0) {
				lines.push(`operator todos (${ledger.slug}): ${todos.open.length} open, ${todos.blocking.length} blocking`);
				for (const item of todos.blocking.slice(0, 3)) {
					lines.push(`  ! ${item.id} blocks card ${item.card ?? "—"}: ${oneLine(item.title, 90)}`);
				}
			}
			try {
				const [unmerged, merging] = await Promise.all([
					this.git.unmergedPaths(this.cwd),
					this.git.merging(this.cwd),
				]);
				if (merging || unmerged.length > 0) {
					lines.push(
						`merge state: MERGE_HEAD present=${merging} unmerged=${unmerged.length}${unmerged.length > 0 ? ` (${unmerged.slice(0, 10).join(", ")})` : ""}`,
					);
				}
			} catch {
				lines.push("merge state: unavailable (git error)");
			}
			const blockedCards = Object.values(ledger.cards).filter((card) => card.phase === "blocked");
			if (blockedCards.length > 0) {
				lines.push(`blocked cards: ${blockedCards.length}`);
				for (const card of blockedCards) {
					lines.push(`  ${card.id}: ${card.lastError ?? "blocked"}${unblockHint(card)}`);
				}
			}
		}
		return lines.join("\n");
	}

	/* ---- mutations routed from tools ---- */

	async triage(cardId: string, verdicts: FindingVerdict[]): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const result = applyTriage(this, cardId, verdicts);
		if (!result.ok) return { ok: false, text: result.error ?? "triage failed" };
		const approved = verdicts.filter((verdict) => verdict.verdict === "approve").length;
		await appendProgress(this.active.absDir, `${cardId} triage: ${approved} fix / ${verdicts.length - approved} skip`);
		await this.save();
		this.scheduleDrive();
		return { ok: true, text: `Recorded ${verdicts.length} verdict(s) for card ${cardId}.` };
	}

	async unblock(cardId: string, resolution: "redispatch" | "done" | "abandon"): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const result = await applyUnblock(this, cardId, resolution);
		if (!result.ok) return { ok: false, text: result.error ?? "unblock failed" };
		await appendProgress(this.active.absDir, `${cardId} unblocked: ${resolution}`);
		await this.save();
		if (resolution === "redispatch") this.scheduleDrive();
		return { ok: true, text: `Card ${cardId}: ${resolution}.` };
	}

	async cycleDecision(cardId: string, choice: "accept" | "block"): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const result = applyCycleDecision(this, cardId, choice);
		if (!result.ok) return { ok: false, text: result.error ?? "cycle decision failed" };
		const card = this.active.ledger.cards[cardId];
		if (choice === "accept" && card?.acceptedFindings !== undefined && card.acceptedFindings.length > 0) {
			// Keep the accepted debt in the card record, not just the ledger.
			const text = (await readTextOrUndefined(this.cardFilePath(card))) ?? "";
			if (text.trim().length > 0) {
				await writeTextAtomic(this.cardFilePath(card), appendAcceptedFindings(text, card.acceptedFindings));
			}
			await appendProgress(
				this.active.absDir,
				`${cardId} cycle accept — ${card.acceptedFindings.length} finding(s) carried`,
			);
		} else {
			await appendProgress(this.active.absDir, `${cardId} cycle ${choice}`);
		}
		await this.save();
		this.scheduleDrive();
		return { ok: true, text: `Card ${cardId}: ${choice}.` };
	}

	async programGateDecision(choice: "retry" | "block"): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const result = applyProgramGateDecision(this, choice);
		if (!result.ok) return { ok: false, text: result.error ?? "program gate decision failed" };
		await appendProgress(this.active.absDir, `program gate: ${choice}`);
		await this.save();
		this.scheduleDrive();
		return { ok: true, text: `Program gate: ${choice}.` };
	}

	async dispatch(cardId: string, role: "worker" | "reviewer" | "reconciler"): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const result = await dispatchManual(this, cardId, role);
		if (!result.ok) return { ok: false, text: result.error ?? "dispatch failed" };
		await this.save();
		this.scheduleDrive();
		return { ok: true, text: `Card ${cardId}: ${role} dispatch requested.` };
	}

	async mergeResolved(cardId: string): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const card = this.active.ledger.cards[cardId];
		if (!card) return { ok: false, text: `Unknown card ${cardId}.` };
		const inMerge = card.phase === "merging" || card.phase === "reconciling" || card.merge?.state === "conflict";
		if (!inMerge) {
			return { ok: false, text: `Card ${cardId} is ${card.phase}; merge_resolved only applies to a card in a merge.` };
		}
		if (this.active.ledger.status !== "active") {
			return {
				ok: false,
				text: `Program is ${this.active.ledger.status}; finalizing a merge can start a gate fix — resume first.`,
			};
		}
		if (this.active.ledger.parallelExecution === "worktrees" && card.lane) {
			const landed = await this.git.isAncestor(this.cwd, card.lane.branch, "HEAD");
			if (!landed) {
				return {
					ok: false,
					text: `Card ${cardId}'s lane (${card.lane.branch}) is not an ancestor of HEAD; merge it before marking the card resolved.`,
				};
			}
		}
		const unmerged = await this.git.unmergedPaths(this.cwd);
		if (unmerged.length > 0) {
			return { ok: false, text: `Card ${cardId} still has unresolved paths: ${unmerged.join(", ")}` };
		}
		const decision = openDecisionFor(this.active.ledger, cardId);
		if (decision) {
			decision.status = "resolved";
			decision.resolvedAt = Date.now();
		}
		card.phase = "merging";
		card.merge = { state: "merging", attempts: card.merge?.attempts ?? 1, ...(card.merge?.commit ? { commit: card.merge.commit } : {}) };
		await finishManualMerge(this, card);
		await this.save();
		this.scheduleDrive();
		return { ok: true, text: `Card ${cardId} merge finalized.` };
	}

	async closeProgram(remove: boolean): Promise<ActionResult> {
		if (!this.active) return { ok: false, text: "No active work program." };
		const ledger = this.active.ledger;
		const pending = ledger.order.filter((id) => {
			const card = ledger.cards[id];
			return card !== undefined && card.phase !== "done" && !isAbandonedCard(card);
		});
		if (pending.length > 0) {
			return {
				ok: false,
				text: `Cannot close: cards not done: ${pending.join(", ")}. Closing is only for completed programs — finish the cards (or abandon their scope) first. Program records are untouched.`,
			};
		}
		ledger.status = "complete";
		await this.save();
		await appendProgress(this.active.absDir, "program closed by operator");
		if (remove) {
			const absDir = this.active.absDir;
			const slug = this.active.slug;
			for (const id of this.active.ledger.order) {
				const lane = this.active.ledger.cards[id]?.lane;
				if (!lane) continue;
				try {
					await this.git.worktreeRemove(this.cwd, lane.path);
					await this.git.branchDelete(this.cwd, lane.branch);
				} catch {
					this.sessionCtx?.ui.notify(`Work program: could not clean lane ${lane.branch}`, "warning");
				}
			}
			this.active = undefined;
			await import("node:fs/promises").then((fs) => fs.rm(absDir, { recursive: true, force: true }));
			this.refreshUi();
			return { ok: true, text: `Removed work program ${slug} and its lanes (git history is the archive).` };
		}
		this.refreshUi();
		return { ok: true, text: `Closed ${ledger.slug}. Folder kept.` };
	}

	protocol(): string {
		return loadResources().protocol;
	}

	/**
	 * True when pi is not processing a run, retry, compaction, or queued
	 * continuation. Older pi builds without the helper are treated as idle, which
	 * preserves the previous wake-every-time behavior.
	 */
	sessionIdle(): boolean {
		const ctx = this.sessionCtx;
		if (!ctx) return true;
		const idle = (ctx as { isIdle?: () => boolean }).isIdle;
		if (typeof idle !== "function") return true;
		try {
			return idle.call(ctx) !== false;
		} catch {
			return true;
		}
	}

	/**
	 * Tell the session agent to take over (used after start/resume commands so
		 * the operator doesn't have to nudge the session manually). Same
		 * follow-up channel as decision packets: visible message + a real turn.
	 */
	nudgeAgent(message: string): void {
		this.pi.sendMessage(
			{ customType: DECISION_CUSTOM_TYPE, content: message, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	contextBrief(): string {
		if (!this.active) return "";
		const status = this.active.ledger.status;
		if (status !== "active" && status !== "paused") return "";
		return buildBrief(this.active.ledger, this.cwd);
	}

	/** Open operator todos for the active program's stream, if the file exists. Never throws. */
	private async operatorTodoSummary(): Promise<TodoSummary | undefined> {
		if (!this.active) return undefined;
		try {
			return summarizeTodosSync(this.cwd, this.active.slug) ?? undefined;
		} catch {
		return undefined;
	}
	}

	/** Read-only liveness line for an in-flight run (file reads only — never disturbs the run). */
	private async heartbeatLine(card: CardLedger): Promise<string> {
		const run = card.activeRun;
		if (!run) return "no active run";
		const shortId = run.runId.length > 12 ? `${run.runId.slice(0, 8)}…` : run.runId;
		try {
			const hb = await this.runs.heartbeat(run.runId, run.asyncDir);
			const elapsed =
				hb.elapsedMs !== undefined ? formatDuration(hb.elapsedMs) : formatDuration(Date.now() - run.startedAt);
			const activity = hb.lastUpdate !== undefined ? `active ${formatAgo(hb.lastUpdate)}` : "no activity yet";
			const tail = hb.tail ? ` · "${oneLine(hb.tail, 80)}"` : "";
			return `${run.kind} ${shortId} · ${elapsed} · ${activity}${tail}`;
		} catch {
			return `${run.kind} ${shortId} · ${formatDuration(Date.now() - run.startedAt)}`;
		}
	}

	/** Sync variant for the TUI widget path (same read-only snapshot reads). */
	private snapshotLine(card: CardLedger): string {
		const run = card.activeRun;
		if (!run) return "";
		try {
			const snapshot = this.runs.heartbeatSnapshot?.(run.runId, run.asyncDir);
			const elapsed =
				snapshot?.elapsedMs !== undefined
					? formatDuration(snapshot.elapsedMs)
					: formatDuration(Date.now() - run.startedAt);
			const activity = snapshot?.lastUpdate !== undefined ? ` · ${formatAgo(snapshot.lastUpdate)}` : "";
			const tail = snapshot?.tail ? ` · "${oneLine(snapshot.tail, 60)}"` : "";
			return `${run.kind} · ${elapsed}${activity}${tail}`;
		} catch {
			return `${run.kind} · ${formatDuration(Date.now() - run.startedAt)}`;
		}
	}

	/** Internal: run one driver tick synchronously (used by tests). */
	async driveOnce(): Promise<void> {
		if (!this.active) return;
		await drive(this);
	}
}

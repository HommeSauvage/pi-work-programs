import { join } from "node:path";
import { PLAN_FILE, PROGRESS_FILE, RUNTIME_DIR, RUNTIME_GITIGNORE, TASKS_DIR } from "../constants.ts";
import { ensureDir, listDirectory, pathExists, readText, writeTextAtomic } from "../shared/fsx.ts";
import type { CardLedger, ParsedCard, ProgramLedger, WorkProgramSettings } from "../shared/types.ts";
import { compareCardIds, cardFromParsed, saveLedger } from "./ledger.ts";
import { resolveProgramDir } from "../shared/paths.ts";
import { loadResources } from "../protocol/resources.ts";

export interface ProgramRef {
	slug: string;
	absDir: string;
	relDir: string;
}

export async function listProgramRefs(cwd: string, settings: WorkProgramSettings): Promise<ProgramRef[]> {
	const root = resolveProgramDir(cwd, settings.dir);
	const entries = await listDirectory(root);
	const refs: ProgramRef[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const absDir = join(root, entry);
		if (!(await pathExists(join(absDir, PLAN_FILE)))) continue;
		refs.push({ slug: entry, absDir, relDir: join(settings.dir, entry) });
	}
	return refs;
}

export async function readPlan(absDir: string): Promise<string> {
	return readText(join(absDir, PLAN_FILE));
}

export async function listCardFiles(absDir: string): Promise<Array<{ path: string; text: string }>> {
	const tasksDir = join(absDir, TASKS_DIR);
	const files = await listDirectory(tasksDir);
	const result: Array<{ path: string; text: string }> = [];
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		result.push({ path: `${TASKS_DIR}/${file}`, text: await readText(join(tasksDir, file)) });
	}
	return result;
}

export function renderPlanScaffold(input: {
	slug: string;
	title: string;
	brief: string;
	configComment: string;
	date: string;
}): string {
	const template = loadResources().planTemplate;
	const frontmatter = input.configComment.trim().startsWith("---")
		? input.configComment.trim().replace(/^---+\n/, "").replace(/\n---+\s*$/, "")
		: input.configComment;
	return template
		.replace("{{WP_FRONTMATTER}}", frontmatter)
		.replace("{{WP_CONFIG}}", frontmatter)
		.replaceAll("{{TITLE}}", input.title)
		.replaceAll("{{BRIEF}}", input.brief.trim().length > 0 ? input.brief.trim() : "TODO")
		.replaceAll("{{DATE}}", input.date)
		.replaceAll("{{WHY}}", "TODO")
		.replaceAll("{{DECISION}}", "TODO")
		.replaceAll("{{SLUG}}", input.slug)
		.replaceAll("{{CARD_TITLE}}", "<first card title>")
		.replaceAll("{{DONE_WHEN}}", "TODO");
}

export function renderProgressScaffold(input: {
	slug: string;
	date: string;
	mode: string;
	maxParallel: number;
	parallelExecution: string;
}): string {
	return [
		`# progress — ${input.slug}`,
		"",
		"Harness log. One terse line per event — facts only (card, event, sha).",
		"No prose; detail lives in the card Evidence sections. Bounded: the",
		"oldest lines roll off, git history keeps everything.",
		"",
		`## ${input.date}`,
		`- program created (${input.mode}, parallel ${input.maxParallel}, ${input.parallelExecution})`,
		"",
	].join("\n");
}

export async function scaffoldProgram(input: {
	cwd: string;
	settings: WorkProgramSettings;
	slug: string;
	title: string;
	brief: string;
	configComment: string;
}): Promise<ProgramRef> {
	const absDir = resolveProgramDir(input.cwd, join(input.settings.dir, input.slug));
	if (await pathExists(join(absDir, PLAN_FILE))) {
		throw new Error(`A work program already exists at ${absDir}`);
	}
	await ensureDir(join(absDir, TASKS_DIR));
	await ensureDir(join(absDir, RUNTIME_DIR));
	const date = new Date().toISOString().slice(0, 10);
	await writeTextAtomic(
		join(absDir, PLAN_FILE),
		renderPlanScaffold({
			slug: input.slug,
			title: input.title,
			brief: input.brief,
			configComment: input.configComment,
			date,
		}),
	);
	await writeTextAtomic(
		join(absDir, PROGRESS_FILE),
		renderProgressScaffold({
			slug: input.slug,
			date,
			mode: input.settings.mode,
			maxParallel: input.settings.maxParallel,
			parallelExecution: input.settings.parallelExecution,
		}),
	);
	await writeTextAtomic(join(absDir, RUNTIME_DIR, ".gitignore"), RUNTIME_GITIGNORE);
	return {
		slug: input.slug,
		absDir,
		relDir: join(input.settings.dir, input.slug),
	};
}

/** Rolling cap on recorded events; the oldest lines roll off. */
export const PROGRESS_MAX_LINES = 500;
/** Hard per-line cap: progress is a signal log, never a wall of text. */
export const PROGRESS_MAX_LINE_CHARS = 200;
const TRIMMED_MARKER = /^- … \d+ earlier events trimmed/;

/**
 * Enforce the documented bound (~500 events): keep the newest event lines,
 * fold the dropped count into a single cumulative marker, and drop sections
 * left empty. progress.md is committed at every card completion, so git
 * history is the archive; the live file stays a scannable signal log.
 */
export function boundProgress(text: string): string {
	const lines = text.split("\n");
	let firstSection = lines.findIndex((line) => line.startsWith("## "));
	if (firstSection === -1) firstSection = lines.length;
	const header = lines.slice(0, firstSection);
	while (header.length > 0 && (header[header.length - 1] ?? "").trim().length === 0) header.pop();
	type Section = { date: string; events: string[]; extra: string[] };
	const sections: Section[] = [];
	let current: Section | undefined;
	for (const line of lines.slice(firstSection)) {
		if (line.startsWith("## ")) {
			current = { date: line, events: [], extra: [] };
			sections.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("- ")) current.events.push(line);
		else if (line.trim().length > 0) current.extra.push(line);
	}
	const live = sections.flatMap((section) => section.events).filter((line) => !TRIMMED_MARKER.test(line));
	const excess = live.length - PROGRESS_MAX_LINES;
	if (excess > 0) {
		let toDrop = excess;
		// Markers from earlier trims (dropped or surviving) fold into the new one,
		// so the count stays cumulative across successive trims.
		let carried = 0;
		for (const section of sections) {
			if (toDrop <= 0) break;
			while (toDrop > 0 && section.events.length > 0) {
				const line = section.events.shift();
				if (line === undefined) break;
				const match = /^- … (\d+) earlier events trimmed/.exec(line);
				if (match) {
					carried += Number(match[1] ?? 0);
					continue;
				}
				toDrop -= 1;
			}
		}
		for (const section of sections) {
			for (const line of section.events) {
				const match = /^- … (\d+) earlier events trimmed/.exec(line);
				if (match) carried += Number(match[1] ?? 0);
			}
			section.events = section.events.filter((line) => !TRIMMED_MARKER.test(line));
		}
		const marker = `- … ${excess + carried} earlier events trimmed (git history)`;
		const first = sections.find((section) => section.events.length > 0);
		if (first) first.events.unshift(marker);
	}
	const out = [...header];
	for (const section of sections) {
		if (section.events.length === 0 && section.extra.length === 0) continue;
		out.push("", section.date, ...section.events, ...section.extra);
	}
	return `${out.join("\n").trimEnd()}\n`;
}

/**
 * The single writer of progress.md. One event = one terse line: whitespace
 * collapsed, hard-capped, filed under today's UTC date, bounded to the newest
 * PROGRESS_MAX_LINES events. Empty lines are dropped, never recorded.
 */
export async function appendProgress(absDir: string, line: string): Promise<void> {
	const clean = line.replace(/\s+/g, " ").trim();
	if (clean.length === 0) return;
	const clipped = clean.length > PROGRESS_MAX_LINE_CHARS ? `${clean.slice(0, PROGRESS_MAX_LINE_CHARS - 1)}…` : clean;
	const path = join(absDir, PROGRESS_FILE);
	const existing = (await pathExists(path)) ? await readText(path) : "";
	let text = existing.trimEnd();
	if (text.length === 0) text = "# progress";
	const today = new Date().toISOString().slice(0, 10);
	const sections = text.split("\n").filter((entry) => entry.startsWith("## "));
	if (sections[sections.length - 1] !== `## ${today}`) text += `\n\n## ${today}`;
	await writeTextAtomic(path, boundProgress(`${text}\n- ${clipped}`));
}

/** Merge on-disk card records into the ledger without clobbering runtime state. */
export interface RemovedCardDecision {
	drop: boolean;
	reason?: string;
	note?: string;
}

export interface SyncCardsOptions {
	/**
	 * Policy for a card file that disappeared from the plan. Omitted = legacy
	 * behavior (mark blocked, keep the ledger row).
	 */
	onRemoved?: (card: CardLedger) => Promise<RemovedCardDecision>;
}

/**
 * Reconcile the ledger with the plan + card files on disk. Adoption and
 * field updates always apply; removals follow `options.onRemoved` so a
 * collapse (fold scope into survivors, rewire deps, delete files, sync) can
 * drop cards without hand-editing the ledger.
 */
export async function syncCards(
	ledger: ProgramLedger,
	parsedCards: ParsedCard[],
	planText: string,
	options: SyncCardsOptions = {},
): Promise<string[]> {
	const notes: string[] = [];
	const seen = new Set(parsedCards.map((card) => card.id));
	for (const parsed of parsedCards) {
		const existing = ledger.cards[parsed.id];
		if (!existing) {
			ledger.cards[parsed.id] = cardFromParsed(parsed, planText);
			notes.push(`card ${parsed.id} added`);
			continue;
		}
		existing.title = parsed.title;
		existing.path = parsed.path;
		existing.dependsOn = parsed.dependsOn.sort(compareCardIds);
		existing.kind = parsed.kind;
		// Front matter is the source of truth: a defined value sets the override,
		// an absent value clears it so the card inherits the program default.
		if (parsed.reviewProfile) existing.reviewProfile = parsed.reviewProfile;
		else delete existing.reviewProfile;
		if (parsed.maxCycles !== undefined) existing.maxCycles = parsed.maxCycles;
		else delete existing.maxCycles;
		for (const key of ["workerAgent", "workerModel", "workerThinking", "reviewerAgent", "reviewerModel", "reviewerThinking"] as const) {
			const value = parsed[key];
			if (value) existing[key] = value;
			else delete existing[key];
		}
	}
	for (const [id, card] of Object.entries(ledger.cards)) {
		if (seen.has(id)) continue;
		const decision = options.onRemoved
			? await options.onRemoved(card)
			: { drop: false, reason: "card file is missing from the plan" };
		if (decision.drop) {
			delete ledger.cards[id];
			const index = ledger.mergeQueue.indexOf(id);
			if (index >= 0) ledger.mergeQueue.splice(index, 1);
			notes.push(`card ${id} dropped (file removed)${decision.note ? ` — ${decision.note}` : ""}`);
			continue;
		}
		if (card.phase !== "done" && !["implementing", "reviewing", "fixing", "merging", "reconciling", "verifying"].includes(card.phase)) {
			card.phase = "blocked";
		}
		card.lastError = `card file is missing from the plan${decision.reason ? ` — ${decision.reason}` : ""}`;
		notes.push(`card ${id} kept (file removed — ${decision.reason ?? "needs a decision"})`);
	}
	ledger.order = Object.keys(ledger.cards).sort(compareCardIds);
	return notes;
}

export async function adoptProgram(input: {
	cwd: string;
	settings: WorkProgramSettings;
	ref: ProgramRef;
}): Promise<ProgramLedger> {
	const { buildLedger, configOverridesFromPlan } = await import("./ledger.ts");
	const { validatePlanFiles } = await import("./validate.ts");
	const planText = await readPlan(input.ref.absDir);
	const cardFiles = await listCardFiles(input.ref.absDir);
	const validation = validatePlanFiles(planText, cardFiles);
	if (validation.cards.length === 0) {
		throw new Error(`No valid cards found under ${input.ref.absDir}: ${validation.problems.join("; ")}`);
	}
	const overrides = configOverridesFromPlan(planText);
	const ledger = buildLedger({
		slug: input.ref.slug,
		title: validation.plan.title.replace(/^Work program\s*[—:-]\s*/i, ""),
		dir: input.ref.relDir,
		settings: input.settings,
		overrides,
		baseBranch: "HEAD",
		baseCommit: "",
		cards: validation.cards,
		planText,
	});
	await saveLedger(input.ref.absDir, ledger);
	return ledger;
}


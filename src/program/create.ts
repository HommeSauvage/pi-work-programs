import { join } from "node:path";
import { PLAN_FILE, PROGRESS_FILE, RUNTIME_DIR, RUNTIME_GITIGNORE, TASKS_DIR } from "../constants.ts";
import { ensureDir, listDirectory, pathExists, readText, writeTextAtomic } from "../shared/fsx.ts";
import type { CardLedger, ParsedCard, ProgramLedger, WorkProgramSettings } from "../shared/types.ts";
import { compareCardIds, cardFromParsed, saveLedger } from "./ledger.ts";
import { resolveProgramDir } from "../shared/paths.ts";
import { loadResources } from "../protocol/resources.ts";
import { formatPlanConfig } from "../config.ts";

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
	return template
		.replace("{{WP_CONFIG}}", input.configComment)
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
		"Lab log: card outcomes, review verdicts, merge events, structural edits,",
		"decisions. One line per event; detail lives in the card Evidence section.",
		"",
		`## ${input.date}`,
		`- Program created (mode: ${input.mode}, maxParallel: ${input.maxParallel}, ${input.parallelExecution}).`,
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

export async function appendProgress(absDir: string, line: string): Promise<void> {
	const path = join(absDir, PROGRESS_FILE);
	const existing = (await pathExists(path)) ? await readText(path) : `# progress\n\n`;
	if (!existing.endsWith("\n")) {
		await writeTextAtomic(path, `${existing}\n- ${line}\n`);
		return;
	}
	await writeTextAtomic(path, `${existing}- ${line}\n`);
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
		if (parsed.reviewProfile) existing.reviewProfile = parsed.reviewProfile;
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


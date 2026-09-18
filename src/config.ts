import type {
	Mode,
	ParallelExecution,
	ProgramConfigOverrides,
	ReviewProfile,
	WorkProgramSettings,
} from "./shared/types.ts";
import { projectSettingsPath, userSettingsPath } from "./shared/paths.ts";
import { readJson } from "./shared/fsx.ts";
import { asNumber, asString, isRecord, parseStringArray } from "./shared/text.ts";
import { mergeFrontmatterData, parseFrontmatter, setFrontmatter } from "./shared/frontmatter.ts";
import type { CardConfigPatch } from "./shared/types.ts";

export const DEFAULT_SETTINGS: WorkProgramSettings = {
	dir: ".agents/work-programs",
	mode: "managed",
	maxParallel: 2,
	parallelExecution: "worktrees",
	review: { agent: "reviewer", profile: "light", maxCycles: 3, onExhausted: "ask", resumeReviewer: true },
	worker: { agent: "worker" },
	reviewer: {},
	atlas: { enabled: true, agent: "scout" },
	gates: { card: [], program: [] },
	laneBranchPattern: "{branch}-card-{id}",
};

const MODES: Mode[] = ["session", "managed", "captain"];
const PARALLEL_EXECUTIONS: ParallelExecution[] = ["worktrees", "direct"];
const REVIEW_PROFILES: ReviewProfile[] = ["light", "enhanced"];

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as string[]).includes(value);
}

export function isParallelExecution(value: unknown): value is ParallelExecution {
	return typeof value === "string" && (PARALLEL_EXECUTIONS as string[]).includes(value);
}

export function isReviewProfile(value: unknown): value is ReviewProfile {
	return typeof value === "string" && (REVIEW_PROFILES as string[]).includes(value);
}

function clampParallel(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const rounded = Math.floor(value);
	if (rounded < 1) return 1;
	if (rounded > 32) return 32;
	return rounded;
}

export function normalizeSettings(raw: unknown, base: WorkProgramSettings = DEFAULT_SETTINGS): WorkProgramSettings {
	if (!isRecord(raw)) return { ...base };
	const settings: WorkProgramSettings = {
		...base,
		review: { ...base.review },
		worker: { ...base.worker },
		reviewer: { ...base.reviewer },
		atlas: {
			enabled: base.atlas?.enabled ?? true,
			agent: base.atlas?.agent ?? "scout",
			...(base.atlas?.model ? { model: base.atlas.model } : {}),
			...(base.atlas?.thinking ? { thinking: base.atlas.thinking } : {}),
		},
		gates: { card: [...base.gates.card], program: [...base.gates.program] },
	};
	const dir = asString(raw.dir);
	if (dir) settings.dir = dir;
	if (isMode(raw.mode)) settings.mode = raw.mode;
	settings.maxParallel = clampParallel(asNumber(raw.maxParallel), base.maxParallel);
	if (isParallelExecution(raw.parallelExecution)) settings.parallelExecution = raw.parallelExecution;
	const pattern = asString(raw.laneBranchPattern);
	if (pattern) settings.laneBranchPattern = pattern;
	const worktreeDir = asString(raw.worktreeDir);
	if (worktreeDir) settings.worktreeDir = worktreeDir;

	const review = isRecord(raw.review) ? raw.review : undefined;
	if (review) {
		const agent = asString(review.agent);
		if (agent) settings.review.agent = agent;
		if (isReviewProfile(review.profile)) settings.review.profile = review.profile;
		settings.review.maxCycles = clampParallel(asNumber(review.maxCycles), base.review.maxCycles);
		const onExhausted = asString(review.onExhausted);
		if (onExhausted === "ask" || onExhausted === "accept" || onExhausted === "block") {
			settings.review.onExhausted = onExhausted;
		}
		if (typeof review.resumeReviewer === "boolean") settings.review.resumeReviewer = review.resumeReviewer;
	}

	const worker = isRecord(raw.worker) ? raw.worker : undefined;
	if (worker) {
		const agent = asString(worker.agent);
		if (agent) settings.worker.agent = agent;
		const model = asString(worker.model);
		if (model) settings.worker.model = model;
		const thinking = asString(worker.thinking);
		if (thinking) settings.worker.thinking = thinking;
	}

	const reviewer = isRecord(raw.reviewer) ? raw.reviewer : undefined;
	if (reviewer) {
		const model = asString(reviewer.model);
		if (model) settings.reviewer.model = model;
		const thinking = asString(reviewer.thinking);
		if (thinking) settings.reviewer.thinking = thinking;
	}

	const gates = isRecord(raw.gates) ? raw.gates : undefined;
	if (gates) {
		const card = parseStringArray(gates.card);
		if (card) settings.gates.card = card;
		const program = parseStringArray(gates.program);
		if (program) settings.gates.program = program;
	}

	const atlas = isRecord(raw.atlas) ? raw.atlas : undefined;
	if (atlas) {
		if (typeof atlas.enabled === "boolean") settings.atlas!.enabled = atlas.enabled;
		const agent = asString(atlas.agent);
		if (agent) settings.atlas!.agent = agent;
		const model = asString(atlas.model);
		if (model) settings.atlas!.model = model;
		const thinking = asString(atlas.thinking);
		if (thinking) settings.atlas!.thinking = thinking;
	}

	return settings;
}

export async function loadSettings(cwd: string, configDirName: string): Promise<WorkProgramSettings> {
	const userRaw = await readJson<Record<string, unknown>>(userSettingsPath());
	const projectRaw = await readJson<Record<string, unknown>>(projectSettingsPath(cwd, configDirName));
	const user = normalizeSettings(userRaw?.workPrograms, DEFAULT_SETTINGS);
	return normalizeSettings(projectRaw?.workPrograms, user);
}

const CONFIG_COMMENT_RE = /<!--\s*wp:\s*(\{[\s\S]*?\})\s*-->/;

export function parsePlanCommentConfig(planText: string): Record<string, unknown> {
	const match = CONFIG_COMMENT_RE.exec(planText.slice(0, 8_192));
	if (!match?.[1]) return {};
	try {
		const parsed = JSON.parse(match[1]) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Program config: YAML front matter first, legacy `<!-- wp: -->` comment as fallback. */
export function parsePlanConfig(planText: string): Record<string, unknown> {
	const { data } = parseFrontmatter(planText);
	const legacy = parsePlanCommentConfig(planText);
	if (Object.keys(data).length === 0) return legacy;
	if (Object.keys(legacy).length === 0) return data;
	return mergeFrontmatterData(legacy, data);
}

export function formatPlanConfig(overrides: ProgramConfigOverrides): string {
	const clean: Record<string, unknown> = {};
	if (overrides.mode) clean.mode = overrides.mode;
	if (overrides.maxParallel !== undefined) clean.maxParallel = overrides.maxParallel;
	if (overrides.parallelExecution) clean.parallelExecution = overrides.parallelExecution;
	if (overrides.reviewProfile) clean.reviewProfile = overrides.reviewProfile;
	if (overrides.maxCycles !== undefined) clean.maxCycles = overrides.maxCycles;
	if (overrides.laneBranchPattern) clean.laneBranchPattern = overrides.laneBranchPattern;
	const review: Record<string, unknown> = {};
	if (overrides.reviewProfile) review.profile = overrides.reviewProfile;
	if (overrides.maxCycles !== undefined) review.maxCycles = overrides.maxCycles;
	if (Object.keys(review).length > 0) clean.review = review;
	const gates: Record<string, unknown> = {};
	if (overrides.gates?.card) gates.card = overrides.gates.card;
	if (overrides.gates?.program) gates.program = overrides.gates.program;
	if (Object.keys(gates).length > 0) clean.gates = gates;
	const worker: Record<string, unknown> = {};
	if (overrides.workerAgent) worker.agent = overrides.workerAgent;
	if (overrides.workerModel) worker.model = overrides.workerModel;
	if (overrides.workerThinking) worker.thinking = overrides.workerThinking;
	if (Object.keys(worker).length > 0) clean.worker = worker;
	const reviewer: Record<string, unknown> = {};
	if (overrides.reviewerAgent) reviewer.agent = overrides.reviewerAgent;
	if (overrides.reviewerModel) reviewer.model = overrides.reviewerModel;
	if (overrides.reviewerThinking) reviewer.thinking = overrides.reviewerThinking;
	if (Object.keys(reviewer).length > 0) clean.reviewer = reviewer;
	return `<!-- wp: ${JSON.stringify(clean)} -->`;
}

export function applyOverrides(
	settings: WorkProgramSettings,
	overrides: ProgramConfigOverrides,
): WorkProgramSettings {
	const normalized = normalizeSettings({
		dir: settings.dir,
		mode: overrides.mode ?? settings.mode,
		maxParallel: overrides.maxParallel ?? settings.maxParallel,
		parallelExecution: overrides.parallelExecution ?? settings.parallelExecution,
		laneBranchPattern: overrides.laneBranchPattern ?? settings.laneBranchPattern,
		review: {
			agent: overrides.reviewerAgent ?? settings.review.agent,
			profile: overrides.reviewProfile ?? settings.review.profile,
			maxCycles: overrides.maxCycles ?? settings.review.maxCycles,
			onExhausted: settings.review.onExhausted,
			resumeReviewer: overrides.reviewerResume ?? settings.review.resumeReviewer,
		},
		worker: {
			agent: overrides.workerAgent ?? settings.worker.agent,
			model: overrides.workerModel ?? settings.worker.model,
			thinking: overrides.workerThinking ?? settings.worker.thinking,
		},
		reviewer: {
			model: overrides.reviewerModel ?? settings.reviewer.model,
			thinking: overrides.reviewerThinking ?? settings.reviewer.thinking,
		},
		gates: {
			card: overrides.gates?.card ?? settings.gates.card,
			program: overrides.gates?.program ?? settings.gates.program,
		},
		atlas: {
			enabled: overrides.atlasEnabled ?? settings.atlas?.enabled ?? true,
			agent: overrides.atlasAgent ?? settings.atlas?.agent ?? "scout",
			model: overrides.atlasModel ?? settings.atlas?.model,
			thinking: overrides.atlasThinking ?? settings.atlas?.thinking,
		},
	}, settings);
	return normalized;
}


/** True when a package source for `name` appears in the user or project settings `packages` list. */
export async function isPackageConfigured(cwd: string, configDirName: string, name: string): Promise<boolean> {
	const candidates = [userSettingsPath(), projectSettingsPath(cwd, configDirName)];
	for (const path of candidates) {
		const raw = await readJson<Record<string, unknown>>(path);
		const packages = raw?.packages;
		if (!Array.isArray(packages)) continue;
		for (const entry of packages) {
			if (typeof entry !== "string") continue;
			if (matchesPackage(entry, name)) return true;
		}
	}
	return false;
}

function matchesPackage(entry: string, name: string): boolean {
	const trimmed = entry.trim();
	if (trimmed === name) return true;
	const npmMatch = /^npm:(.+?)(?:@[^@/]*)?$/.exec(trimmed);
	if (npmMatch?.[1] === name) return true;
	if (trimmed.startsWith("git:") || trimmed.startsWith("http")) {
		const tail = trimmed.split("/").pop() ?? "";
		return tail.replace(/\.git$/, "").replace(/@.*$/, "") === name;
	}
	return trimmed.replace(/\/+$/, "").split("/").pop() === name;
}

/** Canonical front-matter shape for the program config in plan.md. */
export function overridesToPlanFrontmatter(overrides: ProgramConfigOverrides): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (overrides.mode) data.mode = overrides.mode;
	if (overrides.maxParallel !== undefined) data.maxParallel = overrides.maxParallel;
	if (overrides.parallelExecution) data.parallelExecution = overrides.parallelExecution;
	if (overrides.laneBranchPattern) data.laneBranchPattern = overrides.laneBranchPattern;
	const review: Record<string, unknown> = {};
	if (overrides.reviewProfile) review.profile = overrides.reviewProfile;
	if (overrides.maxCycles !== undefined) review.maxCycles = overrides.maxCycles;
	if (overrides.reviewerResume !== undefined) review.resumeReviewer = overrides.reviewerResume;
	if (Object.keys(review).length > 0) data.review = review;
	const gates: Record<string, unknown> = {};
	if (overrides.gates?.card) gates.card = overrides.gates.card;
	if (overrides.gates?.program) gates.program = overrides.gates.program;
	if (Object.keys(gates).length > 0) data.gates = gates;
	const worker: Record<string, unknown> = {};
	if (overrides.workerAgent) worker.agent = overrides.workerAgent;
	if (overrides.workerModel) worker.model = overrides.workerModel;
	if (overrides.workerThinking) worker.thinking = overrides.workerThinking;
	if (Object.keys(worker).length > 0) data.worker = worker;
	const reviewer: Record<string, unknown> = {};
	if (overrides.reviewerAgent) reviewer.agent = overrides.reviewerAgent;
	if (overrides.reviewerModel) reviewer.model = overrides.reviewerModel;
	if (overrides.reviewerThinking) reviewer.thinking = overrides.reviewerThinking;
	if (Object.keys(reviewer).length > 0) data.reviewer = reviewer;
	const atlas: Record<string, unknown> = {};
	if (overrides.atlasEnabled !== undefined) atlas.enabled = overrides.atlasEnabled;
	if (overrides.atlasAgent) atlas.agent = overrides.atlasAgent;
	if (overrides.atlasModel) atlas.model = overrides.atlasModel;
	if (overrides.atlasThinking) atlas.thinking = overrides.atlasThinking;
	if (Object.keys(atlas).length > 0) data.atlas = atlas;
	return data;
}

/**
 * Merge a runtime config patch into the plan's front matter so the change
 * survives `sync` and session reload. Unknown keys already in the front
 * matter are preserved; the patch wins where it speaks. Legacy `<!-- wp: -->`
 * comments are removed on write (they stay readable for old programs).
 */
export function mergePlanConfig(planText: string, patch: ProgramConfigOverrides): string {
	const existing = parsePlanConfig(planText);
	const current: ProgramConfigOverrides = {};
	if (isMode(existing.mode)) current.mode = existing.mode;
	if (typeof existing.maxParallel === "number") current.maxParallel = existing.maxParallel;
	if (isParallelExecution(existing.parallelExecution)) current.parallelExecution = existing.parallelExecution;
	if (typeof existing.laneBranchPattern === "string") current.laneBranchPattern = existing.laneBranchPattern;
	const review = isPlainRecord(existing.review) ? existing.review : undefined;
	const worker = isPlainRecord(existing.worker) ? existing.worker : undefined;
	const reviewer = isPlainRecord(existing.reviewer) ? existing.reviewer : undefined;
	const _profile = asString(review?.profile) ?? asString(existing.reviewProfile);
	if (_profile && isReviewProfile(_profile)) current.reviewProfile = _profile;
	const _maxCycles = asNumber(review?.maxCycles) ?? asNumber(existing.maxCycles);
	if (_maxCycles !== undefined) current.maxCycles = _maxCycles;
	if (worker) {
		const agent = asString(worker.agent);
		if (agent) current.workerAgent = agent;
		const model = asString(worker.model);
		if (model) current.workerModel = model;
		const thinking = asString(worker.thinking);
		if (thinking) current.workerThinking = thinking;
	}
	if (reviewer) {
		const model = asString(reviewer.model);
		if (model) current.reviewerModel = model;
		const thinking = asString(reviewer.thinking);
		if (thinking) current.reviewerThinking = thinking;
	}
	if (typeof review?.resumeReviewer === "boolean") current.reviewerResume = review.resumeReviewer;
	const atlas = isPlainRecord(existing.atlas) ? existing.atlas : undefined;
	if (atlas) {
		if (typeof atlas.enabled === "boolean") current.atlasEnabled = atlas.enabled;
		const agent = asString(atlas.agent);
		if (agent) current.atlasAgent = agent;
		const model = asString(atlas.model);
		if (model) current.atlasModel = model;
		const thinking = asString(atlas.thinking);
		if (thinking) current.atlasThinking = thinking;
	}
	const merged: ProgramConfigOverrides = { ...current, ...patch };
	const { data: existingFront } = parseFrontmatter(planText);
	const patchFront = overridesToPlanFrontmatter(patch);
	// Seed missing program keys from the merged view so a first write migrates
	// the legacy comment into front matter without losing values.
	const seedFront = overridesToPlanFrontmatter(merged);
	let next = mergeFrontmatterData(existingFront, seedFront);
	next = mergeFrontmatterData(next, patchFront);
	// Empty-string clears: drop the nested key so the program inherits the global default.
	const clearNested: Array<[keyof ProgramConfigOverrides, string, string]> = [
		["workerAgent", "worker", "agent"],
		["workerModel", "worker", "model"],
		["workerThinking", "worker", "thinking"],
		["reviewerAgent", "reviewer", "agent"],
		["reviewerModel", "reviewer", "model"],
		["reviewerThinking", "reviewer", "thinking"],
		["atlasAgent", "atlas", "agent"],
		["atlasModel", "atlas", "model"],
		["atlasThinking", "atlas", "thinking"],
	];
	for (const [patchKey, mapKey, childKey] of clearNested) {
		if ((patch as Record<string, unknown>)[patchKey] === "") {
			const map = next[mapKey];
			if (typeof map === "object" && map !== null && !Array.isArray(map)) {
				delete (map as Record<string, unknown>)[childKey];
			}
		}
	}
	// Drop empty maps the patch cleared (e.g. workerModel: "" clears the override).
	for (const key of ["worker", "reviewer", "review", "gates", "atlas"]) {
		const entry = next[key];
		if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && Object.keys(entry as Record<string, unknown>).length === 0) {
			delete next[key];
		}
	}
	const withoutComment = planText.replace(CONFIG_COMMENT_RE, "").replace(/^\n+/, "");
	return setFrontmatter(withoutComment, next);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical front-matter keys for a card. Flat model keys keep hand-edits small. */
export function cardPatchToFrontmatter(patch: CardConfigPatch): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (patch.reviewProfile) data.review = patch.reviewProfile;
	if (patch.maxCycles !== undefined) data.maxCycles = patch.maxCycles;
	if (patch.workerAgent) data.workerAgent = patch.workerAgent;
	if (patch.workerModel) data.workerModel = patch.workerModel;
	if (patch.workerThinking) data.workerThinking = patch.workerThinking;
	if (patch.reviewerAgent) data.reviewerAgent = patch.reviewerAgent;
	if (patch.reviewerModel) data.reviewerModel = patch.reviewerModel;
	if (patch.reviewerThinking) data.reviewerThinking = patch.reviewerThinking;
	return data;
}

/** Normalize a card patch: empty strings clear the override (inherit the program default). */
export function normalizeCardPatch(raw: Record<string, unknown>): CardConfigPatch {
	const patch: CardConfigPatch = {};
	const profileRaw = raw.reviewProfile ?? raw.review;
	if (typeof profileRaw === "string") {
		if (isReviewProfile(profileRaw)) patch.reviewProfile = profileRaw;
		else if (profileRaw.trim() === "") (patch as Record<string, unknown>).reviewProfile = undefined;
	}
	if (raw.maxCycles !== undefined) {
		const num = typeof raw.maxCycles === "number" ? raw.maxCycles : Number(raw.maxCycles);
		if (Number.isFinite(num)) patch.maxCycles = Math.max(0, Math.min(32, Math.floor(num)));
	}
	for (const key of ["workerAgent", "workerModel", "workerThinking", "reviewerAgent", "reviewerModel", "reviewerThinking"] as const) {
		const value = raw[key];
		if (typeof value === "string" && value.trim().length > 0) patch[key] = value.trim();
	}
	return patch;
}

/** Merge a card patch into the card file's front matter, preserving the body.
 *  `undefined` (or empty string) in the patch clears that override so the
 *  card inherits the program default.
 */
export function mergeCardFrontmatter(cardText: string, patch: CardConfigPatch & Record<string, undefined | unknown>): string {
	const { data: existing } = parseFrontmatter(cardText);
	const patchFront = cardPatchToFrontmatter(patch);
	const next = mergeFrontmatterData(existing, patchFront);
	// Map CardConfigPatch keys onto their front-matter keys for explicit clears.
	const clearMap: Record<string, string> = {
		reviewProfile: "review",
		maxCycles: "maxCycles",
		workerAgent: "workerAgent",
		workerModel: "workerModel",
		workerThinking: "workerThinking",
		reviewerAgent: "reviewerAgent",
		reviewerModel: "reviewerModel",
		reviewerThinking: "reviewerThinking",
		review: "review",
	};
	for (const [patchKey, frontKey] of Object.entries(clearMap)) {
		if (!(patchKey in patch)) continue;
		const value = (patch as Record<string, unknown>)[patchKey];
		if (value === undefined || (typeof value === "string" && value.trim() === "")) delete next[frontKey];
	}
	return setFrontmatter(cardText, next);
}

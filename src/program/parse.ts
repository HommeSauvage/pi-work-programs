import type { CardConfigPatch, CardKind, ParsedCard, ParsedPlan, ReviewProfile } from "../shared/types.ts";
import { asNumber, asString, isRecord, parseStringArray } from "../shared/text.ts";
import { parseFrontmatter } from "../shared/frontmatter.ts";

const CARD_PATH_RE = /`?(tasks\/[A-Za-z0-9._/-]+\.md)`?/g;
const CARD_ID_RE = /\b(\d{1,3}(?:\.\d+)?)\b/g;

export function parsePlan(planText: string): ParsedPlan {
	const problems: string[] = [];
	const { data: frontmatter, body } = parseFrontmatter(planText);
	const titleMatch = /^#\s+(.+)$/m.exec(body.length > 0 ? body : planText);
	const title = titleMatch?.[1]?.trim() ?? "";
	if (!title) problems.push("plan.md has no top-level `# ` title");
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const match of planText.matchAll(CARD_PATH_RE)) {
		const path = match[1];
		if (!path || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	if (paths.length === 0) problems.push("plan.md lists no cards (expected `tasks/*.md` paths)");
	const cards = paths.map((path) => {
		const basename = path.split("/").pop() ?? path;
		const idMatch = /^(\d{1,3}(?:\.\d+)?)/.exec(basename);
		return { id: idMatch?.[1] ?? basename.replace(/\.md$/, ""), path };
	});
	return { title, config: frontmatter, cards, problems };
}

/** Extract the depends-on declarations from the plan table row for a card path. */
export function parsePlanDependencies(planText: string, cardPath: string): string[] {
	const lines = planText.split("\n");
	for (const line of lines) {
		if (!line.includes(cardPath)) continue;
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line
			.split("|")
			.map((cell) => cell.trim())
			.filter((cell) => cell.length > 0);
		if (cells.length === 0) continue;
		const last = cells[cells.length - 1] ?? "";
		return extractCardIds(last);
	}
	return [];
}

export function extractCardIds(value: string): string[] {
	const ids: string[] = [];
	for (const match of value.matchAll(CARD_ID_RE)) {
		const id = match[1];
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

function section(text: string, heading: string): string | undefined {
	const lines = text.split("\n");
	const headingRe = new RegExp(`^##\\s+${heading}\\b`, "i");
	let start = -1;
	for (let i = 0; i < lines.length; i += 1) {
		if (headingRe.test(lines[i] ?? "")) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return undefined;
	const body: string[] = [];
	for (let i = start; i < lines.length; i += 1) {
		if (/^##\s/.test(lines[i] ?? "")) break;
		body.push(lines[i] ?? "");
	}
	return body.join("\n");
}

export function parseEvidence(text: string): string {
	const body = section(text, "Evidence");
	if (body === undefined) return "";
	const trimmed = body.trim();
	if (trimmed.length === 0) return "";
	if (/^\(?\s*(none yet|none|n\/a|todo)\s*\)?$/i.test(trimmed)) return "";
	return trimmed;
}

export function parseState(text: string): string {
	const heading = /^##\s+State:\s*(.+)$/im.exec(text);
	if (heading?.[1]) return heading[1].trim().toLowerCase();
	const bold = /^\*\*State:?\*\*:?\s*(.+)$/im.exec(text);
	if (bold?.[1]) return bold[1].trim().toLowerCase();
	const plain = /^State:?\s*(.+)$/im.exec(text);
	if (plain?.[1]) return plain[1].trim().toLowerCase();
	return "";
}

function parseFrontmatterLikeLine(text: string, label: string): string | undefined {
	const re = new RegExp(`^\\**${label}\\**:?\\s*(.+)$`, "im");
	return re.exec(text)?.[1]?.trim();
}

function asReviewProfile(value: unknown): ReviewProfile | undefined {
	const text = typeof value === "string" ? value.toLowerCase().trim() : "";
	if (text === "enhanced") return "enhanced";
	if (text === "light") return "light";
	return undefined;
}

function asDependsList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const ids: string[] = [];
		for (const entry of value) {
			if (typeof entry !== "string" && typeof entry !== "number") continue;
			for (const id of extractCardIds(String(entry))) {
				if (!ids.includes(id)) ids.push(id);
			}
		}
		return ids;
	}
	if (typeof value === "number") return [String(value)];
	if (typeof value === "string") {
		if (/^[—–\-]$/.test(value.trim())) return [];
		return extractCardIds(value);
	}
	return undefined;
}

/** Per-card knobs from front matter. Body lines stay as fallback for older cards. */
export function parseCardFrontmatter(data: Record<string, unknown>): CardConfigPatch & { dependsOn?: string[]; kind?: CardKind; gates?: string[] } {
	const out: CardConfigPatch & { dependsOn?: string[]; kind?: CardKind; gates?: string[] } = {};
	const reviewNested = isRecord(data.review) ? (data.review as Record<string, unknown>) : undefined;
	const workerNested = isRecord(data.worker) ? (data.worker as Record<string, unknown>) : undefined;
	const reviewerNested = isRecord(data.reviewer) ? (data.reviewer as Record<string, unknown>) : undefined;
	const profile =
		asReviewProfile(data.review) ??
		asReviewProfile(data.reviewProfile) ??
		asReviewProfile(data.profile) ??
		(reviewNested ? asReviewProfile(reviewNested.profile) : undefined);
	if (profile) out.reviewProfile = profile;
	const maxCycles =
		asNumber(data.maxCycles) ?? (reviewNested ? asNumber(reviewNested.maxCycles) : undefined);
	if (maxCycles !== undefined) out.maxCycles = Math.max(0, Math.min(32, Math.floor(maxCycles)));
	const depends = asDependsList(data.dependsOn ?? data.depends_on ?? data.depends);
	if (depends !== undefined) out.dependsOn = depends;
	const gates = parseStringArray(data.gates);
	if (gates !== undefined) out.gates = gates;
	const kindRaw = asString(data.kind)?.toLowerCase();
	if (kindRaw === "recon" || kindRaw === "read-only" || kindRaw === "readonly" || kindRaw === "read_only") {
		out.kind = "recon";
	} else if (kindRaw === "write") {
		out.kind = "write";
	}
	const workerAgent = asString(data.workerAgent) ?? (workerNested ? asString(workerNested.agent) : undefined);
	if (workerAgent) out.workerAgent = workerAgent;
	const workerModel = asString(data.workerModel) ?? (workerNested ? asString(workerNested.model) : undefined);
	if (workerModel) out.workerModel = workerModel;
	const workerThinking = asString(data.workerThinking) ?? (workerNested ? asString(workerNested.thinking) : undefined);
	if (workerThinking) out.workerThinking = workerThinking;
	const reviewerAgent =
		asString(data.reviewerAgent) ?? (reviewerNested ? asString(reviewerNested.agent) : undefined);
	if (reviewerAgent) out.reviewerAgent = reviewerAgent;
	const reviewerModel =
		asString(data.reviewerModel) ?? (reviewerNested ? asString(reviewerNested.model) : undefined);
	if (reviewerModel) out.reviewerModel = reviewerModel;
	const reviewerThinking =
		asString(data.reviewerThinking) ?? (reviewerNested ? asString(reviewerNested.thinking) : undefined);
	if (reviewerThinking) out.reviewerThinking = reviewerThinking;
	return out;
}

export function parseCard(path: string, id: string, text: string): ParsedCard {
	const { data: frontmatter, body } = parseFrontmatter(text);
	const source = body.trim().length > 0 ? body : text;
	const titleMatch = /^#\s+(.+)$/m.exec(source);
	const title = titleMatch?.[1]?.replace(new RegExp(`^Card\\s+${id}\\s*[—:-]\\s*`, "i"), "").trim() ?? id;
	const fm = parseCardFrontmatter(frontmatter);
	const dependsRaw = parseFrontmatterLikeLine(source, "Depends on");
	const dependsOn = fm.dependsOn ?? (dependsRaw ? extractCardIds(dependsRaw) : []);
	const hasDependsDeclaration = fm.dependsOn !== undefined || dependsRaw !== undefined;
	const kindRaw = parseFrontmatterLikeLine(source, "Kind")?.toLowerCase();
	const bodyKind: CardKind =
		kindRaw === "recon" || kindRaw === "read-only" || kindRaw === "readonly" ? "recon" : "write";
	const kind: CardKind = fm.kind ?? bodyKind;
	const reviewRaw = parseFrontmatterLikeLine(source, "Review")?.toLowerCase();
	const bodyProfile: ReviewProfile | undefined =
		reviewRaw === "enhanced" ? "enhanced" : reviewRaw === "light" ? "light" : undefined;
	const reviewProfile = fm.reviewProfile ?? bodyProfile;
	return {
		id,
		path,
		title,
		dependsOn,
		hasDependsDeclaration,
		kind,
		...(reviewProfile ? { reviewProfile } : {}),
		...(fm.maxCycles !== undefined ? { maxCycles: fm.maxCycles } : {}),
		...(fm.workerAgent ? { workerAgent: fm.workerAgent } : {}),
		...(fm.workerModel ? { workerModel: fm.workerModel } : {}),
		...(fm.workerThinking ? { workerThinking: fm.workerThinking } : {}),
		...(fm.reviewerAgent ? { reviewerAgent: fm.reviewerAgent } : {}),
		...(fm.reviewerModel ? { reviewerModel: fm.reviewerModel } : {}),
		...(fm.reviewerThinking ? { reviewerThinking: fm.reviewerThinking } : {}),
		...(fm.gates ? { gates: fm.gates } : {}),
		state: parseState(source),
		evidence: parseEvidence(source),
	};
}

export function phaseForState(
	state: string,
): "pending" | "review_pending" | "done" | "blocked" | "adopted-unknown" {
	if (state === "") return "pending";
	if (state.includes("done") || state.includes("complete")) return "done";
	if (state.includes("block") || state.includes("fail")) return "blocked";
	if (state.includes("review")) return "review_pending";
	if (state.includes("todo") || state.includes("pending") || state.includes("ready")) return "pending";
	return "adopted-unknown";
}

export function findDependencyProblems(problems: string[], cards: Record<string, { dependsOn: string[] }>): void {
	const ids = new Set(Object.keys(cards));
	for (const [id, card] of Object.entries(cards)) {
		for (const dep of card.dependsOn) {
			if (!ids.has(dep)) problems.push(`card ${id} depends on unknown card ${dep}`);
			if (dep === id) problems.push(`card ${id} depends on itself`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			problems.push(`dependency cycle involving card ${id}`);
			return;
		}
		visiting.add(id);
		for (const dep of cards[id]?.dependsOn ?? []) {
			if (cards[dep]) visit(dep);
		}
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of Object.keys(cards)) visit(id);
}

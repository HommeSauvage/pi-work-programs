import type { CardKind, ParsedCard, ParsedPlan, ReviewProfile } from "../shared/types.ts";

const CARD_PATH_RE = /`?(tasks\/[A-Za-z0-9._/-]+\.md)`?/g;
const CARD_ID_RE = /\b(\d{1,3}(?:\.\d+)?)\b/g;

export function parsePlan(planText: string): ParsedPlan {
	const problems: string[] = [];
	const titleMatch = /^#\s+(.+)$/m.exec(planText);
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
	return { title, config: {}, cards, problems };
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

export function parseCard(path: string, id: string, text: string): ParsedCard {
	const titleMatch = /^#\s+(.+)$/m.exec(text);
	const title = titleMatch?.[1]?.replace(new RegExp(`^Card\\s+${id}\\s*[—:-]\\s*`, "i"), "").trim() ?? id;
	const dependsRaw = parseFrontmatterLikeLine(text, "Depends on");
	const dependsOn = dependsRaw ? extractCardIds(dependsRaw) : [];
	const kindRaw = parseFrontmatterLikeLine(text, "Kind")?.toLowerCase();
	const kind: CardKind = kindRaw === "recon" || kindRaw === "read-only" || kindRaw === "readonly" ? "recon" : "write";
	const reviewRaw = parseFrontmatterLikeLine(text, "Review")?.toLowerCase();
	const reviewProfile: ReviewProfile | undefined =
		reviewRaw === "enhanced" ? "enhanced" : reviewRaw === "light" ? "light" : undefined;
	return {
		id,
		path,
		title,
		dependsOn,
		hasDependsDeclaration: dependsRaw !== undefined,
		kind,
		reviewProfile,
		state: parseState(text),
		evidence: parseEvidence(text),
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

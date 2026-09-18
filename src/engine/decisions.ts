import type { Decision, ProgramLedger } from "../shared/types.ts";
import { formatTokens, oneLine } from "../shared/text.ts";
import type { OperatorTodoItem } from "../program/operator-todos.ts";
import { counts, nextDecisionId } from "./phases.ts";

export interface DecisionHost {
	programDir: string;
	ledger: ProgramLedger;
}

export function createDecision(
	host: DecisionHost,
	input: {
		kind: Decision["kind"];
		card?: string;
		reviewPath?: string;
		summary?: string;
		message: string;
		expectedAction: string;
	},
): Decision {
	const decision: Decision = {
		id: nextDecisionId(host.ledger),
		kind: input.kind,
		status: "open",
		createdAt: Date.now(),
		message: input.message,
		expectedAction: input.expectedAction,
		packetSent: false,
	};
	if (input.card) decision.card = input.card;
	if (input.reviewPath) decision.reviewPath = input.reviewPath;
	if (input.summary) decision.summary = input.summary;
	host.ledger.decisions.push(decision);
	return decision;
}

export function resolveDecision(host: DecisionHost, id: string, patch: Partial<Decision> = {}): Decision | undefined {
	const decision = host.ledger.decisions.find((entry) => entry.id === id);
	if (!decision) return undefined;
	decision.status = "resolved";
	decision.resolvedAt = Date.now();
	Object.assign(decision, patch);
	return decision;
}

export function cancelOpenDecisionsFor(host: DecisionHost, cardId: string, reason: string): void {
	for (const decision of host.ledger.decisions) {
		if (decision.status !== "open") continue;
		if (decision.card !== cardId) continue;
		decision.status = "cancelled";
		decision.resolvedAt = Date.now();
		decision.cancelReason = reason;
	}
}

function clockOf(ms: number | undefined): string {
	if (ms === undefined) return "unknown";
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function packetText(ledger: ProgramLedger, decisions: Decision[], now: number = Date.now()): string {
	const header = `[WORK PROGRAM DECISION — ${ledger.slug} · ${ledger.mode}]`;
	const blocks = decisions.map((decision) => {
		const raised = decision.createdAt;
		const ageSeconds = raised === undefined ? undefined : Math.max(0, Math.round((now - raised) / 1000));
		const lines = [
			`Decision ${decision.id} (still open)${decision.card ? ` · card ${decision.card}` : ""}`,
			`raised ${clockOf(raised)}${ageSeconds === undefined ? "" : ` (${ageSeconds}s ago)`} · prepared ${clockOf(now)}`,
			"",
			decision.message ?? "Decision required.",
		];
		if (decision.summary) lines.push("", `Review digest: ${decision.summary}`);
		if (decision.reviewPath) lines.push(`Full review: ${decision.reviewPath}`);
		if (decision.expectedAction) lines.push("", `Answer with: ${decision.expectedAction}`);
		return lines.join("\n");
	});
	return [
		header,
		"",
		blocks.join("\n\n---\n\n"),
		"",
		"This packet is a wake-up, not the whole picture: every turn's program brief lists the decisions that are open right now. If `work_program({ action: \"status\" })` no longer lists one of these, it was answered between preparation and delivery — ignore that decision instead of re-answering it.",
	].join("\n");
}

export function reviewDecisionMessage(ledger: ProgramLedger, cardId: string, cycles: number, profile: string): string {
	return `Card ${cardId} review ${cycles} (${profile}) is ready for triage.`;
}

export function blockedDecisionMessage(cardId: string, reason: string): string {
	return `Card ${cardId} is blocked: ${reason}`;
}

export function cycleDecisionMessage(cardId: string, maxCycles: number): string {
	return `Card ${cardId} has used all ${maxCycles} review cycles and findings are still open.`;
}

export function gateDecisionMessage(cardId: string, failures: string[]): string {
	return `Card ${cardId} has unresolved gate failures: ${failures.join("; ")}`;
}

export function programGateDecisionMessage(failures: string[]): string {
	return `The program gate failed: ${failures.join("; ")}`;
}

/**
 * Handoff packet sent to the session agent the moment a program completes.
 * It carries the summary facts and the close question; the agent turns it
 * into a completion summary for the operator and only closes on confirmation.
 */
export function programCompleteMessage(ledger: ProgramLedger, openTodos: OperatorTodoItem[] = []): string {
	const { done, total } = counts(ledger);
	const lines = [
		`[WORK PROGRAM COMPLETE — ${ledger.slug}]`,
		"",
		`${ledger.title}: ${done}/${total} cards done${ledger.order.some((id) => ledger.cards[id]?.abandoned === true) ? ` (${ledger.order.filter((id) => ledger.cards[id]?.abandoned === true).length} dropped by operator)` : ""}. The work-program UI is now cleared; the records stay at ${ledger.dir} until closed.`,
		"",
		"Cards:",
	];
	for (const id of ledger.order) {
		const card = ledger.cards[id];
		if (!card) continue;
		if (card.abandoned === true) {
			lines.push(`- ${card.id} ${card.title} — DROPPED (${oneLine(card.lastError ?? "abandoned by operator", 100)})`);
			continue;
		}
		const landing = card.merge?.commit ? `merged ${card.merge.commit.slice(0, 7)}` : "done";
		const usage = card.usage ? ` · ${formatTokens(card.usage.total)} tok` : "";
		lines.push(`- ${card.id} ${card.title} — ${landing} (${card.cycles} review cycle(s))${usage}`);
	}
	const triaged = ledger.decisions.filter(
		(decision) => decision.kind === "review-triage" && decision.status === "resolved" && decision.verdicts,
	);
	if (triaged.length > 0) {
		let approved = 0;
		let rejected = 0;
		let deferred = 0;
		for (const decision of triaged) {
			for (const verdict of decision.verdicts ?? []) {
				if (verdict.verdict === "approve") approved += 1;
				else if (verdict.verdict === "reject") rejected += 1;
				else deferred += 1;
			}
		}
		lines.push(
			"",
			`Reviews: ${triaged.length} triage decision(s) resolved — ${approved} approved / ${rejected} rejected / ${deferred} deferred.`,
		);
	}
	if (ledger.programGate && ledger.programGate.length > 0) {
		lines.push(`Program gate: green (${ledger.programGate.map((gate) => gate.command).join(", ")}).`);
	} else {
		lines.push("Program gate: none configured.");
	}
	let tokenTotal = 0;
	let costTotal = 0;
	let hasUsage = false;
	for (const id of ledger.order) {
		const usage = ledger.cards[id]?.usage;
		if (!usage) continue;
		hasUsage = true;
		tokenTotal += usage.total;
		costTotal += usage.costUsd ?? 0;
	}
	if (ledger.atlas?.usage) {
		hasUsage = true;
		tokenTotal += ledger.atlas.usage.total;
		costTotal += ledger.atlas.usage.costUsd ?? 0;
	}
	if (hasUsage) {
		lines.push(`Tokens: ${formatTokens(tokenTotal)} total${costTotal > 0 ? ` · $${costTotal.toFixed(2)}` : ""} across all runs (cards + scout).`);
	}
	if (openTodos.length > 0) {
		lines.push("", `Open operator todos (${openTodos.length}) — still needing human hands (.operator/todo.md):`);
		for (const item of openTodos.slice(0, 10)) lines.push(`- ${oneLine(item.title, 120)}`);
	}
	lines.push(
		"",
		"Now:",
		"1. Reply with a completion summary for the operator (what shipped per card, review stats, record location).",
		'2. Ask: "Should I close the work program? Closing deletes the program folder and all card lanes — the git history keeps every commit."',
		'3. Only after the operator explicitly confirms, call work_program({ action: "close", remove: true }). If they keep talking or say no, do nothing — the completed program stays quiet and will not reactivate on its own.',
	);
	return lines.join("\n");
}

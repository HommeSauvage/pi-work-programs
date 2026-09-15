import type { Decision, ProgramLedger } from "../shared/types.ts";
import { nextDecisionId } from "./phases.ts";

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

export function packetText(ledger: ProgramLedger, decisions: Decision[]): string {
	const header = `[WORK PROGRAM DECISION — ${ledger.slug} · ${ledger.mode}]`;
	const blocks = decisions.map((decision) => {
		const lines = [decision.message ?? "Decision required."];
		if (decision.summary) lines.push("", `Review digest: ${decision.summary}`);
		if (decision.reviewPath) lines.push(`Full review: ${decision.reviewPath}`);
		if (decision.expectedAction) lines.push("", `Answer with: ${decision.expectedAction}`);
		return lines.join("\n");
	});
	return [header, "", blocks.join("\n\n---\n\n"), "", "Use work_program({ action: \"status\" }) for the full board."].join("\n");
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

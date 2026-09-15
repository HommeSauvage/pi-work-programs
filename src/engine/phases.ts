import type { CardLedger, CardPhase, Decision, ProgramLedger } from "../shared/types.ts";

export function depsDone(ledger: ProgramLedger, card: CardLedger): boolean {
	return card.dependsOn.every((dep) => ledger.cards[dep]?.phase === "done");
}

export function readyCards(ledger: ProgramLedger): CardLedger[] {
	return ledger.order
		.map((id) => ledger.cards[id])
		.filter((card): card is CardLedger => card !== undefined)
		.filter((card) => card.phase === "pending" || card.phase === "ready")
		.filter((card) => card.dependsOn.every((dep) => ledger.cards[dep]?.phase === "done"))
		.filter((card) => !card.lastError || card.phase === "ready");
}

export function writersInFlight(ledger: ProgramLedger): number {
	return ledger.order
		.map((id) => ledger.cards[id])
		.filter((card): card is CardLedger => card !== undefined)
		.filter((card) => card.phase === "implementing" || card.phase === "fixing" || card.phase === "reconciling")
		.length;
}

export function openDecisionFor(ledger: ProgramLedger, cardId?: string): Decision | undefined {
	return ledger.decisions.find((decision) => decision.status === "open" && (cardId === undefined || decision.card === cardId));
}

export function openDecisions(ledger: ProgramLedger): Decision[] {
	return ledger.decisions.filter((decision) => decision.status === "open");
}

export function nextDecisionId(ledger: ProgramLedger): string {
	const used = new Set(ledger.decisions.map((decision) => decision.id));
	let index = ledger.decisions.length + 1;
	while (used.has(`d${index}`)) index += 1;
	return `d${index}`;
}

export function phaseSymbol(phase: CardPhase): string {
	switch (phase) {
		case "done":
			return "✓";
		case "implementing":
		case "fixing":
		case "merging":
		case "reconciling":
		case "verifying":
			return "●";
		case "reviewing":
		case "review_pending":
			return "◐";
		case "triaging":
			return "?";
		case "approved":
			return "+";
		case "queued":
			return "→";
		case "blocked":
			return "!";
		default:
			return "·";
	}
}

export function boardLine(ledger: ProgramLedger): string {
	return ledger.order
		.map((id) => {
			const card = ledger.cards[id];
			if (!card) return `${id}?`;
			return `${id}${phaseSymbol(card.phase)}`;
		})
		.join(" ");
}

export function counts(ledger: ProgramLedger): { done: number; total: number; blocked: number } {
	let done = 0;
	let blocked = 0;
	for (const id of ledger.order) {
		const card = ledger.cards[id];
		if (!card) continue;
		if (card.phase === "done") done += 1;
		if (card.phase === "blocked") blocked += 1;
	}
	return { done, total: ledger.order.length, blocked };
}

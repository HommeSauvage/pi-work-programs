import { MAX_DIGEST_CHARS } from "./constants.ts";
import { boardLine, counts, openDecisions, readyCards } from "./engine/phases.ts";
import { formatDuration, oneLine, truncateTail } from "./shared/text.ts";
import type { ProgramLedger } from "./shared/types.ts";
import { loadResources } from "./protocol/resources.ts";

const RULES = [
	"Rules: review is mandatory (fresh read-only pass); the harness runs gates and owns plan.md/progress.md;",
	"never mark a card done yourself; use work_program actions; ask via contact_supervisor when a plan decision is needed.",
].join(" ");

export function buildBrief(ledger: ProgramLedger): string {
	const { done, total, blocked } = counts(ledger);
	const lines: string[] = [];
	lines.push(
		`[WORK PROGRAM] ${ledger.slug} · ${ledger.mode} · ${done}/${total}${blocked > 0 ? ` · ${blocked} blocked` : ""}`,
	);
	lines.push(`Board: ${boardLine(ledger)}`);
	const inFlight = ledger.order
		.map((id) => ledger.cards[id])
		.filter((card) => card && ["implementing", "reviewing", "fixing", "merging", "reconciling"].includes(card.phase))
		.map(
			(card) =>
				`${card?.id} ${card?.phase} ${formatDuration(Date.now() - (card?.activeRun?.startedAt ?? Date.now()))}`,
		);
	if (inFlight.length > 0) lines.push(`In flight: ${inFlight.join(", ")}`);
	const ready = readyCards(ledger);
	if (ready.length > 0) {
		lines.push(`Ready: ${ready.map((card) => card.id).join(", ")}`);
	}
	const decisions = openDecisions(ledger);
	if (decisions.length > 0) {
		lines.push("Open decisions:");
		for (const decision of decisions) {
			lines.push(`- ${decision.card ? `card ${decision.card}: ` : ""}${oneLine(decision.message ?? "decision required", 160)}`);
			if (decision.expectedAction) lines.push(`  ${oneLine(decision.expectedAction, 220)}`);
		}
	}
	if (ledger.status === "paused") lines.push("Program is PAUSED.");
	if (ledger.status === "complete") lines.push("Program is COMPLETE.");
	lines.push(RULES);
	return truncateTail(lines.join("\n"), MAX_DIGEST_CHARS);
}

export function planInstructions(programDir: string): string {
	const cardTemplate = loadResources().cardTemplate;
	return [
		`Work program scaffold created at ${programDir}.`,
		"",
		"Now write the program records. Execution must NOT start without the operator's explicit approval:",
		"1. Complete `plan.md`: north star, why, locked decisions, the phases/cards table, and done-when. Keep the machine config comment on line 1.",
		"2. Create `tasks/NN-<slug>.md` for every card using the card template. Every card MUST declare `Depends on:` (use `—` when none), `Kind: write|recon`, and a `## State: todo` line.",
		"3. Call `work_program({ action: \"finalize_plan\" })` to validate. Finalize only stages the program — it never starts execution.",
		"4. STOP after finalize. Present the plan and cards to the operator for review and wait for an explicit start. Never call `resume`, `start`, or `dispatch` on your own.",
		"5. Only after the operator explicitly says to start, call `work_program({ action: \"resume\" })`.",
		"",
		"Validation is strict: every card needs an explicit dependency declaration, every dependency must exist, and the graph must be acyclic.",
		"",
		"Call `work_program({ action: \"protocol\" })` for the full protocol. Card template:",
		"```markdown",
		cardTemplate.trimEnd(),
		"```",
	].join("\n");
}

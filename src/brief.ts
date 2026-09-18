import { MAX_DIGEST_CHARS } from "./constants.ts";
import { boardLine, counts, openDecisions, readyCards } from "./engine/phases.ts";
import { summarizeTodosSync } from "./program/operator-todos.ts";
import { formatDuration, oneLine, truncateTail } from "./shared/text.ts";
import type { ProgramLedger } from "./shared/types.ts";
import { loadResources } from "./protocol/resources.ts";

const RULES = [
	"Rules: review is mandatory (fresh read-only pass); the harness runs gates and owns plan.md/progress.md;",
	"never mark a card done yourself; use work_program actions; ask via contact_supervisor when a plan decision is needed.",
].join(" ");

export function buildBrief(ledger: ProgramLedger, cwd?: string): string {
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
	const atlas = ledger.atlas;
	if (atlas?.enabled && atlas.state === "building") {
		lines.push("Atlas: scout is building orientation — worker dispatch held until it lands.");
	} else if (atlas?.enabled && atlas.state === "failed") {
		lines.push(`Atlas: scout failed (${oneLine(atlas.lastError ?? "unknown", 80)}) — cards run without it.`);
	}
	const decisions = openDecisions(ledger);
	if (decisions.length > 0) {
		lines.push("Open decisions:");
		for (const decision of decisions) {
			lines.push(`- ${decision.card ? `card ${decision.card}: ` : ""}${oneLine(decision.message ?? "decision required", 160)}`);
			if (decision.expectedAction) lines.push(`  ${oneLine(decision.expectedAction, 220)}`);
		}
	}
	if (cwd) {
		const todos = summarizeTodosSync(cwd, ledger.slug);
		if (todos && todos.open.length > 0) {
			lines.push(
				`Operator todos: ${todos.open.length} open (${todos.blocking.length} blocking) — work_program({ action: "todos" }) to list.`,
			);
			for (const item of todos.blocking.slice(0, 3)) {
				lines.push(`! ${item.id} blocks card ${item.card ?? "—"}: ${oneLine(item.title, 110)}`);
			}
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
		"1. Complete `plan.md`: north star, why, locked decisions, the phases/cards table, and done-when. Keep the front matter at the top (program defaults: mode, parallelism, review profile, max cycles).",
		"2. DISCOVER THE GATES before writing cards — do not guess and do not skip. Read what the repository already runs: `package.json` scripts, CI workflows (`.github/workflows/`), `Makefile`/`justfile`, `turbo.json`/`nx.json`/`mise.toml`, and `AGENTS.md`/`CONTRIBUTING.md`/`README.md`. Put the repo's canonical check command in the plan front matter as `gates.card` (every card inherits it), e.g. `gates: { card: [\"bun run check\"] }`; add a per-card `gates:` list only where a card needs a narrower or extra command (e.g. a perf probe a card must keep green). Copy the command the repo runs — never invent one. `gates: []` is a deliberate exemption for a repo with no runnable check: say so in done-when. `finalize_plan` warns when nothing is declared.",
		"3. Create `tasks/NN-<slug>.md` for every card using the card template. Every card MUST have front matter with `dependsOn` (use `[]` when none), `kind: write|recon`, `review: light|enhanced`, and `maxCycles` set ONCE here from difficulty (trivial: light/1-2, standard: light/3, tricky: enhanced/3-5, critical: enhanced/5), plus a `## State: todo` line. The cycle budget is the operator's knob during execution — an agent never raises it (not even to finish a stuck card); only an explicit operator request may change it, via `config` with `operatorApproved: true` or a manual front-matter edit. Do NOT set card models (workerModel/reviewerModel/thinking) unless the operator explicitly asked — leave them unset to inherit the program/global defaults.",
		"4. Call `work_program({ action: \"finalize_plan\" })` to validate. Finalize only stages the program — it never starts execution.",
		"5. STOP after finalize. Present the plan and cards to the operator for review and wait for an explicit start. Never call `resume`, `start`, or `dispatch` on your own.",
		"6. Only after the operator explicitly says to start, call `work_program({ action: \"resume\" })`.",
		"",
		"Validation is strict: every card needs an explicit dependency declaration, every dependency must exist, and the graph must be acyclic.",
		"",
		"Call `work_program({ action: \"protocol\" })` for the full protocol. Card template:",
		"```markdown",
		cardTemplate.trimEnd(),
		"```",
	].join("\n");
}

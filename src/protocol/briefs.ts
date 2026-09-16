import type { CardLedger, FindingVerdict, GateResult, ProgramLedger } from "../shared/types.ts";
import { indent, oneLine, truncateTail } from "../shared/text.ts";
import { operatorTodoRule } from "../program/operator-todos.ts";
import { MAX_OUTPUT_TAIL_CHARS, MAX_REVIEW_CHARS } from "../constants.ts";
import type { ProtocolResources } from "./resources.ts";

function cardLabel(ledger: ProgramLedger, card: CardLedger): string {
	return `Card ${card.id} — ${card.title} (${ledger.slug})`;
}

export function workerBrief(input: {
	ledger: ProgramLedger;
	card: CardLedger;
	cardPath: string;
	planPath: string;
	cwd: string;
	gates: string[];
	reviewCwdNote?: string;
	repoRoot: string;
}): string {
	const { ledger, card } = input;
	const gateLines =
		input.gates.length > 0
			? input.gates.map((gate) => `   - \`${gate}\``).join("\n")
			: "   - (no gates configured; run whatever the card's `Done when` requires)";
	return [
		`You are implementing one card of the work program "${ledger.title}" (${ledger.slug}).`,
		"",
		`Card file: ${input.cardPath}`,
		`Program plan: ${input.planPath}`,
		`Working directory: ${input.cwd}`,
		input.reviewCwdNote ? input.reviewCwdNote : "",
		"The card file and plan are the shared program records: read and update them at those absolute paths.",
		"Commit only code changes in your working directory; never commit the program records from a lane.",
		"",
		"Read the card fully first, then the plan sections that concern it.",
		"",
		"Hard rules:",
		"1. Implement exactly the card's scope. No unrelated changes, no drive-by refactors.",
		"2. Complete, production-quality work: no demos, no half-done paths, tests where the repository tests.",
		`3. Run the card gate commands from the working directory:\n${gateLines}`,
		"4. Append a `## Evidence` section to the card with the EXACT command output and the commit SHA(s) you produced. Never claim a result without output.",
		"5. Set the card's `State: review`. Never write `State: done`; review is a separate pass.",
		`6. Commit only your own files with message: \`wp(${ledger.slug}): ${card.id} ${oneLine(card.title, 60)}\`.`,
		"7. Do NOT edit plan.md or progress.md.",
		"8. If blocked, or if a plan decision is wrong, stop and ask via contact_supervisor instead of guessing.",
		`Operator todos: ${operatorTodoRule(input.repoRoot, ledger.slug, card.id)}`,
		"",
		"When finished, reply with a short summary: what changed, files touched, gate results, commit SHA, and anything the reviewer should look at.",
	].join("\n");
}

export function reviewTask(input: {
	resources: ProtocolResources;
	ledger: ProgramLedger;
	card: CardLedger;
	profile: "light" | "enhanced";
	cardPath: string;
	reviewPath: string;
	cwd: string;
	branch: string;
	base: string;
	commitLog: string;
	diffStat: string;
	changedFiles: string[];
	workerSummary: string;
	gates: GateResult[];
}): string {
	const { ledger, card, profile } = input;
	const template = input.resources.reviews[profile] ?? input.resources.reviews.light ?? "";
	const gates = input.gates.length
		? input.gates
				.map((gate) => `- ${gate.command} → exit ${gate.code}`)
				.join("\n")
		: "- (none configured)";
	const insert = [
		"## Change under review",
		"",
		`${cardLabel(ledger, card)}`,
		`Card file: ${input.cardPath}`,
		`Repository: ${input.cwd}`,
		`Branch: ${input.branch} (base ${input.base.slice(0, 12)})`,
		"",
		"Commits:",
		"```",
		truncateTail(input.commitLog.trim(), 2_000) || "(none)",
		"```",
		"",
		"Changed files (diffstat):",
		"```",
		truncateTail(input.diffStat.trim(), 4_000) || "(none)",
		"```",
		"",
		`Changed file list: ${input.changedFiles.slice(0, 80).join(", ") || "(none)"}`,
		"",
		"Harness gate results:",
		gates,
		"",
		"Worker summary:",
		truncateTail(input.workerSummary.trim(), 6_000) || "(no summary returned)",
		"",
		`Write your findings to this exact path as well as your final reply: ${input.reviewPath}`,
		"",
		"Return findings as markdown. This is a read-only review: do not modify repository files.",
	].join("\n");
	const prompt = template
		.replace("[card name/path]", cardLabel(ledger, card))
		.replace("[insert a summary of the work, files to look at, logic and commits if any, that you have done]", insert);
	return truncateTail(prompt, MAX_REVIEW_CHARS + insert.length);
}

export function fixBrief(input: {
	ledger: ProgramLedger;
	card: CardLedger;
	reviewPath: string;
	verdicts: FindingVerdict[];
	gates: string[];
	repoRoot: string;
}): string {
	const approved = input.verdicts.filter((verdict) => verdict.verdict === "approve");
	const rejected = input.verdicts.filter((verdict) => verdict.verdict === "reject");
	const deferred = input.verdicts.filter((verdict) => verdict.verdict === "defer");
	const render = (items: FindingVerdict[]): string =>
		items.length === 0
			? "- (none)"
			: items
					.map((item, index) => `${index + 1}. ${item.finding}${item.note ? `\n   → ${item.note}` : ""}`)
					.join("\n");
	const gates = input.gates.length > 0 ? input.gates.map((gate) => `\`${gate}\``).join(", ") : "(none configured)";
	return [
		`The review of ${cardLabel(input.ledger, input.card)} produced findings. Implement ONLY the approved findings.`,
		"",
		"Approved (fix these):",
		render(approved),
		"",
		"Rejected (do NOT change; listed only for context):",
		render(rejected),
		"",
		"Deferred (do not act on now):",
		render(deferred),
		"",
		`Full review: ${input.reviewPath}`,
		"",
		"Rules:",
		"- Change only what the approved findings require.",
		`- Re-run the gates (${gates}), update the card's \`## Evidence\` with the new exact output and commit SHA, keep \`State: review\`, and commit with \`wp(${input.ledger.slug}): ${input.card.id} review fixes\`.`,
		"- If an approved finding is wrong or conflicts with the plan, stop and ask via contact_supervisor instead of inventing scope.",
		`Operator todos: ${operatorTodoRule(input.repoRoot, input.ledger.slug, input.card.id)}`,
		"",
		"Reply with what you changed per finding and the new commit SHA(s).",
	].join("\n");
}

export function captainBrief(input: {
	ledger: ProgramLedger;
	card: CardLedger;
	cardPath: string;
	planPath: string;
	cwd: string;
	gates: string[];
	reviewProfile: "light" | "enhanced";
	reviewPath: string;
	repoRoot: string;
	maxCycles?: number;
}): string {
	const { ledger, card } = input;
	const gates = input.gates.length > 0 ? input.gates.map((gate) => `\`${gate}\``).join(", ") : "(none configured)";
	return [
		`Run ${cardLabel(ledger, card)} end to end as the card captain of work program "${ledger.title}" (${ledger.slug}).`,
		"",
		`Card file: ${input.cardPath}`,
		`Program plan: ${input.planPath}`,
		`Working directory (lane): ${input.cwd}`,
		`Review profile: ${input.reviewProfile}`,
		`Review output path: ${input.reviewPath}`,
		"",
		"Authorized loop:",
		"1. Dispatch a fresh worker (subagent tool, agent \"worker\", context fresh) with the exact card scope; it must produce a commit and Evidence.",
		"2. Dispatch a fresh, read-only reviewer (agent \"reviewer\", context fresh) over the lane diff; write its findings to the review output path.",
		"3. Triage each finding: approve, reject, or defer it. Approved findings go back to the SAME worker (resume it when possible).",
		"4. Repeat at most " + (input.maxCycles ?? input.ledger.maxCycles) + " review cycles, then stop and report a blocker.",
		`5. Run the card gates (${gates}); the gate result is authoritative.`,
		"",
		"Hard rules:",
		"- You own this card only. Never edit plan.md or progress.md.",
		"- Review is mandatory and must be a separate fresh read-only pass. Never approve your own implementation work.",
		"- The card's `State` must be `review` while work is pending; the harness sets `done` after accepting the card.",
		"- If a product or plan decision is needed, use contact_supervisor and wait.",
		`Operator todos: ${operatorTodoRule(input.repoRoot, ledger.slug, card.id)}`,
		"",

		"Finish by calling structured_output with:",
		indent(
			[
				"{",
				'  "verdict": "done" | "blocked",',
				'  "commit": "<lane HEAD sha>",',
				'  "reviewPath": "<path>",',
				'  "cycles": <number>,',
				'  "findings": { "approved": [...], "rejected": [...], "deferred": [...] },',
				'  "gates": [{ "command": "...", "code": 0 }],',
				'  "blockers": ["..."]',
				"}",
			].join("\n"),
		),
	].join("\n");
}

export function gateFixBrief(input: {
	ledger: ProgramLedger;
	card: CardLedger;
	failures: GateResult[];
	origin: "implementation" | "merge" | "captain";
	repoRoot: string;
}): string {
	const failures = input.failures
		.map((gate) => `- \`${gate.command}\` → exit ${gate.code}\n\`\`\`\n${truncateTail(gate.tail, 3_000)}\n\`\`\``)
		.join("\n");
	return [
		`The card gates for ${cardLabel(input.ledger, input.card)} failed after ${input.origin}.`,
		"",
		"Failures:",
		failures,
		"",
		"Rules:",
		"- Fix the underlying code with the smallest correct change. Do not weaken or delete the gate.",
		"- Re-run the gates until they pass.",
		`- Update the card's \`## Evidence\` with the EXACT new output and commit SHA, keep \`State: review\`, and commit with \`wp(${input.ledger.slug}): ${input.card.id} gate fixes\`.`,
		"- If the gate itself is wrong, stop and ask via contact_supervisor instead of editing it.",
		`Operator todos: ${operatorTodoRule(input.repoRoot, input.ledger.slug, input.card.id)}`,
	].join("\n");
}

export function reconcilerBrief(input: {
	ledger: ProgramLedger;
	card: CardLedger;
	branch: string;
	cwd: string;
	conflicted: string[];
	mergeOutput: string;
	incomingIntent: string;
	existingIntent: string;
	gateCommands: string[];
}): string {
	const gates = input.gateCommands.length > 0 ? input.gateCommands.map((gate) => `\`${gate}\``).join(", ") : "(none)";
	return [
		`Reconcile a merge conflict for ${cardLabel(input.ledger, input.card)}.`,
		"",
		`Repository: ${input.cwd}`,
		`Merging lane branch \`${input.branch}\` into the program branch.`,
		`Conflicted paths: ${input.conflicted.join(", ") || "(unknown)"}`,
		"",
		"Merge state (conflict markers are in the working tree):",
		"```",
		truncateTail(input.mergeOutput.trim(), 4_000) || "(no output captured)",
		"```",
		"",
		"Incoming card intent:",
		truncateTail(input.incomingIntent.trim(), 3_000) || "(card scope unavailable)",
		"",
		"Already-merged program intent:",
		truncateTail(input.existingIntent.trim(), 3_000) || "(no recent program commits)",
		"",
		"Rules:",
		"- Read both sides' history and code before resolving. Preserve both intents where possible; never silently drop one.",
		`- Resolve the conflicts, run the card gates (${gates}), and complete the merge commit.`,
		"- If a resolution would change a card's contract or drop required behavior, stop and explain instead of guessing.",
		"- Do not touch other cards' files.",
	].join("\n");
}

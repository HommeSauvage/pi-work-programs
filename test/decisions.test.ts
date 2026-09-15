import { describe, expect, test } from "bun:test";
import { packetText } from "../src/engine/decisions.ts";
import type { Decision, ProgramLedger } from "../src/shared/types.ts";

function ledger(): ProgramLedger {
	return {
		version: 1,
		slug: "demo",
		title: "Demo",
		dir: ".agents/work-programs/demo",
		status: "active",
		mode: "managed",
		maxParallel: 2,
		parallelExecution: "worktrees",
		reviewProfile: "light",
		maxCycles: 3,
		onExhausted: "ask",
		workerAgent: "worker",
		reviewerAgent: "reviewer",
		gates: { card: [], program: [] },
		baseBranch: "main",
		baseCommit: "abc",
		laneBranchPattern: "{branch}-card-{id}",
		cards: {},
		order: [],
		mergeQueue: [],
		decisions: [],
		createdAt: 0,
		updatedAt: 0,
	};
}

function decision(patch: Partial<Decision> = {}): Decision {
	return {
		id: "d7",
		kind: "review-triage",
		card: "03",
		status: "open",
		createdAt: Date.parse("2026-09-15T20:00:00Z"),
		message: "Card 03 review 1 (light) is ready for triage.",
		expectedAction: 'work_program({ action: "triage", card: "03", verdicts: [] })',
		...patch,
	};
}

describe("packetText", () => {
	test("names the decision, its age, and its card", () => {
		const now = Date.parse("2026-09-15T20:00:45Z");
		const text = packetText(ledger(), [decision()], now);
		expect(text).toContain("[WORK PROGRAM DECISION — demo · managed]");
		expect(text).toContain("Decision d7 (still open) · card 03");
		expect(text).toContain("(45s ago)");
		expect(text).toContain("prepared ");
		expect(text).toContain("Card 03 review 1 (light) is ready for triage.");
		expect(text).toContain('Answer with: work_program({ action: "triage"');
	});

	test("tells the reader that a resolved decision should be ignored, not re-answered", () => {
		const text = packetText(ledger(), [decision()], Date.now());
		expect(text).toContain("wake-up");
		expect(text).toContain("answered between preparation and delivery");
		expect(text).toContain("ignore that decision instead of re-answering it");
	});

	test("carries a review digest and path when present", () => {
		const text = packetText(
			ledger(),
			[decision({ summary: "## Review …", reviewPath: "/p/.runtime/reviews/03-review-1.md" })],
			Date.now(),
		);
		expect(text).toContain("Review digest: ## Review …");
		expect(text).toContain("Full review: /p/.runtime/reviews/03-review-1.md");
	});

	test("a decision without a card omits the card label and survives a missing age", () => {
		const text = packetText(ledger(), [decision({ card: undefined, createdAt: undefined as never })], Date.now());
		expect(text).toContain("Decision d7 (still open)");
		expect(text).not.toContain("· card");
		expect(text).toContain("raised unknown");
	});

	test("multiple decisions are separated and each keeps its own id", () => {
		const text = packetText(
			ledger(),
			[decision({ id: "d7" }), decision({ id: "d8", kind: "blocked", card: "04", message: "Card 04 is blocked." })],
			Date.now(),
		);
		expect(text).toContain("Decision d7 (still open)");
		expect(text).toContain("Decision d8 (still open)");
		expect(text).toContain("\n\n---\n\n");
	});
});

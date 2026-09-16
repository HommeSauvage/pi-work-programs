import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "../src/brief.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { buildLedger } from "../src/program/ledger.ts";
import { parseCard } from "../src/program/parse.ts";
import { createDecision } from "../src/engine/decisions.ts";
import type { ProgramLedger } from "../src/shared/types.ts";

function program(): ProgramLedger {
	const cards = [
		parseCard("tasks/01-a.md", "01", "# Card 01 — a\n\nDepends on: —\n\n## State: done"),
		parseCard("tasks/02-b.md", "02", "# Card 02 — b\n\nDepends on: 01\n\n## State: todo"),
	];
	return buildLedger({
		slug: "demo",
		title: "Demo",
		dir: ".agents/work-programs/demo",
		settings: DEFAULT_SETTINGS,
		baseBranch: "feat/demo",
		baseCommit: "abc",
		cards,
		planText: "",
	});
}

describe("buildBrief", () => {
	test("includes the board, ready cards and protocol guardrails", () => {
		const ledger = program();
		const brief = buildBrief(ledger);
		expect(brief).toContain("[WORK PROGRAM] demo");
		expect(brief).toContain("Board:");
		expect(brief).toContain("01✓");
		expect(brief).toContain("Ready: 02");
		expect(brief).toContain("review is mandatory");
		expect(brief).toContain("never mark a card done");
	});

	test("surfaces an open decision with its expected tool call", () => {
		const ledger = program();
		ledger.cards["02"]!.phase = "triaging";
		createDecision(
			{ programDir: "/prog", ledger },
			{
				kind: "review-triage",
				card: "02",
				message: "Card 02 review 1 (light) is ready for triage.",
				expectedAction: 'work_program({ action: "triage", card: "02", verdicts: [] })',
			},
		);
		const brief = buildBrief(ledger);
		expect(brief).toContain("Card 02 review 1");
		expect(brief).toContain("action: \"triage\"");
	});

	test("names open operator todos when a cwd is given", async () => {
		const root = await mkdtemp(join(tmpdir(), "wp-brief-"));
		try {
			await mkdir(join(root, ".operator"), { recursive: true });
			const { addTodo, emptyTodoStore, serializeTodoStore } = await import("../src/program/operator-todos.ts");
			const store = emptyTodoStore();
			addTodo(store, { title: "Human step", stream: "demo", blocking: false });
			await writeFile(join(root, ".operator", "todos.json"), serializeTodoStore(store), "utf8");
			const brief = buildBrief(program(), root);
			expect(brief).toContain("Operator todos: 1 open (0 blocking)");
			// Advisory titles stay in `status`; the brief only shouts about blockers.
			expect(brief).not.toContain("Human step");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("shouts about blocking todos with their cards", async () => {
		const root = await mkdtemp(join(tmpdir(), "wp-brief-"));
		try {
			await mkdir(join(root, ".operator"), { recursive: true });
			const { addTodo, emptyTodoStore, serializeTodoStore } = await import("../src/program/operator-todos.ts");
			const store = emptyTodoStore();
			addTodo(store, { title: "Prod secret", stream: "demo", card: "02", blocking: true });
			await writeFile(join(root, ".operator", "todos.json"), serializeTodoStore(store), "utf8");
			const brief = buildBrief(program(), root);
			expect(brief).toContain("1 blocking");
			expect(brief).toContain("blocks card 02");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("omits the operator line without a cwd or file", () => {
		expect(buildBrief(program())).not.toContain("Operator todos");
	});

	test("stays bounded", () => {
		const ledger = program();
		for (let i = 0; i < 40; i += 1) {
			createDecision(
				{ programDir: "/prog", ledger },
				{
					kind: "blocked",
					card: "02",
					message: `decision ${i} `.repeat(20),
					expectedAction: "work_program({ action: \"unblock\", card: \"02\", resolution: \"redispatch\" })",
				},
			);
		}
		const brief = buildBrief(ledger);
		expect(brief.length).toBeLessThanOrEqual(1500);
	});
});

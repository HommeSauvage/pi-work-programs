import { describe, expect, test } from "bun:test";
import {
	extractCardIds,
	findDependencyProblems,
	parseCard,
	parseEvidence,
	parsePlan,
	parsePlanDependencies,
	parseState,
	phaseForState,
} from "../src/program/parse.ts";

const CARD = [
	"# Card 03 — catalog renderer",
	"",
	"**Scope:** one renderer.",
	"",
	"Depends on: 01, 02",
	"Kind: recon",
	"Review: enhanced",
	"",
	"## Steps",
	"",
	"1. Do the thing.",
	"",
	"## Done when",
	"",
	"- It renders.",
	"",
	"## Evidence",
	"",
	"```",
	"$ bun test",
	"3 pass",
	"```",
	"",
	"## State: review",
	"",
].join("\n");

describe("parseCard", () => {
	test("parses title, deps, kind, review, state and evidence", () => {
		const card = parseCard("tasks/03-catalog-renderer.md", "03", CARD);
		expect(card.title).toBe("catalog renderer");
		expect(card.dependsOn).toEqual(["01", "02"]);
		expect(card.hasDependsDeclaration).toBe(true);
		expect(card.kind).toBe("recon");
		expect(card.reviewProfile).toBe("enhanced");
		expect(card.state).toBe("review");
		expect(card.evidence).toContain("3 pass");
	});

	test("reads per-card fix-lane overrides, flat or nested under worker", () => {
		const flat = parseCard("tasks/01.md", "01", "---\nfixThinking: low\nfixModel: p/cheap\n---\n\n# Card 01 — x\n\n## State: todo");
		expect(flat.fixThinking).toBe("low");
		expect(flat.fixModel).toBe("p/cheap");
		const nested = parseCard(
			"tasks/02.md",
			"02",
			"---\nworker:\n  thinking: high\n  fixThinking: medium\n---\n\n# Card 02 — x\n\n## State: todo",
		);
		expect(nested.workerThinking).toBe("high");
		expect(nested.fixThinking).toBe("medium");
	});

	test("treats an explicit em-dash dependency line as a declaration", () => {
		const card = parseCard("tasks/01.md", "01", "# Card 01 — x\n\nDepends on: —\n\n## State: todo");
		expect(card.hasDependsDeclaration).toBe(true);
		expect(card.dependsOn).toEqual([]);
	});

	test("flags a missing declaration", () => {
		const card = parseCard("tasks/01.md", "01", "# Card 01 — x\n\n## State: todo");
		expect(card.hasDependsDeclaration).toBe(false);
	});

	test("ignores placeholder evidence", () => {
		expect(parseEvidence("# Card\n\n## Evidence\n\n(none yet)\n\n## State: todo")).toBe("");
		expect(parseState("# Card\n\n## State: done")).toBe("done");
		expect(parseState("# Card\n\n**State:** blocked by gate")).toBe("blocked by gate");
	});
});

describe("parsePlan", () => {
	test("extracts the title and card paths in order", () => {
		const plan = [
			"# Work program — inference plane",
			"",
			"| # | card | phase | depends on |",
			"| --- | --- | --- | --- |",
			"| 01 | `tasks/01-schema.md` — schema | foundations | — |",
			"| 02 | `tasks/02-key.md` — key class | foundations | — |",
		].join("\n");
		const parsed = parsePlan(plan);
		expect(parsed.title).toBe("Work program — inference plane");
		expect(parsed.cards.map((card) => card.id)).toEqual(["01", "02"]);
		expect(parsed.problems).toEqual([]);
	});

	test("reports missing title and cards", () => {
		const parsed = parsePlan("nothing here");
		expect(parsed.problems.length).toBe(2);
	});

	test("reads dependencies from the plan table", () => {
		const plan = "| 03 | `tasks/03-x.md` — x | 1 | 01, 02 |";
		expect(parsePlanDependencies(plan, "tasks/03-x.md")).toEqual(["01", "02"]);
	});

	test("extractCardIds ignores words and keeps dotted ids", () => {
		expect(extractCardIds("01, 02, 08.5 and decision 11")).toEqual(["01", "02", "08.5", "11"]);
	});
});

describe("dependency graph", () => {
	test("detects unknown dependencies and self references", () => {
		const problems: string[] = [];
		findDependencyProblems(problems, {
			"01": { dependsOn: ["99"] },
			"02": { dependsOn: ["02"] },
		});
		expect(problems.some((problem) => problem.includes("unknown card"))).toBe(true);
		expect(problems.some((problem) => problem.includes("itself"))).toBe(true);
	});

	test("detects cycles", () => {
		const problems: string[] = [];
		findDependencyProblems(problems, {
			"01": { dependsOn: ["02"] },
			"02": { dependsOn: ["03"] },
			"03": { dependsOn: ["01"] },
		});
		expect(problems.some((problem) => problem.includes("cycle"))).toBe(true);
	});
});

describe("phaseForState", () => {
	test("maps known states", () => {
		expect(phaseForState("done")).toBe("done");
		expect(phaseForState("blocked")).toBe("blocked");
		expect(phaseForState("review")).toBe("review_pending");
		expect(phaseForState("todo")).toBe("pending");
		expect(phaseForState("implementing")).toBe("adopted-unknown");
	});
});

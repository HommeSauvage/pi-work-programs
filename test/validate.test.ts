import { describe, expect, test } from "bun:test";
import { validatePlanFiles } from "../src/program/validate.ts";

const PLAN = [
	"# Work program — demo",
	"",
	"| # | card | phase | depends on |",
	"| --- | --- | --- | --- |",
	"| 01 | `tasks/01-one.md` — one | 1 | — |",
	"| 02 | `tasks/02-two.md` — two | 1 | 01 |",
].join("\n");

function card(id: string, deps: string, state = "todo"): string {
	return [
		`# Card ${id} — card ${id}`,
		"",
		`Depends on: ${deps}`,
		"Kind: write",
		"",
		"## Steps",
		"",
		"1. Do it.",
		"",
		"## Done when",
		"",
		"- done",
		"",
		"## Evidence",
		"",
		"(none yet)",
		"",
		`## State: ${state}`,
		"",
	].join("\n");
}

describe("validatePlanFiles", () => {
	test("accepts a valid plan", () => {
		const result = validatePlanFiles(PLAN, [
			{ path: "tasks/01-one.md", text: card("01", "—") },
			{ path: "tasks/02-two.md", text: card("02", "01") },
		]);
		expect(result.problems).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.cards).toHaveLength(2);
	});

	test("blocks a card without an explicit dependency declaration", () => {
		const result = validatePlanFiles(PLAN, [
			{ path: "tasks/01-one.md", text: "# Card 01 — one\n\n## State: todo\n\n## Steps\n\n1. x\n\n## Done when\n\n- x" },
			{ path: "tasks/02-two.md", text: card("02", "01") },
		]);
		expect(result.problems.some((problem) => problem.includes("Depends on"))).toBe(true);
	});

	test("blocks unknown dependencies", () => {
		const result = validatePlanFiles(PLAN, [
			{ path: "tasks/01-one.md", text: card("01", "99") },
			{ path: "tasks/02-two.md", text: card("02", "01") },
		]);
		expect(result.problems.some((problem) => problem.includes("unknown card 99"))).toBe(true);
	});

	test("blocks cycles", () => {
		const result = validatePlanFiles(PLAN, [
			{ path: "tasks/01-one.md", text: card("01", "02") },
			{ path: "tasks/02-two.md", text: card("02", "01") },
		]);
		expect(result.problems.some((problem) => problem.includes("cycle"))).toBe(true);
	});

	test("blocks a missing card file and a missing state", () => {
		const result = validatePlanFiles(PLAN, [{ path: "tasks/01-one.md", text: "# Card 01 — one" }]);
		expect(result.problems.some((problem) => problem.includes("does not exist"))).toBe(true);
		expect(result.problems.some((problem) => problem.includes("no `State:`"))).toBe(true);
	});

	test("warns about unlisted card files", () => {
		const result = validatePlanFiles(PLAN, [
			{ path: "tasks/01-one.md", text: card("01", "—") },
			{ path: "tasks/02-two.md", text: card("02", "01") },
			{ path: "tasks/09-extra.md", text: card("09", "—") },
		]);
		expect(result.warnings.some((warning) => warning.includes("09-extra.md"))).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { syncCards } from "../src/program/create.ts";
import { buildLedger, compareCardIds } from "../src/program/ledger.ts";
import { parseCard } from "../src/program/parse.ts";
import type { ParsedCard, ProgramLedger } from "../src/shared/types.ts";

function parsed(id: string, deps: string, state: string): ParsedCard {
	return parseCard(
		`tasks/${id}-card.md`,
		id,
		[`# Card ${id} — card`, "", `Depends on: ${deps}`, "Kind: write", "", `## State: ${state}`, ""].join("\n"),
	);
}

function ledgerFor(cards: ParsedCard[], planText = ""): ProgramLedger {
	return buildLedger({
		slug: "test",
		title: "Test",
		dir: ".agents/work-programs/test",
		settings: DEFAULT_SETTINGS,
		baseBranch: "main",
		baseCommit: "abc",
		cards,
		planText,
	});
}

describe("compareCardIds", () => {
	test("sorts numerically including dotted ids", () => {
		expect(["10", "2", "08.5", "1"].sort(compareCardIds)).toEqual(["1", "2", "08.5", "10"]);
	});
});

describe("buildLedger", () => {
	test("maps card states into phases", () => {
		const ledger = ledgerFor([parsed("01", "—", "done"), parsed("02", "01", "review"), parsed("03", "—", "wip")]);
		expect(ledger.cards["01"]?.phase).toBe("done");
		expect(ledger.cards["02"]?.phase).toBe("review_pending");
		expect(ledger.cards["03"]?.phase).toBe("blocked");
		expect(ledger.cards["03"]?.lastError).toContain("adopted");
		expect(ledger.order).toEqual(["01", "02", "03"]);
	});

	test("unions card dependencies with plan table dependencies", () => {
		const plan = [
			"# Work program — test",
			"| # | card | phase | depends on |",
			"| --- | --- | --- | --- |",
			"| 01 | `tasks/01-card.md` — one | 1 | 02 |",
		].join("\n");
		const ledger = ledgerFor([parsed("01", "—", "todo"), parsed("02", "—", "todo")], plan);
		expect(ledger.cards["01"]?.dependsOn).toEqual(["02"]);
	});
});

describe("syncCards", () => {
	test("adds new cards and blocks files that disappeared", () => {
		const ledger = ledgerFor([parsed("01", "—", "todo"), parsed("02", "01", "todo")]);
		const notes = syncCards(ledger, [parsed("01", "—", "todo"), parsed("03", "01", "todo")], "");
		expect(Object.keys(ledger.cards).sort()).toEqual(["01", "02", "03"]);
		expect(ledger.cards["02"]?.phase).toBe("blocked");
		expect(notes.length).toBeGreaterThan(0);
	});
});

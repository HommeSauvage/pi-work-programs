import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { buildLedger } from "../src/program/ledger.ts";
import { parseCard } from "../src/program/parse.ts";
import { reviewTask, reReviewBrief } from "../src/protocol/briefs.ts";
import { loadResources } from "../src/protocol/resources.ts";
import type { ProgramLedger } from "../src/shared/types.ts";

const REVIEW_NOTES = "/prog/.runtime/reviews/01.md";

function program(): ProgramLedger {
	const cards = [parseCard("tasks/01-a.md", "01", "# Card 01 — a\n\nDepends on: —\n\n## State: review")];
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

function firstReviewTask(ledger: ProgramLedger): string {
	return reviewTask({
		resources: loadResources(),
		ledger,
		card: ledger.cards["01"]!,
		profile: "light",
		cardPath: "/prog/tasks/01-a.md",
		reviewPath: "/prog/.runtime/reviews/01-review-1.md",
		cwd: "/repo",
		branch: "feat/demo-card-01",
		base: "abc",
		commitLog: "abc feat: card 01",
		diffStat: "src/x.ts | 2 +",
		changedFiles: ["src/x.ts"],
		workerSummary: "implemented",
		gates: [{ command: "bun run check", code: 0, at: 1, tail: "" }],
		atlasPath: "/prog/atlas.md",
		reviewNotesPath: REVIEW_NOTES,
	});
}

describe("reviewer protocol text", () => {
	test("reviewTask points at the review note and carries the settled-findings rule", () => {
		const task = firstReviewTask(program());
		expect(task).toContain(`Read the review note first at ${REVIEW_NOTES}`);
		expect(task).toContain("findings recorded as rejected or deferred are settled");
		expect(task).toContain("do not re-raise them unless you have new evidence");
	});

	test("reviewTask carries the no-probe, no-blocking-command discipline", () => {
		const task = firstReviewTask(program());
		expect(task).toContain("you are read-only");
		expect(task).toContain("NO ad-hoc probe or harness scripts");
		expect(task).toContain("nothing under /tmp");
		expect(task).toContain("anything waiting on stdin");
	});

	test("reReviewBrief points at the review note and carries the settled-findings rule", () => {
		const ledger = program();
		const task = reReviewBrief({
			ledger,
			card: ledger.cards["01"]!,
			cycle: 2,
			previousReviewPath: "/prog/.runtime/reviews/01-review-1.md",
			reviewPath: "/prog/.runtime/reviews/01-review-2.md",
			sinceSha: "abc",
			fixLog: "def fix: F1",
			fixStat: "src/x.ts | 2 +-",
			approved: [{ finding: "F1", verdict: "approve" }],
			gates: [{ command: "bun run check", code: 0, at: 1, tail: "" }],
			reviewNotesPath: REVIEW_NOTES,
		});
		expect(task).toContain(`Read the review note first at ${REVIEW_NOTES}`);
		expect(task).toContain("do not re-raise them unless you have new evidence");
		expect(task).toContain("NO ad-hoc probe or harness scripts");
	});

	test("the shipped reviewer agent forbids probe scripts and blocking commands", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const agent = readFileSync(resolve(here, "..", "agents", "work-program-reviewer.md"), "utf8");
		expect(agent).toContain("## Verification discipline");
		expect(agent).toContain("Do not\nwrite or run ad-hoc probe/harness scripts");
		expect(agent).toContain("nothing\nunder `/tmp`, nothing that spawns or waits");
		expect(agent).toContain("nothing waiting on stdin");
		expect(agent).toContain("wrap a\npotentially slow command in an explicit `timeout`");
		expect(agent).toContain("If a command runs longer\nthan ~2 minutes, stop it and report");
		expect(agent).toContain("the card gates you run at the END are the only long-ish command you need");
		// The reviewer stays read-only: the note is harness-owned.
		expect(agent).toContain("tools: read, grep, find, ls, bash, contact_supervisor");
	});
});

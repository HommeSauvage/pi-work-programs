import { describe, expect, test } from "bun:test";
import {
	cardPatchToFrontmatter,
	mergeCardFrontmatter,
	mergePlanConfig,
	normalizeCardPatch,
	overridesToPlanFrontmatter,
	parsePlanConfig,
} from "../src/config.ts";
import { parseFrontmatter, stringifyFrontmatter, upsertFrontmatter } from "../src/shared/frontmatter.ts";
import { parseCard, parsePlan } from "../src/program/parse.ts";
import { effectiveMaxCycles, effectiveReviewProfile, effectiveWorkerModel } from "../src/program/ledger.ts";
import { DEFAULT_SETTINGS, applyOverrides } from "../src/config.ts";
import { buildLedger } from "../src/program/ledger.ts";

describe("frontmatter parser", () => {
	test("parses nested maps with dash lists at two levels (gates)", () => {
		const text = [
			"---",
			"gates:",
			"  card:",
			'    - "bun run check"',
			'    - "bun test"',
			"  program:",
			'    - "bun run e2e"',
			"mode: managed",
			"---",
			"",
			"# Title",
		].join("\n");
		const { data } = parseFrontmatter(text);
		expect(data.gates).toEqual({ card: ["bun run check", "bun test"], program: ["bun run e2e"] });
		expect(data.mode).toBe("managed");
	});

	test("nested maps with dash lists round-trip through the writer", () => {
		const written = stringifyFrontmatter({
			gates: { card: ["bun run check"], program: [] },
			review: { profile: "light", maxCycles: 3 },
		});
		const { data } = parseFrontmatter(`---\n${written}\n---\n\n# Title\n`);
		expect(data.gates).toEqual({ card: ["bun run check"], program: [] });
		expect(data.review).toEqual({ profile: "light", maxCycles: 3 });
	});

	test("parses flat and nested keys", () => {
		const text = ["---", "mode: managed", "maxParallel: 3", "review:", "  profile: enhanced", "  maxCycles: 5", "---", "", "# Title", ""].join("\n");
		const { data, body } = parseFrontmatter(text);
		expect(data.mode).toBe("managed");
		expect(data.maxParallel).toBe(3);
		expect((data.review as Record<string, unknown>).profile).toBe("enhanced");
		expect((data.review as Record<string, unknown>).maxCycles).toBe(5);
		expect(body).toContain("# Title");
	});

	test("returns empty data without a fence", () => {
		const { data, body } = parseFrontmatter("# Title\n\nbody");
		expect(data).toEqual({});
		expect(body).toContain("# Title");
	});

	test("round-trips through stringify/upsert", () => {
		const updated = upsertFrontmatter("# Title\n", { mode: "captain", maxParallel: 4 });
		expect(updated.startsWith("---")).toBe(true);
		expect(updated).toContain("mode: captain");
		const { data } = parseFrontmatter(updated);
		expect(data.mode).toBe("captain");
		expect(stringifyFrontmatter({}).trim()).toBe("");
	});
});

describe("plan config front matter", () => {
	test("front matter wins over the legacy comment", () => {
		const plan = ["---", "review:", "  profile: enhanced", "  maxCycles: 5", "---", "", "# Work program — x", "", "<!-- wp: {\"review\":{\"profile\":\"light\"}} -->"].join("\n");
		const parsed = parsePlanConfig(plan);
		expect((parsed.review as Record<string, unknown>).profile).toBe("enhanced");
		expect((parsed.review as Record<string, unknown>).maxCycles).toBe(5);
	});

	test("legacy comment still reads when no front matter exists", () => {
		const parsed = parsePlanConfig('<!-- wp: {"mode":"captain"} -->\n# Work program — x');
		expect(parsed.mode).toBe("captain");
	});

	test("mergePlanConfig writes front matter and strips the legacy comment", () => {
		const plan = '<!-- wp: {"mode":"managed"} -->\n# Work program — x\n';
		const merged = mergePlanConfig(plan, { maxCycles: 2 });
		expect(merged.startsWith("---")).toBe(true);
		expect(merged).toContain("maxCycles: 2");
		expect(merged).not.toContain("<!-- wp:");
		const reparsed = parsePlanConfig(merged);
		expect((reparsed.review as Record<string, unknown>).maxCycles).toBe(2);
		expect(reparsed.mode).toBe("managed");
	});

	test("overridesToPlanFrontmatter emits nested review", () => {
		const front = overridesToPlanFrontmatter({ reviewProfile: "enhanced", maxCycles: 4 });
		expect((front.review as Record<string, unknown>).profile).toBe("enhanced");
		expect((front.review as Record<string, unknown>).maxCycles).toBe(4);
	});

	test("parsePlan exposes front matter as config", () => {
		const plan = ["---", "mode: session", "---", "", "# Work program — x", "", "`tasks/01-a.md`"].join("\n");
		const parsed = parsePlan(plan);
		expect(parsed.config.mode).toBe("session");
		expect(parsed.cards).toHaveLength(1);
	});
});

describe("card front matter", () => {
	const CARD_FM = [
		"---",
		"dependsOn: [01, 02]",
		"kind: recon",
		"review: enhanced",
		"maxCycles: 5",
		"workerModel: anthropic/claude-opus",
		"reviewerModel: openai/gpt-5",
		"---",
		"",
		"# Card 03 — hard card",
		"",
		"## Steps",
		"",
		"1. Do it.",
		"",
		"## Done when",
		"",
		"- Done.",
		"",
		"## Evidence",
		"",
		"(none yet)",
		"",
		"## State: todo",
		"",
	].join("\n");

	test("front matter wins over body lines", () => {
		const card = parseCard("tasks/03-hard.md", "03", CARD_FM);
		expect(card.dependsOn).toEqual(["01", "02"]);
		expect(card.hasDependsDeclaration).toBe(true);
		expect(card.kind).toBe("recon");
		expect(card.reviewProfile).toBe("enhanced");
		expect(card.maxCycles).toBe(5);
		expect(card.workerModel).toBe("anthropic/claude-opus");
		expect(card.reviewerModel).toBe("openai/gpt-5");
	});

	test("body lines still parse without front matter", () => {
		const card = parseCard("tasks/01-a.md", "01", "# Card 01 — x\n\nDepends on: —\nKind: write\n\n## State: todo");
		expect(card.hasDependsDeclaration).toBe(true);
		expect(card.dependsOn).toEqual([]);
		expect(card.maxCycles).toBeUndefined();
	});

	test("mergeCardFrontmatter preserves the body", () => {
		const updated = mergeCardFrontmatter("# Card 05 — x\n\n## State: todo\n", { maxCycles: 5, reviewProfile: "enhanced" });
		expect(updated.startsWith("---")).toBe(true);
		expect(updated).toContain("maxCycles: 5");
		expect(updated).toContain("review: enhanced");
		expect(updated).toContain("## State: todo");
		const reparsed = parseCard("tasks/05-x.md", "05", updated);
		expect(reparsed.maxCycles).toBe(5);
		expect(reparsed.reviewProfile).toBe("enhanced");
	});

	test("normalizeCardPatch drops empties, cardPatchToFrontmatter is flat", () => {
		const patch = normalizeCardPatch({ reviewProfile: "enhanced", maxCycles: 5, workerModel: "  ", reviewerModel: "openai/gpt-5" });
		expect(patch.reviewProfile).toBe("enhanced");
		expect(patch.maxCycles).toBe(5);
		expect(patch.workerModel).toBeUndefined();
		expect(patch.reviewerModel).toBe("openai/gpt-5");
		expect(cardPatchToFrontmatter({ maxCycles: 5 }).maxCycles).toBe(5);
	});
});

describe("per-card effective values", () => {
	function ledgerWithCard() {
		const parsed = parseCard("tasks/05-x.md", "05", ["---", "review: enhanced", "maxCycles: 1", "workerModel: custom/model", "---", "", "# Card 05 — x", "", "Depends on: —", "", "## State: todo", ""].join("\n"));
		const ledger = buildLedger({
			slug: "test",
			title: "Test",
			dir: ".agents/work-programs/test",
			settings: DEFAULT_SETTINGS,
			baseBranch: "main",
			baseCommit: "abc",
			cards: [parsed],
			planText: "",
		});
		return ledger;
	}

	test("card overrides win over program defaults", () => {
		const ledger = ledgerWithCard();
		const card = ledger.cards["05"]!;
		expect(effectiveReviewProfile(ledger, card)).toBe("enhanced");
		expect(effectiveMaxCycles(ledger, card)).toBe(1);
		expect(effectiveWorkerModel(ledger, card)).toBe("custom/model");
		// Program default still applies where the card is silent.
		expect(ledger.reviewProfile).toBe("light");
		expect(ledger.maxCycles).toBe(3);
	});

	test("applyOverrides still feeds program defaults", () => {
		const settings = applyOverrides(DEFAULT_SETTINGS, { maxCycles: 5 });
		expect(settings.review.maxCycles).toBe(5);
	});
});

describe("per-card dispatch", () => {
	test("worker and reviewer dispatches use card models", async () => {
		const { createTestHost } = await import("./helpers.ts");
		const { drive } = await import("../src/engine/driver.ts");
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.workerModel = "custom/worker";
		card.reviewerModel = "custom/reviewer";
		card.maxCycles = 5;
		card.reviewProfile = "enhanced";
		await drive(t.host);
		expect(t.fake.dispatched[0]?.request.model).toBe("custom/worker");
		// Complete the worker with evidence so a review dispatches next.
		const { join } = await import("node:path");
		t.fake.files.set(join("/repo/.agents/work-programs/test-program", "tasks/01-card.md"), (await import("./helpers.ts")).makeCardText({ id: "01", evidence: "$ bun test\npass", state: "review" }));
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const review = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer");
		expect(review?.request.model).toBe("custom/reviewer");
		expect(t.fake.progress.some((line) => line.includes("review 1 dispatched"))).toBe(true);
	});

	test("triage honors the card's maxCycles cap", async () => {
		const { createTestHost } = await import("./helpers.ts");
		const { applyTriage } = await import("../src/engine/driver.ts");
		const { createDecision } = await import("../src/engine/decisions.ts");
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.maxCycles = 1;
		card.cycles = 1;
		card.phase = "triaging";
		createDecision({ programDir: t.host.programDir, ledger: t.ledger }, {
			kind: "review-triage",
			card: "01",
			message: "review ready",
			expectedAction: 'work_program({ action: "triage", card: "01", verdicts: [] })',
		});
		const result = applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(result.ok).toBe(true);
		// Program default is 3 — the card cap of 1 is what triggered the cycle decision.
		expect(t.ledger.decisions.some((entry) => entry.kind === "cycle-exhausted")).toBe(true);
	});
});

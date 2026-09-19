import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyTriage, drive } from "../src/engine/driver.ts";
import { createTestHost, makeCardText } from "./helpers.ts";

const PROGRAM_DIR = "/repo/.agents/work-programs/test-program";

function programCardPath(cardId: string): string {
	return join(PROGRAM_DIR, `tasks/${cardId}-card.md`);
}

function writeLaneEvidence(host: ReturnType<typeof createTestHost>, cardId: string, evidence: string): void {
	host.fake.files.set(programCardPath(cardId), makeCardText({ id: cardId, evidence, state: "review" }));
}

const BIG_PEAK = { input: 100_000, output: 20_000, total: 20_000_000, windowPeak: 300_000, turns: 150, costUsd: 0.5 };

/** worker → review-1 with an approved finding → returns the card in `fixing` with a pending fix. */
async function driveToPendingFix(
	t: ReturnType<typeof createTestHost>,
	cardId: string,
	workerUsage?: Record<string, unknown>,
): Promise<void> {
	await drive(t.host);
	const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
	writeLaneEvidence(t, cardId, "$ bun test\n3 pass");
	t.completeRun(workerRun, { output: "implemented", ...(workerUsage ? { usage: workerUsage as never } : {}) });
	await drive(t.host);
	const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
	t.completeRun(reviewRun, { output: "## Findings\n- F1: missing null check" });
	await drive(t.host);
	applyTriage(t.host, cardId, [{ finding: "F1", verdict: "approve" }]);
}

describe("adaptive resume: context-peak threshold", () => {
	test("a worker session at/over the peak limit gets a fresh fix session, not a resume", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToPendingFix(t, "01", BIG_PEAK);
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;

		await drive(t.host); // dispatches the fix
		expect(t.fake.resumed.some((entry) => entry.target === workerRun)).toBe(false);
		const fix = t.fake.dispatched.filter((entry) => entry.request.kind === "fix").at(-1);
		expect(fix).toBeDefined();
		expect(fix!.request.task).toContain("FRESH session continuing an existing lane");
		expect(t.fake.progress.some((line) => line.includes("fresh session") && line.includes("peaked at"))).toBe(true);
	});

	test("a worker session under the limit resumes as before", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToPendingFix(t, "01", { input: 10_000, output: 2_000, total: 500_000, windowPeak: 90_000, turns: 40 });
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;

		await drive(t.host);
		expect(t.fake.resumed.some((entry) => entry.target === workerRun)).toBe(true);
		expect(t.ledger.cards["01"]?.workerResumeDepth).toBe(1);
	});

	test("the depth cap forces a fresh fix even when the context is small", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { resumeMaxWindowPeak: 1_000_000, resumeMaxDepth: 1 } });
		await driveToPendingFix(t, "01", { input: 10_000, output: 2_000, total: 500_000, windowPeak: 90_000, turns: 40 });
		t.ledger.cards["01"]!.workerResumeDepth = 1; // one resume already consumed

		await drive(t.host);
		const fix = t.fake.dispatched.filter((entry) => entry.request.kind === "fix").at(-1);
		expect(fix).toBeDefined();
		expect(fix!.request.task).toContain("FRESH session");
		expect(t.fake.progress.some((line) => line.includes("consecutive resumes"))).toBe(true);
		expect(t.ledger.cards["01"]?.workerResumeDepth).toBe(0);
	});

	test("a fresh fix resets the resume chain", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { resumeMaxWindowPeak: 1_000_000, resumeMaxDepth: 2 } });
		await driveToPendingFix(t, "01", { input: 10_000, output: 2_000, total: 500_000, windowPeak: 90_000, turns: 40 });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.workerResumeDepth).toBe(1);
	});

	test("a reviewer session at/over the peak limit gets a fresh reviewer on the next cycle", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(workerRun, { output: "implemented" });
		await drive(t.host);

		const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
		// The reviewer's first pass already grew a huge context.
		t.completeRun(reviewRun, { output: "## Findings\n- F1: missing null check", usage: BIG_PEAK as never });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		await drive(t.host);
		// Complete the fix (resumes the worker — small context, fine) and re-review.
		writeLaneEvidence(t, "01", "$ bun test\n5 pass (fix)");
		t.completeRun(t.ledger.cards["01"]!.activeRun!.runId, { output: "fixed" });
		await drive(t.host);

		expect(t.fake.resumed.some((entry) => entry.target === reviewRun)).toBe(false);
		const freshReviews = t.fake.dispatched.filter((entry) => entry.request.kind === "reviewer");
		expect(freshReviews).toHaveLength(2);
		expect(t.fake.progress.some((line) => line.includes("fresh reviewer"))).toBe(true);
	});
});

describe("fix-lane model and thinking", () => {
	test("a fresh fix run carries fixThinking/fixModel instead of the worker lane's", async () => {
		const t = createTestHost({
			cards: [{ id: "01" }],
			overrides: { workerModel: "p/worker", workerThinking: "high", fixModel: "p/cheap", fixThinking: "medium" },
		});
		await driveToPendingFix(t, "01", BIG_PEAK); // forces a fresh fix session
		await drive(t.host);

		const fix = t.fake.dispatched.filter((entry) => entry.request.kind === "fix").at(-1)!;
		expect(fix.request.thinking).toBe("medium");
		expect(fix.request.model).toBe("p/cheap");
	});

	test("an unset fix lane inherits the worker lane", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { workerModel: "p/worker", workerThinking: "high" } });
		await driveToPendingFix(t, "01", BIG_PEAK);
		await drive(t.host);

		const fix = t.fake.dispatched.filter((entry) => entry.request.kind === "fix").at(-1)!;
		expect(fix.request.thinking).toBe("high");
		expect(fix.request.model).toBe("p/worker");
	});

	test("a resumed fix keeps the retained child's stored contract — no fresh dispatch to change", async () => {
		const t = createTestHost({
			cards: [{ id: "01" }],
			overrides: { workerThinking: "high", fixThinking: "low" },
		});
		// A small session resumes: pi-subagents revives the stored agent/model/thinking,
		// so the fix lane knobs only ever apply to fresh fix dispatches.
		await driveToPendingFix(t, "01", { input: 10_000, output: 2_000, total: 500_000, windowPeak: 90_000, turns: 40 });
		await drive(t.host);

		expect(t.fake.resumed).toHaveLength(1);
		// The fake records resumed runs as synthetic `dispatched` entries labelled
		// "resume"; a real fresh dispatch would carry the card label instead.
		expect(t.fake.dispatched.filter((entry) => entry.request.label !== "resume")).toHaveLength(2);
		expect(t.fake.progress.some((line) => line.includes("fix dispatched (resume 1)"))).toBe(true);
		expect(t.fake.progress.some((line) => line.includes("fresh session"))).toBe(false);
		expect(t.ledger.cards["01"]?.activeRun?.resumed).toBe(true);
	});

	test("per-card fixThinking overrides the program's fix lane", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { fixThinking: "medium" } });
		t.ledger.cards["01"]!.fixThinking = "low";
		await driveToPendingFix(t, "01", BIG_PEAK);
		await drive(t.host);

		const fix = t.fake.dispatched.filter((entry) => entry.request.kind === "fix").at(-1)!;
		expect(fix.request.thinking).toBe("low");
	});
});

describe("lane handoff notes", () => {
	test("the worker brief names the lane note path and the rule to maintain it", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const task = t.fake.dispatched[0]?.request.task ?? "";
		expect(task).toContain("/repo/.agents/work-programs/test-program/.runtime/lanes/01.md");
		expect(task).toContain("lane handoff note");
	});

	test("a fresh fix session reads the lane notes before doing git archaeology", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToPendingFix(t, "01", BIG_PEAK);
		await drive(t.host);

		const fix = t.fake.dispatched.filter((entry) => entry.request.kind === "fix").at(-1)!;
		expect(fix.request.task).toContain("FRESH session continuing an existing lane");
		expect(fix.request.task).toContain("/repo/.agents/work-programs/test-program/.runtime/lanes/01.md");
		expect(fix.request.task).toContain("FIRST");
	})
	test("every fix brief (resumed too) points at the lane notes", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToPendingFix(t, "01", { input: 10_000, output: 2_000, total: 500_000, windowPeak: 90_000, turns: 40 });
		await drive(t.host);

		const resume = t.fake.resumed.at(-1)!;
		expect(resume.message).toContain("/repo/.agents/work-programs/test-program/.runtime/lanes/01.md");
		expect(resume.message).toContain("handoff note");
	});
});

describe("session-accurate usage", () => {	test("resumed runs replace their session snapshot instead of double-counting", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(workerRun, {
			output: "implemented",
			sessionFile: "/sessions/card01-worker.jsonl",
			sessionUsage: { input: 100_000, output: 20_000, total: 5_000_000, cacheRead: 4_880_000, turns: 100, costUsd: 0.4 },
		});
		await drive(t.host);
		expect(t.ledger.cards["01"]?.usageSessions).toHaveLength(1);
		expect(t.ledger.cards["01"]?.usage?.total).toBe(5_000_000);
		expect(t.ledger.cards["01"]?.usage?.cacheRead).toBe(4_880_000);

		// A fix resumes the SAME session file with larger cumulative numbers.
		const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
		t.completeRun(reviewRun, { output: "## Findings\n- F1: x" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		await drive(t.host);
		const fixRun = t.ledger.cards["01"]!.activeRun!.runId;
		writeLaneEvidence(t, "01", "$ bun test\n5 pass (fix)");
		t.completeRun(fixRun, {
			output: "fixed",
			sessionFile: "/sessions/card01-worker.jsonl",
			sessionUsage: { input: 130_000, output: 25_000, total: 6_500_000, cacheRead: 6_345_000, turns: 130, costUsd: 0.52 },
		});
		await drive(t.host);

		const card = t.ledger.cards["01"]!;
		// One session row (upsert), values = latest cumulative — never summed.
		expect(card.usageSessions).toHaveLength(1);
		expect(card.usageSessions?.[0]?.total).toBe(6_500_000);
		expect(card.usage?.total).toBe(6_500_000);
		// The per-run log still shows both runs, the resume flagged.
		expect(card.usageRuns?.filter((run) => run.session === "/sessions/card01-worker.jsonl")).toHaveLength(2);
		expect(card.usageRuns?.some((run) => run.resumed === true)).toBe(true);
	});

	test("two distinct sessions sum, and evidence reports cache reads", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(workerRun, {
			output: "implemented",
			sessionFile: "/sessions/w.jsonl",
			sessionUsage: { input: 100_000, output: 10_000, total: 4_000_000, cacheRead: 3_890_000, turns: 80, costUsd: 0.3 },
		});
		await drive(t.host);
		const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
		t.completeRun(reviewRun, {
			output: "No issues found.",
			sessionFile: "/sessions/r.jsonl",
			sessionUsage: { input: 50_000, output: 5_000, total: 1_000_000, cacheRead: 945_000, turns: 30, costUsd: 0.1 },
		});
		await drive(t.host);
		applyTriage(t.host, "01", []);
		await drive(t.host);

		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("done");
		expect(card.usage?.total).toBe(5_000_000);
		expect(card.usage?.cacheRead).toBe(4_835_000);
		const text = t.fake.files.get(programCardPath("01")) ?? "";
		expect(text).toContain("usage: 5.0M tok (cache 4.8M)");
	});
});

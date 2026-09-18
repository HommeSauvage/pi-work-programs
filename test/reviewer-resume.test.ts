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

/** Drive through worker → review-1 → triage(approve finding) → fix complete. Returns ids. */
async function driveToSecondReview(
	t: ReturnType<typeof createTestHost>,
	cardId: string,
): Promise<{ workerRun: string; reviewRun: string }> {
	await drive(t.host);
	const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
	writeLaneEvidence(t, cardId, "$ bun test\n3 pass");
	t.completeRun(workerRun, { output: "implemented" });
	await drive(t.host);
	const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
	t.completeRun(reviewRun, { output: "## Findings\n- F1: missing null check" });
	await drive(t.host);
	expect(t.ledger.cards[cardId]?.phase).toBe("triaging");
	const applied = applyTriage(t.host, cardId, [{ finding: "F1: missing null check", verdict: "approve" }]);
	expect(applied.ok).toBe(true);
	await drive(t.host);
	// The fix resumes the worker; complete it.
	writeLaneEvidence(t, cardId, "$ bun test\n5 pass (fix)");
	const fixRunId = t.ledger.cards[cardId]?.activeRun?.runId;
	expect(fixRunId).toBeDefined();
	t.completeRun(fixRunId!, { output: "fixed" });
	await drive(t.host);
	return { workerRun, reviewRun };
}

describe("reviewer resume across cycles", () => {
	test("cycle 2 resumes the same reviewer session with only the fix delta", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const { reviewRun } = await driveToSecondReview(t, "01");

		const resume = t.fake.resumed.find((entry) => entry.target === reviewRun);
		expect(resume).toBeDefined();
		expect(resume?.message).toContain("re-reviewing");
		expect(resume?.message).toContain("review cycle 2");
		expect(resume?.message).toContain("F1: missing null check");
		// Exactly one fresh reviewer dispatch overall (cycle 1).
		expect(t.fake.dispatched.filter((entry) => entry.request.kind === "reviewer")).toHaveLength(1);
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
		expect(t.ledger.cards["01"]?.cycles).toBe(1);
		expect(t.ledger.cards["01"]?.reviewRun).toBe(resume!.runId);
	});

	test("reviewerResume: false keeps a fresh reviewer per cycle", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], reviewerResume: false });
		const { reviewRun } = await driveToSecondReview(t, "01");

		expect(t.fake.resumed.some((entry) => entry.target === reviewRun)).toBe(false);
		expect(t.fake.dispatched.filter((entry) => entry.request.kind === "reviewer")).toHaveLength(2);
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
	});

	test("a failed reviewer resume falls back to a fresh reviewer with a warning", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		// Let the fix resume succeed but the reviewer resume fail.
		await drive(t.host);
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(workerRun, { output: "implemented" });
		await drive(t.host);
		const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
		t.completeRun(reviewRun, { output: "## Findings\n- F1: missing null check" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1: missing null check", verdict: "approve" }]);
		await drive(t.host);
		writeLaneEvidence(t, "01", "$ bun test\n5 pass (fix)");
		t.completeRun(t.ledger.cards["01"]!.activeRun!.runId, { output: "fixed" });

		t.fake.throwOnResume = true;
		await drive(t.host);

		expect(t.fake.dispatched.filter((entry) => entry.request.kind === "reviewer")).toHaveLength(2);
		expect(t.fake.notifications.some((message) => message.includes("could not resume the retained reviewer"))).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
	});

	test("cycle 1 never resumes: no retained reviewer exists yet", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId, { output: "implemented" });
		await drive(t.host);
		expect(t.fake.resumed).toHaveLength(0);
		expect(t.fake.dispatched.filter((entry) => entry.request.kind === "reviewer")).toHaveLength(1);
		expect(t.ledger.cards["01"]?.lastReviewedSha).toBeDefined();
	});
});

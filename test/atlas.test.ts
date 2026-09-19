import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyTriage, drive } from "../src/engine/driver.ts";
import { createTestHost, makeCardText } from "./helpers.ts";

const PROGRAM_DIR = "/repo/.agents/work-programs/test-program";
const ATLAS = join(PROGRAM_DIR, "atlas.md");

function programCardPath(cardId: string): string {
	return join(PROGRAM_DIR, `tasks/${cardId}-card.md`);
}

function writeLaneEvidence(host: ReturnType<typeof createTestHost>, cardId: string, evidence: string): void {
	host.fake.files.set(programCardPath(cardId), makeCardText({ id: cardId, evidence, state: "review" }));
}

/** Drive one card all the way to done (worker → review → empty triage → merge). */
async function driveCardToDone(t: ReturnType<typeof createTestHost>, cardId: string): Promise<void> {
	writeLaneEvidence(t, cardId, "$ bun test\n3 pass");
	t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "implemented" });
	await drive(t.host);
	const review = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer");
	t.completeRun(review!.runId, { output: "No issues found." });
	await drive(t.host);
	const applied = await applyTriage(t.host, cardId, []);
	expect(applied.ok).toBe(true);
	await drive(t.host);
	expect(t.ledger.cards[cardId]?.phase).toBe("done");
}

describe("program atlas", () => {
	test("scout builds the atlas first; workers dispatch carrying the atlas pointer", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		expect(t.fake.scoutRuns).toHaveLength(1);
		expect(t.fake.scoutRuns[0]?.request.kind).toBe("scout");
		expect(t.fake.scoutRuns[0]?.request.task).toContain("context scout");
		expect(t.fake.scoutRuns[0]?.request.task).toContain(ATLAS);
		expect(t.ledger.atlas?.state).toBe("ready");
		// The same drive reaches the worker (drain loop), with the atlas injected.
		expect(t.fake.dispatched).toHaveLength(1);
		expect(t.fake.dispatched[0]?.request.kind).toBe("worker");
		expect(t.fake.dispatched[0]?.request.task).toContain("Program atlas:");
		expect(t.fake.dispatched[0]?.request.task).toContain(ATLAS);
		// Scout usage is recorded on the atlas, not the card.
		expect(t.ledger.atlas?.usage?.total).toBe(12_000);
		expect(t.ledger.cards["01"]?.usage).toBeUndefined();
	});

	test("a hanging scout gates worker dispatch; completion releases it", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.scoutMode = "hang";
		await drive(t.host);
		expect(t.fake.scoutRuns).toHaveLength(1);
		expect(t.fake.dispatched).toHaveLength(0);
		expect(t.ledger.atlas?.state).toBe("building");

		t.fake.files.set(ATLAS, "# Atlas\n\nbuilt\n");
		t.completeRun(t.fake.scoutRuns[0]!.runId, { output: "done" });
		await drive(t.host);
		expect(t.ledger.atlas?.state).toBe("ready");
		expect(t.fake.dispatched).toHaveLength(1);
		expect(t.fake.progress.some((line) => line.includes("[program] atlas built"))).toBe(true);
	});

	test("a failed scout never blocks cards: workers proceed without the atlas", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.scoutMode = "fail";
		await drive(t.host);
		expect(t.ledger.atlas?.state).toBe("failed");
		expect(t.ledger.atlas?.lastError).toContain("scout exploded");
		expect(t.fake.dispatched).toHaveLength(1);
		expect(t.fake.dispatched[0]?.request.kind).toBe("worker");
		expect(t.fake.dispatched[0]?.request.task).not.toContain("Program atlas:");
	});

	test("an existing atlas.md is adopted without a scout run", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.files.set(ATLAS, "# Atlas\n\noperator-written orientation\n");
		await drive(t.host);
		expect(t.fake.scoutRuns).toHaveLength(0);
		expect(t.ledger.atlas?.state).toBe("ready");
		expect(t.fake.dispatched[0]?.request.task).toContain("Program atlas:");
		expect(t.fake.progress.some((line) => line.includes("[program] atlas adopted"))).toBe(true);
	});

	test("merging a card refreshes the atlas by resuming the scout", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const scoutRun = t.ledger.atlas?.runId;
		expect(scoutRun).toBeDefined();

		await driveCardToDone(t, "01");

		const refresh = t.fake.resumed.find((entry) => entry.target === scoutRun);
		expect(refresh).toBeDefined();
		// A refresh is a delta prompt, never the build brief replayed.
		expect(refresh?.message).not.toContain("Produce the program atlas");
		expect(refresh?.message).toContain("just closed");
		expect(refresh?.message).toContain("Card 01");
		expect(refresh?.message).toContain("surgically");
		expect(t.ledger.atlas?.pendingMerges).toHaveLength(0);
		expect(t.ledger.atlas?.refreshes).toBe(1);
		expect(t.ledger.atlas?.state).toBe("ready");
		// Refresh usage accumulates onto the atlas totals.
		expect(t.ledger.atlas?.usage?.total).toBe(16_000);
	});

	test("a scout refresh still in flight is closed out when the program completes", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "implemented" });
		await drive(t.host);
		const review = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!;
		t.completeRun(review.runId, { output: "No issues found." });
		await drive(t.host);
		// A refresh that never got reconciled: an in-flight scout run on the ledger.
		t.fake.statuses.set("scout-refresh-inflight", { state: "running" });
		t.ledger.atlas!.state = "refreshing";
		t.ledger.atlas!.runId = "scout-refresh-inflight";
		t.ledger.atlas!.startedAt = Date.now();
		expect((await applyTriage(t.host, "01", [])).ok).toBe(true);
		await drive(t.host);
		expect(t.ledger.status).toBe("complete");
		expect(t.ledger.atlas?.state as string).toBe("ready");
		expect(t.ledger.atlas?.runId).toBeUndefined();
		expect(t.ledger.atlas?.pendingMerges).toHaveLength(0);
		expect(t.fake.progress.some((line) => line.includes("atlas close-out at program completion"))).toBe(true);
	});

	test("atlas disabled: no scout, no pointer", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], atlas: false });
		await drive(t.host);
		expect(t.fake.scoutRuns).toHaveLength(0);
		expect(t.fake.dispatched).toHaveLength(1);
		expect(t.fake.dispatched[0]?.request.task).not.toContain("Program atlas:");
	});

	test("a failed refresh dispatch keeps the atlas ready and throttles the retry", async () => {
		// Card 02 stays pending so the program remains active for the follow-up drives.
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }], maxParallel: 1 });
		await drive(t.host);
		await driveCardToDone(t, "01");
		expect(t.ledger.atlas?.refreshes).toBe(1);

		// Land another merge's worth of pending state with everything failing.
		t.ledger.atlas!.pendingMerges.push({ id: "01", commit: "sha1" });
		t.fake.throwOnResume = true;
		t.fake.throwOnDispatch = true;
		await drive(t.host);
		// Still ready, merges kept, retry throttled into the future.
		expect(t.ledger.atlas?.state).toBe("ready");
		expect(t.ledger.atlas?.pendingMerges).toHaveLength(1);
		expect((t.ledger.atlas?.nextRefreshAt ?? 0) > Date.now()).toBe(true);
		// Next tick does not retry (throttled) — no new scout runs.
		const scoutCount = t.fake.scoutRuns.length;
		await drive(t.host);
		expect(t.fake.scoutRuns.length).toBe(scoutCount);
	});
});

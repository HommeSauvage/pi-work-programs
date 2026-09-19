import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { drive } from "../src/engine/driver.ts";
import { migrateLedger } from "../src/program/ledger.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { createTestHost, makeCardText } from "./helpers.ts";

const PROGRAM_DIR = "/repo/.agents/work-programs/test-program";

function programCardPath(cardId: string): string {
	return join(PROGRAM_DIR, `tasks/${cardId}-card.md`);
}

function writeLaneEvidence(host: ReturnType<typeof createTestHost>, cardId: string, evidence: string): void {
	host.fake.files.set(programCardPath(cardId), makeCardText({ id: cardId, evidence, state: "review" }));
}

describe("per-card gates", () => {
	test("card front-matter gates override the program gates everywhere", async () => {
		const t = createTestHost({ cards: [{ id: "01", gates: ["bun test:scoped"] }], gates: { card: ["bun test"] } });
		expect(t.ledger.cards["01"]?.gateCommands).toEqual(["bun test:scoped"]);
		await drive(t.host);

		// The worker brief names the card's gate, not the program's, once-at-end discipline included.
		const workerTask = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.request.task;
		expect(workerTask).toContain("bun test:scoped");
		expect(workerTask).not.toContain("`bun test`");
		expect(workerTask).toContain("ONCE, at the end");

		// The harness runs the card's gate at handoff.
		writeLaneEvidence(t, "01", "$ bun test:scoped\n3 pass");
		t.completeRun(t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId, { output: "done" });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.gates?.map((gate) => gate.command)).toEqual(["bun test:scoped"]);
		expect(card.phase).toBe("reviewing");
	});

	test("gates: [] exempts the card even when the program has gates", async () => {
		const t = createTestHost({ cards: [{ id: "01", gates: [] }], gates: { card: ["bun test"] } });
		await drive(t.host);
		const workerTask = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.request.task;
		expect(workerTask).toContain("No gates configured");
		writeLaneEvidence(t, "01", "docs only");
		t.completeRun(t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId, { output: "done" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.gates ?? []).toHaveLength(0);
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
	});

	test("cards without front-matter gates inherit the program gates", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { card: ["bun test"] } });
		await drive(t.host);
		const workerTask = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.request.task;
		expect(workerTask).toContain("`bun test`");
		expect(workerTask).toContain("ONCE, at the end");
	});
});

describe("run timeouts", () => {
	test("card runs carry the 4h default; scout runs get 1h", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		expect(t.fake.scoutRuns[0]?.request.timeoutMs).toBe(3_600_000);
		expect(t.fake.dispatched[0]?.request.timeoutMs).toBe(14_400_000);
	});

	test("runTimeoutMs override applies to card runs", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { runTimeoutMs: 9_000_000 } });
		expect(t.ledger.runTimeoutMs).toBe(9_000_000);
		await drive(t.host);
		expect(t.fake.dispatched[0]?.request.timeoutMs).toBe(9_000_000);
	});

	test("old ledgers migrate: runTimeoutMs backfilled, builtin reviewer swapped", () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		expect(t.ledger.reviewerAgent).toBe("work-program-reviewer");
		t.ledger.reviewerAgent = "reviewer";
		Reflect.deleteProperty(t.ledger, "runTimeoutMs");
		const changed = migrateLedger(t.ledger, { ...DEFAULT_SETTINGS });
		expect(changed).toBe(true);
		expect(t.ledger.reviewerAgent).toBe("work-program-reviewer");
		expect(t.ledger.runTimeoutMs).toBe(14_400_000);
	});

	test("migration respects an explicit settings choice of the builtin reviewer", () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.reviewerAgent = "reviewer";
		const changed = migrateLedger(t.ledger, {
			...DEFAULT_SETTINGS,
			review: { ...DEFAULT_SETTINGS.review, agent: "reviewer" },
		});
		expect(changed).toBe(false);
		expect(t.ledger.reviewerAgent).toBe("reviewer");
	});

	test("old ledgers migrate the builtin worker to the shipped work-program-worker", () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		expect(t.ledger.workerAgent).toBe("work-program-worker");
		t.ledger.workerAgent = "worker";
		const changed = migrateLedger(t.ledger, { ...DEFAULT_SETTINGS });
		expect(changed).toBe(true);
		expect(t.ledger.workerAgent).toBe("work-program-worker");
	});

	test("worker migration respects an explicit settings choice of the builtin worker", () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.workerAgent = "worker";
		const changed = migrateLedger(t.ledger, {
			...DEFAULT_SETTINGS,
			worker: { ...DEFAULT_SETTINGS.worker, agent: "worker" },
		});
		expect(changed).toBe(false);
		expect(t.ledger.workerAgent).toBe("worker");
	});
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyTriage, applyUnblock, dispatchManual, drive, finishManualMerge, rearmPausedCards } from "../src/engine/driver.ts";
import { createDecision } from "../src/engine/decisions.ts";
import { ageOpenDecisions, createTestHost, makeCardText } from "./helpers.ts";
import type { CardLedger } from "../src/shared/types.ts";

function setPhase(t: ReturnType<typeof createTestHost>, id: string, phase: CardLedger["phase"]): void {
	t.ledger.cards[id]!.phase = phase;
}
function phaseOf(t: ReturnType<typeof createTestHost>, id: string): string {
	return t.ledger.cards[id]?.phase ?? "?";
}

const PROGRAM_DIR = "/repo/.agents/work-programs/test-program";

function programCardPath(cardId: string): string {
	return join(PROGRAM_DIR, `tasks/${cardId}-card.md`);
}

function writeLaneEvidence(host: ReturnType<typeof createTestHost>, cardId: string, evidence: string): void {
	host.fake.files.set(programCardPath(cardId), makeCardText({ id: cardId, evidence, state: "review" }));
}

describe("managed driver loop", () => {
	test("runs implement → review → triage → fix → re-review → merge", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], mode: "managed" });
		await drive(t.host);
		expect(t.fake.dispatched).toHaveLength(1);
		expect(t.fake.dispatched[0]?.request.kind).toBe("worker");
		expect(t.ledger.cards["01"]?.phase).toBe("implementing");
		expect(t.ledger.cards["01"]?.lane?.branch).toBe("feat/foo-card-01");

		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "implemented" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
		const reviewRun = t.fake.dispatched[1];
		expect(reviewRun?.request.kind).toBe("reviewer");
		expect(reviewRun?.request.task).toContain("second pass");

		t.completeRun(reviewRun!.runId, { output: "## Findings\n- F1: missing null check" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
		// A freshly raised decision is not announced: the agent may answer it in
		// its current turn, and a packet would then arrive stale.
		expect(t.fake.asked).toHaveLength(0);
		ageOpenDecisions(t);
		await drive(t.host);
		expect(t.fake.asked).toHaveLength(1);
		expect(t.fake.asked[0]).toContain("triage");

		const decision = t.ledger.decisions.find((entry) => entry.kind === "review-triage");
		expect(decision).toBeDefined();
		expect(decision?.reviewPath).toBeDefined();

		const applied = applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(applied.ok).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("fixing");

		await drive(t.host);
		expect(t.fake.resumed.length).toBe(1);
		const fixRun = t.ledger.cards["01"]?.activeRun?.runId;
		expect(fixRun).toBeDefined();

		writeLaneEvidence(t, "01", "$ bun test\n5 pass (fix)");
		t.completeRun(fixRun!, { output: "fixed" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
		expect(t.ledger.cards["01"]?.cycles).toBe(1);

		const reReview = t.ledger.cards["01"]?.activeRun;
		expect(reReview?.kind).toBe("reviewer");
		t.completeRun(reReview!.runId, { output: "No issues found." });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");

		const second = applyTriage(t.host, "01", []);
		expect(second.ok).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("approved");

		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
		expect(t.ledger.mergeQueue).toHaveLength(0);
		expect(t.git.deletedBranches).toContain("feat/foo-card-01");
		const finalCard = t.fake.files.get(programCardPath("01")) ?? "";
		expect(finalCard).toContain("State: done");
		expect(finalCard).toContain("Harness evidence");
	});

	test("blocks when the worker produced no evidence", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const runId = t.fake.dispatched[0]!.runId;
		t.completeRun(runId, { output: "done" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.ledger.cards["01"]?.lastError).toContain("Evidence");
		ageOpenDecisions(t);
		await drive(t.host);
		expect(t.fake.asked.some((message) => message.includes("unblock"))).toBe(true);
	});

	test("gate failure dispatches a gate fix before review", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { card: ["bun test"] } });
		t.fake.gateResults.set("bun test", [
			{ command: "bun test", code: 1, at: Date.now(), tail: "1 fail" },
		]);
		await drive(t.host);
		writeLaneEvidence(t, "01", "$ bun test\n1 fail");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done but red" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("fixing");
		expect(t.ledger.cards["01"]?.fixReason).toBe("gate");
		const fixRequest = t.fake.dispatched.at(-1)!;
		expect(fixRequest.request.task).toContain("failed");
	});

	test("a gate fix is fresh, so its brief points at the lane note", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { card: ["bun test"] } });
		t.fake.gateResults.set("bun test", [{ command: "bun test", code: 1, at: Date.now(), tail: "1 fail" }]);
		await drive(t.host);
		writeLaneEvidence(t, "01", "$ bun test\n1 fail");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done but red" });
		await drive(t.host);
		const fixRequest = t.fake.dispatched.at(-1)!;
		expect(fixRequest.request.task).toContain("/repo/.agents/work-programs/test-program/.runtime/lanes/01.md");
		expect(fixRequest.request.task).toContain("fresh session with no history");
	});

	test("the lane note is seeded before dispatch and never overwritten afterwards", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const notePath = "/repo/.agents/work-programs/test-program/.runtime/lanes/01.md";
		expect(t.fake.files.get(notePath)).toContain("# Lane notes — card 01");
		// A worker's own note survives the next dispatch.
		t.fake.files.set(notePath, "# Lane notes — card 01\n\nDecided: keep the seam.");
		t.ledger.cards["01"]!.phase = "pending";
		t.ledger.cards["01"]!.lane = undefined;
		t.ledger.cards["01"]!.workerRun = undefined;
		await drive(t.host);
		expect(t.fake.files.get(notePath)).toBe("# Lane notes — card 01\n\nDecided: keep the seam.");
	});

	test("workers default to the shipped agent and respect an explicit worker.agent", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		expect(t.fake.dispatched[0]?.request.agent).toBe("work-program-worker");

		const custom = createTestHost({ cards: [{ id: "01" }], overrides: { workerAgent: "worker" } });
		await drive(custom.host);
		expect(custom.fake.dispatched[0]?.request.agent).toBe("worker");
	});
});

describe("dependency gating and parallelism", () => {
	test("only dependency-free cards start, up to maxParallel", async () => {
		const t = createTestHost({
			cards: [{ id: "01" }, { id: "02", depends: ["01"] }, { id: "03" }],
			maxParallel: 2,
		});
		await drive(t.host);
		const started = t.fake.dispatched.map((entry) => entry.request.label);
		expect(started).toHaveLength(2);
		expect(started.some((label) => label.includes("card 01"))).toBe(true);
		expect(started.some((label) => label.includes("card 03"))).toBe(true);
		expect(started.some((label) => label.includes("card 02"))).toBe(false);
		expect(t.ledger.cards["02"]?.phase).toBe("pending");
	});

	test("direct parallel execution serializes writers", async () => {
		const t = createTestHost({
			cards: [{ id: "01" }, { id: "02" }, { id: "03" }],
			maxParallel: 3,
			parallelExecution: "direct",
		});
		await drive(t.host);
		expect(t.fake.dispatched).toHaveLength(1);
	});
});

describe("cycle cap", () => {
	test("opens a cycle decision when the cap is hit with approved findings", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { maxCycles: 1 } });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const review = t.ledger.cards["01"]?.activeRun;
		t.completeRun(review!.runId, { output: "F1: bug" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
		const cycle = t.ledger.decisions.find((entry) => entry.kind === "cycle-exhausted");
		expect(cycle).toBeDefined();
		expect(t.ledger.cards["01"]?.cycles).toBe(1);
	});

	test("onExhausted accept approves without a decision", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { maxCycles: 1 } });
		t.ledger.onExhausted = "accept";
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.ledger.cards["01"]!.activeRun!.runId, { output: "F1: bug" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(t.ledger.cards["01"]?.phase).toBe("approved");
	});

	test("onExhausted block blocks without a decision", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], overrides: { maxCycles: 1 } });
		t.ledger.onExhausted = "block";
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.ledger.cards["01"]!.activeRun!.runId, { output: "F1: bug" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
	});
});

describe("captain mode", () => {
	test("dispatches one captain per card and accepts a structured verdict", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], mode: "captain" });
		await drive(t.host);
		const request = t.fake.dispatched[0]?.request;
		expect(request?.kind).toBe("captain");
		expect(request?.agent).toBe("work-program-captain");
		expect(request?.outputSchema).toBeDefined();
		const reviewPath = `${PROGRAM_DIR}/.runtime/reviews/01-review-1.md`;
		t.fake.files.set(reviewPath, "No issues found.");
		t.completeRun(t.fake.dispatched[0]!.runId, {
			output: "card done",
			structured: { verdict: "done", cycles: 1, reviewPath },
		});
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
	});

	test("blocks when the captain has no structured verdict", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], mode: "captain" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "I think it is done" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.ledger.cards["01"]?.lastError).toContain("structured");
	});

	test("blocks a captain verdict of done without a recorded review", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], mode: "captain" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched[0]!.runId, {
			output: "card done",
			structured: { verdict: "done", cycles: 1, reviewPath: `${PROGRAM_DIR}/.runtime/reviews/01-review-1.md` },
		});
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.ledger.cards["01"]?.lastError).toContain("review");
	});
});

describe("merge queue and reconciliation", () => {
	async function finishCardThroughReview(t: ReturnType<typeof createTestHost>, cardId: string): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, cardId, `evidence ${cardId}`);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "done" });
		await drive(t.host);
		const review = t.fake.dispatched.at(-1)!;
		expect(review.request.kind).toBe("reviewer");
		t.completeRun(review.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, cardId, []);
		await drive(t.host);
	}

	test("a conflicted merge dispatches the reconciler, then completes", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.mergeResult = { code: 1, conflicted: ["src/x.ts"], output: "CONFLICT (content): src/x.ts" };
		await finishCardThroughReview(t, "01");
		expect(t.ledger.cards["01"]?.phase).toBe("reconciling");
		const reconciler = t.fake.dispatched.at(-1)!;
		expect(reconciler.request.kind).toBe("reconciler");
		expect(reconciler.request.agent).toBe("work-program-reconciler");
		t.git.unmerged = [];
		t.completeRun(reconciler.runId, { output: "resolved in commit abc" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
	});

	test("session mode does not auto-dispatch but records a completed review", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], mode: "session" });
		await drive(t.host);
		expect(t.fake.dispatched).toHaveLength(0);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("pending");
		// Simulate a review dispatched manually by the session agent.
		card.phase = "reviewing";
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		card.activeRun = { kind: "reviewer", runId: "manual-review", startedAt: Date.now() };
		t.fake.statuses.set("manual-review", { state: "complete", output: "F1: a real defect" });
		await drive(t.host);
		expect(String(card.phase)).toBe("triaging");
		expect(t.ledger.decisions.some((decision) => decision.kind === "review-triage")).toBe(true);
		ageOpenDecisions(t);
		await drive(t.host);
		expect(t.fake.asked.length).toBeGreaterThan(0);
	});
});

describe("merge queue dirty check", () => {
	async function readyToMerge(t: ReturnType<typeof createTestHost>): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const review = t.fake.dispatched.at(-1)!;
		t.completeRun(review.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
	}

	test("program records do not count as a dirty worktree", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.statusOutput = "?? .agents/work-programs/test-program/plan.md\n?? .agents/work-programs/test-program/tasks/01-card.md";
		await readyToMerge(t);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
	});

	test("foreign changes pause the merge queue", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.statusOutput = " M src/unrelated.ts";
		await readyToMerge(t);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("queued");
		expect(t.ledger.mergeQueuePaused).toBe(true);
		t.git.statusOutput = "";
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
	});

	test("manual merge finalization marks the card done and commits records", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await readyToMerge(t);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
		const card = t.fake.files.get(programCardPath("01")) ?? "";
		expect(card).toContain("State: done");
		expect(card).toContain("Harness evidence");
		expect(t.git.commits.some((message) => message.includes("card 01 done"))).toBe(true);
	});
});

async function prepareQueuedCard(t: ReturnType<typeof createTestHost>): Promise<void> {
	await drive(t.host);
	writeLaneEvidence(t, "01", "evidence");
	t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
	await drive(t.host);
	const review = t.fake.dispatched.at(-1)!;
	t.completeRun(review.runId, { output: "No issues." });
	await drive(t.host);
	applyTriage(t.host, "01", []);
	// A foreign change holds the merge queue, leaving the card queued.
	t.git.statusOutput = " M src/unrelated.ts";
	await drive(t.host);
}

describe("reconciler retry cap", () => {
	test("blocks after three unresolved reconciliation attempts instead of looping", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.mergeResult = { code: 1, conflicted: ["src/x.ts"], output: "CONFLICT" };
		await prepareQueuedCard(t);
		t.git.statusOutput = "";
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("reconciling");
		t.git.unmerged = ["src/x.ts"];
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const reconciler = t.fake.dispatched.at(-1)!;
			expect(reconciler.request.kind).toBe("reconciler");
			t.completeRun(reconciler.runId, { output: "still conflicted" });
			await drive(t.host);
		}
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.fake.dispatched.filter((entry) => entry.request.kind === "reconciler")).toHaveLength(3);
	});
});

describe("merge failure handling", () => {
	test("a hard git merge failure blocks the card, keeps the lane, and empties the queue", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.mergeResult = { code: 128, conflicted: [], output: "fatal: refusing to merge unrelated histories" };
		await prepareQueuedCard(t);
		t.git.statusOutput = "";
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.ledger.cards["01"]?.lastError).toContain("git merge failed");
		expect(t.ledger.mergeQueue).toHaveLength(0);
		expect(t.git.deletedBranches).toHaveLength(0);
	});
});

describe("dispatch resilience", () => {
	async function driveToFixing(t: ReturnType<typeof createTestHost>): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const review = t.fake.dispatched.at(-1)!;
		t.completeRun(review.runId, { output: "F1: bug" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
		const triaged = applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(triaged.ok).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("fixing");
	}

	test("a throwing fresh-fix dispatch blocks with detail instead of stalling the drive", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToFixing(t);
		// Force the fresh-worker path (no retained worker to resume).
		t.ledger.cards["01"]!.workerRun = undefined;
		t.host.ports.runs.dispatch = async () => {
			throw new Error("agent not found");
		};
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("fix dispatch failed");
		expect(card.lastError).toContain("agent not found");
		// The drive loop survived: a second tick is a clean no-op, not a throw.
		await drive(t.host);
		expect(card.phase).toBe("blocked");
	});

	test("an infra dispatch failure retries once, then dispatches", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToFixing(t);
		t.ledger.cards["01"]!.workerRun = undefined;
		const original = t.host.ports.runs.dispatch;
		let attempts = 0;
		t.host.ports.runs.dispatch = async (request) => {
			attempts += 1;
			if (attempts === 1) throw new Error("Timed out after 30000ms waiting for runner startup control 'confirm'");
			return original(request);
		};
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(attempts).toBe(2);
		expect(card.phase).toBe("fixing");
		expect(card.activeRun?.kind).toBe("fix");
		expect(t.fake.progress.some((line) => line.includes("fix dispatched"))).toBe(true);
	});

	test("a repeated infra failure blocks with both attempts named", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveToFixing(t);
		t.ledger.cards["01"]!.workerRun = undefined;
		t.host.ports.runs.dispatch = async () => {
			throw new Error("Timed out after 30000ms waiting for runner startup control 'confirm'");
		};
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("fix dispatch failed");
		expect(card.lastError).toContain("infra failure twice");
	});

	test("a gate-fix dispatch failure blocks instead of stalling", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { card: ["bun test"] } });
		t.fake.gateResults.set("bun test", [{ command: "bun test", code: 1, at: Date.now(), tail: "1 fail" }]);
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done but red" });
		t.host.ports.runs.dispatch = async () => {
			throw new Error("agent not found");
		};
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("gate-fix dispatch failed");
	});

	test("a reconciler dispatch failure blocks with the conflict preserved", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.mergeResult = { code: 1, conflicted: ["src/x.ts"], output: "CONFLICT" };
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
		const original = t.host.ports.runs.dispatch;
		t.host.ports.runs.dispatch = async (request) => {
			if (request.kind === "reconciler") throw new Error("agent not found");
			return original(request);
		};
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("reconciler dispatch failed");
		expect(card.lastError).toContain("src/x.ts");
	});

	test("a captain dispatch failure blocks the card", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], mode: "captain" });
		t.host.ports.runs.dispatch = async () => {
			throw new Error("agent not found");
		};
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("captain dispatch failed");
	});
});

describe("unblock fix intent", () => {
	test("redispatch after a failed fix returns to fixing, not to merge", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "F1: bug" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		await drive(t.host);
		const fixRun = t.ledger.cards["01"]?.activeRun?.runId;
		expect(fixRun).toBeDefined();
		t.failRun(fixRun!, "runner went away");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain(`fix run ${fixRun} ended as failed`);
		expect(card.fixReason).toBe("review");
		const unblocked = await applyUnblock(t.host, "01", "redispatch");
		expect(unblocked.ok).toBe(true);
		// The approved finding is still pending: back to fixing, nowhere near the merge queue.
		expect(card.phase).toBe("fixing");
		expect(t.ledger.mergeQueue).not.toContain("01");
		await drive(t.host);
		expect(card.activeRun?.kind).toBe("fix");
	});

	test("redispatch after a failed gate fix re-runs the gate fix", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { card: ["bun test"] } });
		t.fake.gateResults.set("bun test", [{ command: "bun test", code: 1, at: Date.now(), tail: "1 fail" }]);
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done but red" });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("fixing");
		expect(card.fixReason).toBe("gate");
		const fixRun = card.activeRun?.runId;
		expect(fixRun).toBeDefined();
		t.failRun(fixRun!, "runner went away");
		await drive(t.host);
		expect(card.phase).toBe("blocked");
		expect(card.fixReason).toBe("gate");
		const attempts = card.gateAttempts;
		const unblocked = await applyUnblock(t.host, "01", "redispatch");
		expect(unblocked.ok).toBe(true);
		expect(card.gateAttempts).toBe((attempts ?? 0) + 1);
		expect(card.activeRun?.kind).toBe("fix");
	});

	test("redispatch after a pre-review worker failure still goes back to pending", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const runId = t.fake.dispatched[0]!.runId;
		t.failRun(runId, "boom");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain(`worker run ${runId} ended as failed`);
		const unblocked = await applyUnblock(t.host, "01", "redispatch");
		expect(unblocked.ok).toBe(true);
		expect(card.phase).toBe("pending");
		expect(card.gateAttempts).toBe(0);
	});
});

describe("paused runs", () => {
	test("a paused reconciler blocks with a pause message and parks the merge queue", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.mergeResult = { code: 1, conflicted: ["src/x.ts"], output: "CONFLICT" };
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("reconciling");
		const reconciler = card.activeRun?.runId;
		expect(reconciler).toBeDefined();
		t.fake.statuses.set(reconciler!, { state: "paused" });
		await drive(t.host);
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("paused by operator");
		expect(card.lastError).toContain(reconciler!);
		// The mid-merge head is parked, not dropped: the queue keeps its position.
		expect(t.ledger.mergeQueue).toEqual(["01"]);
		const dispatchedBefore = t.fake.dispatched.length;
		await drive(t.host);
		expect(t.ledger.mergeQueue).toEqual(["01"]);
		expect(t.fake.dispatched.length).toBe(dispatchedBefore);
		// Redispatch continues the same merge with a fresh reconciler.
		// (The conflict is still on disk: MERGE_HEAD + unmerged paths.)
		t.git.unmerged = ["src/x.ts"];
		const unblocked = await applyUnblock(t.host, "01", "redispatch");
		expect(unblocked.ok).toBe(true);
		expect(card.phase).toBe("reconciling");
		expect(t.fake.dispatched.at(-1)?.request.kind).toBe("reconciler");
	});

	test("a paused worker names the run and keeps the lane", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const runId = t.fake.dispatched[0]!.runId;
		t.fake.statuses.set(runId, { state: "paused" });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain(`worker run ${runId} paused by operator`);
		expect(card.lane?.branch).toBe("feat/foo-card-01");
	});
});
describe("program completion", () => {
	async function driveCardToDone(t: ReturnType<typeof createTestHost>): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
		applyTriage(t.host, "01", []);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
	}

	test("completing with no program gate sends the summary + close packet", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await driveCardToDone(t);
		await drive(t.host);
		expect(t.ledger.status).toBe("complete");
		expect(t.fake.progress.some((line) => line.includes("complete (no gate)"))).toBe(true);
		expect(t.git.commits.some((message) => message.includes("program complete"))).toBe(true);
		const packet = t.fake.asked.find((message) => message.includes("WORK PROGRAM COMPLETE"));
		expect(packet).toBeDefined();
		expect(packet).toContain("1/1 cards done");
		expect(packet).toContain("Should I close the work program?");
		expect(packet).toContain('work_program({ action: "close", remove: true })');
	});

	test("a green program gate completes with the gate named", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { program: ["bun gate"] } });
		await driveCardToDone(t);
		await drive(t.host);
		expect(t.ledger.status).toBe("complete");
		const packet = t.fake.asked.find((message) => message.includes("WORK PROGRAM COMPLETE"));
		expect(packet).toContain("Program gate: green (bun gate).");
	});

	test("a red program gate opens a decision and stays active", async () => {
		const t = createTestHost({ cards: [{ id: "01" }], gates: { program: ["bun gate"] } });
		t.fake.gateResults.set("bun gate", [{ command: "bun gate", code: 1, at: Date.now(), tail: "red" }]);
		await driveCardToDone(t);
		await drive(t.host);
		expect(t.ledger.status).toBe("active");
		const decision = t.ledger.decisions.find((entry) => entry.kind === "gate-failed");
		expect(decision?.status).toBe("open");
		expect(t.fake.asked.some((message) => message.includes("WORK PROGRAM COMPLETE"))).toBe(false);
	});
});

describe("operator todos", () => {
	async function driveCardToDone(t: ReturnType<typeof createTestHost>): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
	}

	test("worker briefs point at the program's todo stream", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const task = t.fake.dispatched[0]?.request.task ?? "";
		expect(task).toContain(".operator/todo.md");
		expect(task).toContain("## test-program");
		// The file is created alongside the first dispatch.
		expect(t.fake.files.get("/repo/.operator/todo.md")?.startsWith("# Operator todo")).toBe(true);
	});

	test("the drive keeps program machine state out of git status on older programs", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const ignorePath = "/repo/.agents/work-programs/test-program/.runtime/.gitignore";
		expect(t.fake.files.has(ignorePath)).toBe(false);
		await drive(t.host);
		// Lane notes, reviews and the ledger all live under .runtime; they must not
		// show up as an untracked directory in the checkout they sit beside.
		expect(t.fake.files.get(ignorePath)).toBe("*\n");
	});

	test("operator todo edits do not pause the merge queue", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.statusOutput = " M .operator/todo.md\n M src/unrelated-note.md";
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
		t.git.statusOutput = " M .operator/todo.md";
		await drive(t.host);
		// Only the operator file is dirty: the merge proceeds.
		expect(t.ledger.cards["01"]?.phase).toBe("done");
		expect(t.ledger.mergeQueuePaused).not.toBe(true);
	});

	test("the completion packet lists open todos", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.files.set(
			"/repo/.operator/todo.md",
			["# Operator todo", "", "## test-program", "### [ ] Fetch the prod secret - test-program - 01", "Blocking: no", ""].join("\n"),
		);
		await driveCardToDone(t);
		await drive(t.host);
		expect(t.ledger.status).toBe("complete");
		const packet = t.fake.asked.find((message) => message.includes("WORK PROGRAM COMPLETE"));
		expect(packet).toContain("Open operator todos (1)");
		expect(packet).toContain("Fetch the prod secret");
	});
});

describe("pause rearm", () => {
	test("run-less flight phases rearm to dispatchable phases", () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }, { id: "03" }, { id: "04" }] });
		setPhase(t, "01", "implementing");
		setPhase(t, "02", "reviewing");
		setPhase(t, "03", "fixing");
		t.ledger.cards["03"]!.fixReason = "review";
		setPhase(t, "04", "verifying");
		t.ledger.cards["04"]!.gates = [{ command: "bun test", code: 1, at: Date.now(), tail: "red" }];
		const notes = rearmPausedCards(t.host);
		expect(phaseOf(t, "01")).toBe("pending");
		expect(phaseOf(t, "02")).toBe("review_pending");
		expect(phaseOf(t, "03")).toBe("fixing");
		expect(t.ledger.cards["03"]?.fixReason).toBe("review");
		expect(phaseOf(t, "04")).toBe("fixing");
		expect(notes).toEqual(["01 implementing→pending", "02 reviewing→review_pending", "04 verifying→fixing"]);
	});

	test("cards with live runs are left alone", () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "implementing";
		card.activeRun = { kind: "worker", runId: "run-1", startedAt: Date.now() };
		card.lastError = "old";
		expect(rearmPausedCards(t.host)).toEqual([]);
		expect(card.phase).toBe("implementing");
		expect(card.activeRun?.runId).toBe("run-1");
		expect(card.lastError).toBe("old");
	});

	test("a run-less reconciling head with an open merge redispatches the reconciler", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card: CardLedger = t.ledger.cards["01"]!;
		setPhase(t, "01", "reconciling");
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		card.merge = { state: "conflict", attempts: 1 };
		t.ledger.mergeQueue.push("01");
		t.git.unmerged = ["src/x.ts"];
		await drive(t.host);
		const reconciler = t.fake.dispatched.at(-1)!;
		expect(reconciler.request.kind).toBe("reconciler");
		expect(phaseOf(t, "01")).toBe("reconciling");
		expect(card.activeRun?.kind).toBe("reconciler");
	});

	test("a run-less reconciling head with no merge state requeues", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card: CardLedger = t.ledger.cards["01"]!;
		setPhase(t, "01", "reconciling");
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		card.merge = { state: "conflict", attempts: 1 };
		t.ledger.mergeQueue.push("01");
		t.git.unmerged = [];
		await drive(t.host);
		// No merge state left: the card rejoins the queue and merges cleanly.
		expect(phaseOf(t, "01")).toBe("done");
		expect(t.fake.dispatched.some((entry) => entry.request.kind === "reconciler")).toBe(false);
	});
});

describe("stale blocked decisions", () => {
	function staleBlock(t: ReturnType<typeof createTestHost>): void {
		createDecision(
			{ programDir: t.host.programDir, ledger: t.ledger },
			{
				kind: "blocked",
				card: "01",
				message: "Card 01 is blocked: fix run ended as failed",
				expectedAction: `work_program({ action: "unblock", card: "01", resolution: "redispatch" })`,
			},
		);
	}

	test("triage succeeds with a stale blocked record shadowing it", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "F1: bug" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
		staleBlock(t);
		const applied = applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		expect(applied.ok).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("fixing");
	});

	test("unblock on a moved-on card clears the stale record without touching the phase", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "triaging";
		staleBlock(t);
		const result = await applyUnblock(t.host, "01", "redispatch");
		expect(result.ok).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
		expect(t.ledger.decisions.find((d) => d.kind === "blocked")?.status).toBe("resolved");
	});

	test("the drive sweep clears stale blocks and lets the card proceed", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.cards["01"]!.phase = "implementing";
		staleBlock(t);
		await drive(t.host);
		expect(t.ledger.decisions.find((d) => d.kind === "blocked")?.status).toBe("resolved");
		expect(t.ledger.cards["01"]?.lastError).toBeUndefined();
	});

	test("program completion ignores stale blocked records", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.cards["01"]!.phase = "done";
		staleBlock(t);
		await drive(t.host);
		expect(t.ledger.status).toBe("complete");
	});

	test("manual dispatch retires the open blocked record", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.cards["01"]!.phase = "blocked";
		staleBlock(t);
		const result = await dispatchManual(t.host, "01", "worker");
		expect(result.ok).toBe(true);
		expect(t.ledger.decisions.find((d) => d.kind === "blocked")?.status).toBe("resolved");
		expect(phaseOf(t, "01")).toBe("implementing");
	});
});

describe("fix runner-flake retries", () => {
	const RUNNER_FLAKE = "Subagent runner error: Error: Timed out after 30000ms waiting for runner startup control 'confirm'";

	async function driveToFixRun(t: ReturnType<typeof createTestHost>): Promise<string> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "F1: bug" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		await drive(t.host);
		const fixRun = t.ledger.cards["01"]?.activeRun?.runId;
		if (!fixRun) throw new Error("fix was not dispatched");
		return fixRun;
	}

	test("a runner-flaked fix retries in place instead of blocking", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.failRun(await driveToFixRun(t), RUNNER_FLAKE);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("fixing");
		expect(card.activeRun?.kind).toBe("fix");
		expect(card.infraRetries).toBe(1);
		expect(t.fake.progress.some((line) => line.includes("retry 1/2"))).toBe(true);
	});

	test("repeated flakes block loudly after the cap", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.failRun(await driveToFixRun(t), RUNNER_FLAKE);
		await drive(t.host);
		t.failRun(t.ledger.cards["01"]!.activeRun!.runId, RUNNER_FLAKE);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.infraRetries).toBe(2);
		t.failRun(t.ledger.cards["01"]!.activeRun!.runId, RUNNER_FLAKE);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("ended as failed");
		expect(card.fixReason).toBe("review");
	});

	test("a real code failure still blocks immediately", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.failRun(await driveToFixRun(t), "assertion failed in applyUsage");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.infraRetries ?? 0).toBe(0);
	});
});

describe("gitignored program records", () => {
	async function prepareApproved(t: ReturnType<typeof createTestHost>): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
	}

	test("a merge still completes when every record path is ignored", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		// The flytrader policy: the whole program folder is gitignored.
		t.git.ignoredPrefixes = [t.host.programDir];
		await prepareApproved(t);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("done");
		expect(t.ledger.mergeQueue).toEqual([]);
		expect(t.git.deletedBranches).toContain("feat/foo-card-01");
		// Records stay on disk (State: done + harness evidence) with one warning.
		const text = t.fake.files.get(programCardPath("01")) ?? "";
		expect(text).toContain("State: done");
		expect(text).toContain("Harness evidence");
		expect(t.fake.notifications.some((note) => note.includes("program records not committed"))).toBe(true);
		expect(t.fake.progress.some((line) => line.includes("records not committed"))).toBe(true);
		// No crash loop: a second tick is a clean no-op.
		await drive(t.host);
		expect(card.phase).toBe("done");
	});

	test("tracked records commit normally with no warning", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await prepareApproved(t);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
		expect(t.fake.notifications.some((note) => note.includes("program records not committed"))).toBe(false);
		expect(t.git.commits.some((message) => message.includes("card 01 done"))).toBe(true);
	});
});

describe("program reshape (file-driven removal)", () => {
	test("a removed card with no dependents is dropped from the ledger", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }, { id: "03", depends: ["02"] }] });
		// Fold 02 into 03: rewire 03 onto 01, delete 02's file.
		t.fake.files.delete(join(PROGRAM_DIR, "tasks/02-card.md"));
		t.fake.files.set(join(PROGRAM_DIR, "tasks/03-card.md"), makeCardText({ id: "03", depends: ["01"] }));
		t.ledger.cards["03"]!.dependsOn = ["01"];
		const { planCardRemoval } = await import("../src/engine/driver.ts");
		const decision = await planCardRemoval(t.host, t.ledger.cards["02"]!);
		expect(decision.drop).toBe(true);
	});

	test("a done card is never dropped", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.cards["01"]!.phase = "done";
		const { planCardRemoval } = await import("../src/engine/driver.ts");
		const decision = await planCardRemoval(t.host, t.ledger.cards["01"]!);
		expect(decision.drop).toBe(false);
		expect(decision.reason).toContain("records");
	});

	test("a card with live dependents is kept with the dependents named", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02", depends: ["01"] }] });
		const { planCardRemoval } = await import("../src/engine/driver.ts");
		const decision = await planCardRemoval(t.host, t.ledger.cards["01"]!);
		expect(decision.drop).toBe(false);
		expect(decision.reason).toContain("still a dependency of 02");
	});

	test("a lane holding work is kept; an empty lane is dropped", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		const { planCardRemoval } = await import("../src/engine/driver.ts");
		// FakeGit reports no changes by default: the empty lane is cleaned and dropped.
		const empty = await planCardRemoval(t.host, card);
		expect(empty.drop).toBe(true);
		expect(t.git.removedWorktrees).toContain("/wt/test-program/01");
	});

	test("a run-owned card is kept", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "implementing";
		const { planCardRemoval } = await import("../src/engine/driver.ts");
		const decision = await planCardRemoval(t.host, card);
		expect(decision.drop).toBe(false);
		expect(decision.reason).toContain("run owns it");
	});
});

describe("pause blocks new runs", () => {
	test("unblock redispatch is refused while paused and dispatches nothing", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "F1: bug" });
		await drive(t.host);
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "approve" }]);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("fixing");
		// The fix run dispatches, then dies; the operator soft-pauses before answering.
		await drive(t.host);
		const fixRun = card.activeRun!.runId;
		t.failRun(fixRun, "runner died");
		await drive(t.host);
		expect(card.phase).toBe("blocked");
		t.ledger.status = "paused";
		const before = t.fake.dispatched.length;
		const resumedBefore = t.fake.resumed.length;
		const result = await applyUnblock(t.host, "01", "redispatch");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("program is paused");
		expect(result.error).toContain("resume first");
		expect(t.fake.dispatched.length).toBe(before);
		expect(t.fake.resumed.length).toBe(resumedBefore);
	});

	test("unblock done and abandon still work while paused", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		t.ledger.status = "paused";
		const abandoned = await applyUnblock(t.host, "01", "abandon");
		expect(abandoned.ok).toBe(true);
		expect(card.abandoned).toBe(true);
	});

	test("manual dispatch is refused while paused", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.ledger.status = "paused";
		const result = await dispatchManual(t.host, "01", "worker");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("program is paused");
		expect(t.fake.dispatched).toHaveLength(0);
	});

	test("resume re-enables redispatch", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		t.ledger.status = "paused";
		const blocked = await applyUnblock(t.host, "01", "redispatch");
		expect(blocked.ok).toBe(false);
		t.ledger.status = "active";
		const allowed = await applyUnblock(t.host, "01", "redispatch");
		expect(allowed.ok).toBe(true);
	});
});

describe("quota holds", () => {
	const QUOTA = "GoUsageLimitError: 5-hour usage limit reached. Resets in 1hr 27min";

	test("a quota failure holds the card instead of raising a decision", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const runId = t.fake.dispatched[0]!.runId;
		t.failRun(runId, QUOTA);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("pending");
		expect(card.holdUntil).toBeGreaterThan(Date.now());
		expect(card.holdCount).toBe(1);
		expect(card.holdReason).toContain('1hr 27min');
		// No decision packet, no supervisor question.
		expect(t.ledger.decisions.filter((entry) => entry.kind === "blocked")).toHaveLength(0);
		expect(t.fake.asked.some((message) => message.includes("unblock"))).toBe(false);
		// The hold line names the delay it parsed and where it came from.
		const line = t.fake.progress.find((entry) => entry.includes("quota held"));
		expect(line).toContain("held until");
		expect(line).toContain("1hr 27min");
		// The raw provider error is never quoted into the log — the parsed delay is the signal.
		expect(line).not.toContain("GoUsageLimitError");
	});

	test("a held card is not dispatched, and becomes dispatchable when the hold expires", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		t.failRun(t.fake.dispatched[0]!.runId, QUOTA);
		await drive(t.host);
		const dispatchedWhileHeld = t.fake.dispatched.length;
		await drive(t.host);
		await drive(t.host);
		expect(t.fake.dispatched.length).toBe(dispatchedWhileHeld);
		// Expire the hold: the next tick re-dispatches without any operator action.
		t.ledger.cards["01"]!.holdUntil = Date.now() - 1;
		await drive(t.host);
		expect(t.fake.dispatched.length).toBe(dispatchedWhileHeld + 1);
	});

	test("a repeat quota failure extends the hold instead of escalating", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		t.failRun(t.fake.dispatched[0]!.runId, QUOTA);
		await drive(t.host);
		t.ledger.cards["01"]!.holdUntil = Date.now() - 1;
		await drive(t.host);
		t.failRun(t.ledger.cards["01"]!.activeRun!.runId, QUOTA);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.holdCount).toBe(2);
		expect(card.phase).toBe("pending");
		expect(t.ledger.decisions.filter((entry) => entry.kind === "blocked")).toHaveLength(0);
		expect(t.fake.progress.some((line) => line.includes("quota extended"))).toBe(true);
	});

	test("past the hold cap the card blocks with the reset time named", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		card.holdCount = 3;
		t.failRun(t.fake.dispatched[0]!.runId, QUOTA);
		await drive(t.host);
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("Resets in 1hr 27min");
	});

	test("a quota failure with no parseable reset blocks as before", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		t.failRun(t.fake.dispatched[0]!.runId, "GoUsageLimitError: 5-hour usage limit reached");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.holdUntil).toBeUndefined();
	});

	test("a successful run clears the hold state", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		t.failRun(t.fake.dispatched[0]!.runId, QUOTA);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		card.holdUntil = Date.now() - 1;
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(card.activeRun!.runId, { output: "done" });
		await drive(t.host);
		expect(card.holdUntil).toBeUndefined();
		expect(card.holdCount).toBe(0);
		expect(card.phase).toBe("reviewing");
	});

	test("a quota failure in a review also holds rather than blocking", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const reviewRun = t.ledger.cards["01"]!.activeRun!.runId;
		t.failRun(reviewRun, QUOTA);
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("review_pending");
		expect(card.holdCount).toBe(1);
	});
});

describe("drain (a merge cannot strand ready work)", () => {
	test("a merge in one tick dispatches the dependent card in the same tick", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02", depends: ["01"] }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "No issues." });
		await drive(t.host);
		applyTriage(t.host, "01", []);
		// One tick: merge 01, and 02 becomes ready as a result of that merge.
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
		expect(t.ledger.cards["02"]?.phase).toBe("implementing");
		expect(t.fake.dispatched.some((entry) => entry.request.label.includes("card 02"))).toBe(true);
	});

	test("the queue drains fully in one tick without new events", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }], maxParallel: 2 });
		// Both cards reach approved+queued first, so the queue holds two entries.
		for (const id of ["01", "02"]) {
			writeLaneEvidence(t, id, `evidence ${id}`);
			const card = t.ledger.cards[id]!;
			card.phase = "approved";
			card.lane = { path: `/wt/test-program/${id}`, branch: `feat/foo-card-${id}`, base: "base0" };
		}
		await drive(t.host);
		expect(t.ledger.mergeQueue).toEqual([]);
		expect(t.ledger.cards["01"]?.phase).toBe("done");
		expect(t.ledger.cards["02"]?.phase).toBe("done");
	});

	test("a parked merge failure does not retry in the same tick", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.mergeResult = { code: 0, conflicted: [], output: "merged" };
		let commits = 0;
		const original = t.git.commitMerge;
		t.git.commitMerge = async (cwd: string) => {
			commits += 1;
			if (commits === 1) throw new Error("commit exploded");
			return original.call(t.git, cwd);
		};
		writeLaneEvidence(t, "01", "evidence");
		const card = t.ledger.cards["01"]!;
		card.phase = "approved";
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		await drive(t.host);
		expect(commits).toBe(1);
		expect(t.ledger.cards["01"]?.lastError).toContain("merge commit failed");
	});
});

describe("legacy abandoned tombstones", () => {
	test("legacy abandoned cards do not block completion or count as blocked", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }] });
		t.ledger.cards["01"]!.phase = "done";
		const ghost = t.ledger.cards["02"]!;
		ghost.phase = "blocked";
		ghost.lastError = "abandoned by operator";
		// The tombstones must not read as live work either.
		const { counts, isAbandonedCard } = await import("../src/engine/phases.ts");
		expect(isAbandonedCard(ghost)).toBe(true);
		const counted = counts(t.ledger);
		expect(counted.blocked).toBe(0);
		expect(counted.abandoned).toBe(1);
		// Completion is not wedged by the tombstone.
		await drive(t.host);
		expect(t.ledger.status).toBe("complete");
	});

	test("a legacy tombstone with no file and no lane is dropped by sync", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }] });
		const ghost = t.ledger.cards["02"]!;
		ghost.phase = "blocked";
		ghost.lastError = "abandoned by operator";
		ghost.dependsOn = [];
		const { planCardRemoval } = await import("../src/engine/driver.ts");
		const decision = await planCardRemoval(t.host, ghost);
		expect(decision.drop).toBe(true);
		expect(decision.note).toContain("abandoned");
	});
});

describe("review-run failures and already-committed lanes", () => {
	/** A card that is implemented+committed in its lane, blocked on a dead review run. */
	function blockedInReview(t: ReturnType<typeof createTestHost>): void {
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		card.blockedFrom = "reviewing";
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "sha1" };
		card.merge = { state: "queued", attempts: 0 };
		card.lastError = "reviewer run run-9 ended as failed: Inference admission is unavailable";
	}

	test("redispatch after a review-run failure re-enters review, not implementation", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		blockedInReview(t);
		const result = await applyUnblock(t.host, "01", "redispatch");
		expect(result.ok).toBe(true);
		expect(t.ledger.cards["01"]?.phase).toBe("review_pending");
		await drive(t.host);
		expect(t.fake.dispatched.at(-1)?.request.kind).toBe("reviewer");
		expect(t.fake.dispatched.some((entry) => entry.request.kind === "worker")).toBe(false);
	});

	test("a worker dispatch is skipped when the lane already carries the implementation", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.git.changedFilesResult = ["src/App.tsx"];
		t.fake.files.set(programCardPath("01"), makeCardText({ id: "01", evidence: "$ bun test\n3 pass", state: "review" }));
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("reviewing");
		expect(t.fake.dispatched.some((entry) => entry.request.kind === "worker")).toBe(false);
		expect(t.fake.dispatched.some((entry) => entry.request.kind === "reviewer")).toBe(true);
		expect(t.fake.progress.some((line) => line.includes("skip worker"))).toBe(true);
	});

	test("a no-edit guard failure on a committed lane is salvaged into review", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.files.set(programCardPath("01"), makeCardText({ id: "01", evidence: "$ bun test\n3 pass", state: "review" }));
		await drive(t.host);
		const workerRun = t.fake.dispatched[0]!.runId;
		// The lane holds the implementation, so the guard now fires for a no-op worker.
		t.git.changedFilesResult = ["src/App.tsx"];
		t.failRun(workerRun, "worker completed without making edits for an implementation task");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("reviewing");
		expect(card.lastError ?? "").toBe("");
		expect(t.fake.progress.some((line) => line.includes("salvage"))).toBe(true);
	});

	test("the guard still blocks when the lane has no commits", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		t.failRun(t.fake.dispatched[0]!.runId, "worker completed without making edits for an implementation task");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("without making edits");
	});
});

describe("provider blips on any run kind", () => {
	test("a 503 outage on a review run retries in place instead of blocking", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const reviewRun = t.ledger.cards["01"]!.activeRun!.runId;
		t.failRun(reviewRun, "Inference admission is unavailable");
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.infraRetries).toBe(1);
		expect(t.ledger.decisions.filter((entry) => entry.kind === "blocked")).toHaveLength(0);
		// The retry re-enters review and a fresh reviewer is dispatched on the same tick.
		expect(card.phase).toBe("reviewing");
		expect(card.activeRun?.kind).toBe("reviewer");
		expect(t.fake.dispatched.at(-1)?.request.kind).toBe("reviewer");
		expect(t.fake.progress.some((line) => line.includes("blip"))).toBe(true);
	});

	test("a persistent outage still blocks after the retry cap", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const run = t.ledger.cards["01"]!.activeRun?.runId;
			if (!run) break;
			t.failRun(run, "503 Service Unavailable");
			await drive(t.host);
		}
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("503");
	});
});

describe("decision packet wake-up gating", () => {
	/** Only the "[WORK PROGRAM DECISION …]" messages; completion summaries are not packets. */
	const decisionPackets = (t: ReturnType<typeof createTestHost>): string[] =>
		t.fake.asked.filter((message) => message.includes("[WORK PROGRAM DECISION"));

	/** Drive an implement→review cycle so a review-triage decision exists. */
	async function raiseTriageDecision(t: ReturnType<typeof createTestHost>): Promise<void> {
		await drive(t.host);
		writeLaneEvidence(t, "01", "evidence");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		t.completeRun(t.fake.dispatched.at(-1)!.runId, { output: "F1: bug" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("triaging");
	}

	test("a fresh decision is not announced even when the session is idle", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.sessionIdle = true;
		await raiseTriageDecision(t);
		expect(decisionPackets(t)).toHaveLength(0);
		// Still pending, not marked sent: the next tick re-evaluates it.
		const decision = t.ledger.decisions.find((entry) => entry.kind === "review-triage")!;
		expect(decision.status).toBe("open");
		expect(decision.packetSent).not.toBe(true);
	});

	test("an aged decision is announced once the session is idle", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await raiseTriageDecision(t);
		ageOpenDecisions(t);
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
		expect(t.fake.asked[0]).toContain("Decision d");
		expect(t.fake.asked[0]).toContain("raised");
	});

	test("a busy session defers the packet however old the decision is", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await raiseTriageDecision(t);
		ageOpenDecisions(t, 30_000);
		t.fake.sessionIdle = false;
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(0);
		// The decision is unanswered, so it must survive for the next tick.
		expect(t.ledger.decisions.find((entry) => entry.kind === "review-triage")?.packetSent).not.toBe(true);
		// Going idle delivers it without any further change.
		t.fake.sessionIdle = true;
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
	});

	test("a session that never goes idle still gets packets past the force age", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await raiseTriageDecision(t);
		ageOpenDecisions(t, 200_000);
		t.fake.sessionIdle = false;
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
	});

	test("a decision answered before delivery is never announced", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await raiseTriageDecision(t);
		ageOpenDecisions(t);
		t.fake.sessionIdle = false;
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(0);
		// The agent answers it during its turn; the pending packet must be dropped.
		applyTriage(t.host, "01", [{ finding: "F1", verdict: "reject" }]);
		t.fake.sessionIdle = true;
		await drive(t.host);
		// Completion may announce itself; no *decision* packet may follow the answer.
		expect(decisionPackets(t)).toHaveLength(0);
	});

	test("a delivered packet is never re-sent on later ticks", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await raiseTriageDecision(t);
		ageOpenDecisions(t);
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
		await drive(t.host);
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
	});

	test("only the eligible subset is announced and marked sent", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02" }] });
		await raiseTriageDecision(t);
		// A second, younger decision for another card.
		const { createDecision } = await import("../src/engine/decisions.ts");
		const young = createDecision(
			{ programDir: t.host.programDir, ledger: t.ledger },
			{
				kind: "blocked",
				card: "02",
				message: "Card 02 is blocked: something.",
				expectedAction: 'work_program({ action: "unblock", card: "02", resolution: "redispatch" })',
			},
		);
		const aged = t.ledger.decisions.find((entry) => entry.kind === "review-triage")!;
		aged.createdAt = Date.now() - 30_000;
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
		expect(t.fake.asked[0]).toContain(`Decision ${aged.id}`);
		expect(t.fake.asked[0]).not.toContain(`Decision ${young.id}`);
		expect(aged.packetSent).toBe(true);
		expect(young.packetSent).not.toBe(true);
	});

	test("a blocked card after a run failure still reaches the operator once aged", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		t.failRun(t.fake.dispatched[0]!.runId, "something went wrong in the code");
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(decisionPackets(t)).toHaveLength(0);
		ageOpenDecisions(t);
		await drive(t.host);
		expect(decisionPackets(t)).toHaveLength(1);
		expect(t.fake.asked[0]).toContain("unblock");
	});
});

describe("dispatch failures", () => {
	test("a failing dispatch blocks the card instead of retrying silently", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const original = t.host.ports.runs.dispatch;
		t.host.ports.runs.dispatch = async () => {
			throw new Error("agent not found");
		};
		await drive(t.host);
		t.host.ports.runs.dispatch = original;
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.ledger.cards["01"]?.lastError).toContain("dispatch failed");
	});
});

describe("lost run recovery", () => {
	test("an unknown run state blocks the card after the grace period", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		const runId = t.fake.dispatched[0]!.runId;
		t.fake.statuses.set(runId, { state: "unknown" });
		card.activeRun = { kind: "worker", runId, startedAt: Date.now() - 11 * 60_000 };
		await drive(t.host);
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("could not be determined");
	});

	test("a fresh unknown run state waits", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		const runId = t.fake.dispatched[0]!.runId;
		t.fake.statuses.set(runId, { state: "unknown" });
		card.activeRun = { kind: "worker", runId, startedAt: Date.now() };
		await drive(t.host);
		expect(card.phase).toBe("implementing");
	});

	test("a lost worker run salvages when the lane carries the finished work (pause + /tmp cleanup)", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		const runId = t.fake.dispatched[0]!.runId;
		// Simulate: worker finished and committed in its lane while the program
		// was paused; its async record in /tmp was cleaned before resume.
		t.fake.statuses.delete(runId); // status() now reports not_found
		t.git.changedFilesResult = ["src/feature.ts"];
		t.fake.files.set(programCardPath("01"), makeCardText({ id: "01", evidence: "$ bun test\n3 pass", state: "review" }));
		await drive(t.host);
		expect(card.phase).toBe("reviewing");
		expect(t.fake.progress.some((line) => line.includes("run record lost"))).toBe(true);
		expect(t.fake.dispatched.some((entry) => entry.request.kind === "reviewer")).toBe(true);
	});

	test("a lost worker run with no lane commits blocks as before", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		const runId = t.fake.dispatched[0]!.runId;
		t.fake.statuses.delete(runId);
		await drive(t.host);
		expect(card.phase).toBe("blocked");
		expect(card.lastError).toContain("not_found");
	});
});

describe("unblock semantics", () => {
	test("abandon removes the card from the merge queue", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await prepareQueuedCard(t);
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		// Clear the foreign change that held the queue: the lane must be clean
		// for a deliberate abandon (dirty lanes are refused, never discarded).
		t.git.statusOutput = "";
		const result = await applyUnblock(t.host, "01", "abandon");
		expect(result.ok).toBe(true);
		expect(t.ledger.mergeQueue).not.toContain("01");
		expect(card.abandoned).toBe(true);
		expect(card.lane).toBeUndefined();
	});

	test("abandon refuses while a live card depends on it", async () => {
		const t = createTestHost({ cards: [{ id: "01" }, { id: "02", depends: ["01"] }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		const result = await applyUnblock(t.host, "01", "abandon");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("still a dependency of 02");
		expect(card.abandoned).not.toBe(true);
	});

	test("abandon refuses a dirty lane instead of discarding work", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		t.git.statusOutput = " M src/wip.ts";
		const result = await applyUnblock(t.host, "01", "abandon");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("uncommitted work");
	});

	test("redispatching an abandoned card re-adopts its scope", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		card.abandoned = true;
		const result = await applyUnblock(t.host, "01", "redispatch");
		expect(result.ok).toBe(true);
		expect(card.abandoned).toBe(false);
	});

	test("done without a completed review is refused", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		const result = await applyUnblock(t.host, "01", "done");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("no completed review");
	});

	test("manual merge finalization writes done and commits the records", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await prepareQueuedCard(t);
		const card = t.ledger.cards["01"]!;
		card.phase = "merging";
		t.git.statusOutput = "";
		await finishManualMerge(t.host, card);
		expect(String(card.phase)).toBe("done");
		const text = t.fake.files.get(programCardPath("01")) ?? "";
		expect(text).toContain("State: done");
		expect(text).toContain("recorded manually");
		expect(t.git.commits.some((message) => message.includes("card 01 done"))).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyTriage, applyUnblock, drive, finishManualMerge } from "../src/engine/driver.ts";
import { createTestHost, makeCardText } from "./helpers.ts";

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
		expect(t.fake.progress.some((line) => line.includes("dispatch retry succeeded"))).toBe(true);
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
		expect(t.fake.progress.some((line) => line.includes("complete (no program gate configured)"))).toBe(true);
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
});

describe("unblock semantics", () => {
	test("abandon removes the card from the merge queue", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await prepareQueuedCard(t);
		const card = t.ledger.cards["01"]!;
		card.phase = "blocked";
		const result = await applyUnblock(t.host, "01", "abandon");
		expect(result.ok).toBe(true);
		expect(t.ledger.mergeQueue).not.toContain("01");
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

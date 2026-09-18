import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyTriage, drive } from "../src/engine/driver.ts";
import { usageFromSessionFile, usageFromStatus } from "../src/platform/runs.ts";
import { createTestHost, makeCardText } from "./helpers.ts";

const PROGRAM_DIR = "/repo/.agents/work-programs/test-program";

function programCardPath(cardId: string): string {
	return join(PROGRAM_DIR, `tasks/${cardId}-card.md`);
}

function writeLaneEvidence(host: ReturnType<typeof createTestHost>, cardId: string, evidence: string): void {
	host.fake.files.set(programCardPath(cardId), makeCardText({ id: cardId, evidence, state: "review" }));
}

describe("usageFromSessionFile", () => {
	function writeTranscript(lines: unknown[]): string {
		const dir = mkdtempSync(join(tmpdir(), "wp-usage-"));
		const file = join(dir, "session.jsonl");
		writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
		return file;
	}

	test("sums assistant message usage across the whole transcript", () => {
		const file = writeTranscript([
			{ type: "session", id: "s1" },
			{ type: "message", message: { role: "user", content: "go" } },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1_000, output: 100, cacheRead: 9_000, cacheWrite: 0, cost: { total: 0.01 } },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 2_000, output: 200, cacheRead: 18_000, cacheWrite: 500, cost: { total: 0.02 } },
				},
			},
			{ type: "compaction", summary: "x", tokensBefore: 999 },
		]);
		const usage = usageFromSessionFile(file);
		expect(usage?.input).toBe(3_000);
		expect(usage?.output).toBe(300);
		expect(usage?.cacheRead).toBe(27_000);
		expect(usage?.cacheWrite).toBe(500);
		expect(usage?.total).toBe(30_800);
		expect(usage?.turns).toBe(2);
		expect(usage?.costUsd).toBeCloseTo(0.03);
	});

	test("returns undefined for a missing file or a transcript without usage", () => {
		expect(usageFromSessionFile("/nope/missing.jsonl")).toBeUndefined();
		const file = writeTranscript([{ type: "message", message: { role: "user", content: "hi" } }]);
		expect(usageFromSessionFile(file)).toBeUndefined();
	});
});

describe("usageFromStatus", () => {
	test("reads the pi-subagents status.json shape", () => {
		const usage = usageFromStatus({
			totalTokens: { input: 51_749, output: 43_085, total: 94_834, window: 91_300, windowPeak: 91_300 },
			totalCost: { inputTokens: 51_749, outputTokens: 43_085, costUsd: 0.078 },
			turnCount: 36,
			toolCount: 51,
		});
		expect(usage).toEqual({
			input: 51_749,
			output: 43_085,
			total: 94_834,
			windowPeak: 91_300,
			costUsd: 0.078,
			turns: 36,
			tools: 51,
		});
	});

	test("returns undefined when the run recorded nothing", () => {
		expect(usageFromStatus({})).toBeUndefined();
		expect(usageFromStatus({ totalTokens: { input: 0, output: 0, total: 0 } })).toBeUndefined();
	});

	test("tolerates partial data (cost-only reporters)", () => {
		const usage = usageFromStatus({ totalCost: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } });
		expect(usage?.input).toBe(100);
		expect(usage?.total).toBe(120);
	});
});

describe("run usage telemetry", () => {
	test("a card aggregates usage across its runs and records it in harness evidence", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		const workerRun = t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId;
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(workerRun, {
			output: "implemented",
			usage: { input: 100_000, output: 5_000, total: 1_200_000, windowPeak: 180_000, turns: 40, tools: 30, costUsd: 0.2 },
		});
		await drive(t.host);

		const card = t.ledger.cards["01"]!;
		expect(card.usage?.total).toBe(1_200_000);
		expect(card.usageRuns).toHaveLength(1);
		expect(card.usageRuns?.[0]?.kind).toBe("worker");

		const reviewRun = t.fake.dispatched.find((entry) => entry.request.kind === "reviewer")!.runId;
		t.completeRun(reviewRun, {
			output: "clean",
			usage: { input: 50_000, output: 2_000, total: 300_000, windowPeak: 90_000, turns: 12, tools: 20, costUsd: 0.05 },
		});
		await drive(t.host);
		const applied = applyTriage(t.host, "01", []);
		expect(applied.ok).toBe(true);
		await drive(t.host);

		expect(card.phase).toBe("done");
		expect(card.usage?.total).toBe(1_500_000);
		expect(card.usage?.turns).toBe(52);
		expect(card.usage?.windowPeak).toBe(180_000);
		expect(card.usage?.costUsd).toBeCloseTo(0.25);
		expect(card.usageRuns).toHaveLength(2);

		const text = t.fake.files.get(programCardPath("01")) ?? "";
		expect(text).toContain("usage: 1.5M tok · 52 turns · $0.25 (2 runs)");
	});

	test("runs without usage data simply record nothing", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		writeLaneEvidence(t, "01", "$ bun test\n3 pass");
		t.completeRun(t.fake.dispatched.find((entry) => entry.request.kind === "worker")!.runId, { output: "implemented" });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.usage).toBeUndefined();
		expect(t.ledger.cards["01"]?.phase).toBe("reviewing");
	});
});

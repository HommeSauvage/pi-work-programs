import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROGRESS_MAX_LINE_CHARS,
	PROGRESS_MAX_LINES,
	appendProgress,
	boundProgress,
	renderProgressScaffold,
} from "../src/program/create.ts";

function scaffold(): string {
	return renderProgressScaffold({
		slug: "test",
		date: "2026-01-01",
		mode: "managed",
		maxParallel: 2,
		parallelExecution: "worktrees",
	});
}

describe("appendProgress (progress.md generating)", () => {
	test("one event = one terse line under today's UTC section", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-progress-"));
		try {
			await appendProgress(dir, "01 dispatched (managed)");
			await appendProgress(dir, "01   merged   (abc1234)");
			const text = await readFile(join(dir, "progress.md"), "utf8");
			const today = new Date().toISOString().slice(0, 10);
			expect(text).toContain(`## ${today}`);
			expect(text).toContain("- 01 dispatched (managed)");
			// Whitespace is collapsed; no duplicate day header for same-day appends.
			expect(text.match(/## /g)).toHaveLength(1);
			expect(text).toContain("- 01 merged (abc1234)");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an old file gains a new day section instead of appending to the stale one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-progress-"));
		try {
			await appendProgress(dir, "01 dispatched");
			const path = join(dir, "progress.md");
			const stale = (await readFile(path, "utf8")).replace(/## \d{4}-\d{2}-\d{2}/, "## 2020-01-01");
			await import("node:fs/promises").then((fs) => fs.writeFile(path, stale, "utf8"));
			await appendProgress(dir, "01 merged");
			const text = await readFile(path, "utf8");
			const today = new Date().toISOString().slice(0, 10);
			expect(text).toContain("## 2020-01-01");
			expect(text).toContain(`## ${today}`);
			const lines = text.split("\n");
			expect(lines.indexOf("- 01 merged")).toBeGreaterThan(lines.indexOf("## 2020-01-01"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("model noise is capped per line: a wall of error text becomes one bounded line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-progress-"));
		try {
			const verbose = `01 blocked: worker failed — ${"GoUsageLimitError: capacity exhausted. ".repeat(30)}`;
			await appendProgress(dir, verbose);
			const text = await readFile(join(dir, "progress.md"), "utf8");
			const event = text.split("\n").find((line) => line.startsWith("- 01 blocked"));
			expect(event!.length).toBeLessThanOrEqual(PROGRESS_MAX_LINE_CHARS + 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("empty lines are dropped, never recorded", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-progress-"));
		try {
			await appendProgress(dir, "01 done (abc1234)");
			await appendProgress(dir, "   ");
			const text = await readFile(join(dir, "progress.md"), "utf8");
			expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("boundProgress", () => {
	// The scaffold itself carries one event line (`- program created …`).
	

	test("keeps the newest events and folds the dropped count into one marker", () => {
		const events = Array.from({ length: PROGRESS_MAX_LINES + 10 }, (_, index) => `- event ${index + 1}`);
		const text = `${scaffold()}${events.join("\n")}\n`;
		const bounded = boundProgress(text);
		const live = bounded.split("\n").filter((line) => line.startsWith("- event"));
		expect(live).toHaveLength(PROGRESS_MAX_LINES);
		const dropped = 11;
		expect(live[0]).toBe(`- event ${dropped}`);
		expect(live[live.length - 1]).toBe(`- event ${PROGRESS_MAX_LINES + 10}`);
		expect(bounded).toContain(`- … ${dropped} earlier events trimmed (git history)`);
		// The dated header survives the trim.
		expect(bounded).toContain("## 2026-01-01");
	});

	test("an existing marker folds into the next trim (the count stays cumulative)", () => {
		const first = `${scaffold()}${Array.from({ length: PROGRESS_MAX_LINES + 5 }, (_, index) => `- event ${index + 1}`).join("\n")}\n`;
		let bounded = boundProgress(first);
		expect(bounded).toContain("6 earlier events trimmed");
		const grown = `${bounded}${Array.from({ length: 10 }, (_, index) => `- more ${index + 1}`).join("\n")}\n`;
		bounded = boundProgress(grown);
		expect(bounded).toContain("16 earlier events trimmed");
		// Never two markers.
		expect(bounded.match(/earlier events trimmed/g)).toHaveLength(1);
	});

	test("an under-cap file is normalized but not trimmed", () => {
		const text = `${scaffold()}- 01 done (abc1234)\n`;
		const bounded = boundProgress(text);
		expect(bounded).toContain("- program created");
		expect(bounded).toContain("- 01 done (abc1234)");
		expect(bounded).not.toContain("earlier events trimmed");
	});

	test("hand-written lines inside a section are preserved, not silently dropped", () => {
		const text = `${scaffold()}- 01 done (abc1234)\noperator note: kept\n`;
		const bounded = boundProgress(text);
		expect(bounded).toContain("operator note: kept");
	});
});

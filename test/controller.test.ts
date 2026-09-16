import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { WorkProgramController } from "../src/engine/controller.ts";
import { makeCardText } from "./helpers.ts";
import { FakePi, fakeSessionContext, installRpcResponder, type StubUi } from "./fakes.ts";

const tempDirs: string[] = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_AGENT_DIR;
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = previousAgentDir;
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function recordingUi(): { ui: StubUi; calls: Array<{ method: string; key?: string; value?: unknown }> } {
	const calls: Array<{ method: string; key?: string; value?: unknown }> = [];
	const ui: StubUi = {
		notify: () => {},
		setStatus: (key, value) => {
			calls.push({ method: "setStatus", key, value });
		},
		setWidget: (key, value) => {
			calls.push({ method: "setWidget", key, value });
		},
		theme: { fg: (_color: string, text: string) => text },
	};
	return { ui, calls };
}

async function setupProgram(
	ui?: StubUi,
	options: { idle?: boolean } = {},
): Promise<{ controller: WorkProgramController; cwd: string; pi: FakePi }> {
	const root = await mkdtemp(join(tmpdir(), "wp-controller-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), "{}", "utf8");
	process.env.PI_AGENT_DIR = agentDir;
	const cwd = join(root, "repo");
	const programDir = join(cwd, ".agents", "work-programs", "test-program");
	await mkdir(join(programDir, "tasks"), { recursive: true });
	await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	await writeFile(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{}", "utf8");
	const plan = [
		"# Work program — test",
		"",
		"| # | card | phase | depends on |",
		"| --- | --- | --- | --- |",
		"| 01 | `tasks/01-card.md` — card | 1 | — |",
	].join("\n");
	await writeFile(join(programDir, "plan.md"), plan, "utf8");
	await writeFile(join(programDir, "progress.md"), "# progress\n", "utf8");
	await writeFile(join(programDir, "tasks", "01-card.md"), makeCardText({ id: "01" }), "utf8");

	const pi = new FakePi();
	installRpcResponder(pi);
	const controller = new WorkProgramController(pi.asExtensionApi());
	await controller.initialize(fakeSessionContext({ cwd, ...(ui ? { ui } : {}), ...(options.idle !== undefined ? { idle: options.idle } : {}) }));
	const started = await controller.startProgram("test-program");
	expect(started.ok).toBe(true);
	return { controller, cwd, pi };
}

describe("controller guards", () => {
	test("finalize_plan refuses while a card owns a lane or run", async () => {
		const { controller } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.lane = { path: "/tmp/lane", branch: "b", base: "abc" };
		const result = await controller.finalizePlan();
		expect(result.ok).toBe(false);
		expect(result.text).toContain("lane");
	});

	test("finalize_plan stages without starting execution", async () => {
		const { controller } = await setupProgram();
		const result = await controller.finalizePlan();
		expect(result.ok).toBe(true);
		expect(controller.getActive()!.ledger.status).toBe("paused");
		expect(result.text).toContain("NOT started");
		expect(result.text).toContain("resume");
	});

	test("merge_resolved refuses a card that is not merging", async () => {
		const { controller } = await setupProgram();
		const result = await controller.mergeResolved("01");
		expect(result.ok).toBe(false);
		expect(result.text).toContain("merge_resolved only applies");
	});

	test("pause keeps in-flight run tracking", async () => {
		const { controller } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.activeRun = { kind: "worker", runId: "run-1", startedAt: Date.now() };
		await controller.pause();
		expect(card.activeRun?.runId).toBe("run-1");
		expect(controller.getActive()!.ledger.status).toBe("paused");
	});

	test("sync preserves a runtime mode change when the plan has no override", async () => {
		const { controller } = await setupProgram();
		const changed = await controller.setMode("session");
		expect(changed.ok).toBe(true);
		const synced = await controller.syncFromDisk();
		expect(synced.ok).toBe(true);
		expect(controller.getActive()!.ledger.mode).toBe("session");
	});

	test("unblock refuses a card that is not blocked", async () => {
		const { controller } = await setupProgram();
		const result = await controller.unblock("01", "done");
		expect(result.ok).toBe(false);
		expect(result.text).toContain("only a blocked card");
	});
});

describe("operator todos", () => {
	test("activating a program creates the todo file with the verbatim header", async () => {
		const { controller, cwd } = await setupProgram();
		const { readFile } = await import("node:fs/promises");
		const text = await readFile(join(cwd, ".operator", "todo.md"), "utf8");
		expect(text.startsWith("# Operator todo\n")).toBe(true);
		expect(text).toContain("NEVER delete or rewrite existing content");
		expect(controller.getActive()?.slug).toBe("test-program");
	});

	test("status lists the program stream's open todos", async () => {
		const { controller, cwd } = await setupProgram();
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(cwd, ".operator"), { recursive: true });
		await writeFile(
			join(cwd, ".operator", "todo.md"),
			[
				"# Operator todo",
				"",
				"## test-program",
				"### [ ] Rotate the prod key - test-program - 01",
					"Rotate the production API key; the agent has no vault access.",
					"1. Run `vault rotate prod`.",
				"### [x] Already done",
				"",
				"## other",
				"### [ ] Not ours",
				"",
			].join("\n"),
			"utf8",
		);
		// The markdown inbox is imported on sync: the live card's item blocks it.
		const synced = await controller.syncFromDisk();
		expect(synced.ok).toBe(true);
		const ledger = controller.getActive()!.ledger;
		expect(ledger.cards["01"]?.phase).toBe("blocked");
		expect(ledger.cards["01"]?.waitingOn).toEqual(["op-01"]);
		const text = await controller.statusText();
		expect(text).toContain("Operator todos (test-program): 1 open, 1 blocking");
		expect(text).toContain("Rotate the prod key");
		expect(text).toContain("op-01 BLOCKS card 01");
		expect(text).not.toContain("Not ours");
		const doctor = await controller.doctor();
		expect(doctor).toContain("operator todos (test-program): 1 open, 1 blocking");
	});
});

describe("soft and hard pause", () => {
	test("soft pause leaves in-flight runs alone and records it", async () => {
		const { controller, cwd } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.phase = "implementing";
		card.activeRun = { kind: "worker", runId: "run-1", startedAt: Date.now() };
		const result = await controller.pause();
		expect(result.ok).toBe(true);
		expect(result.text).toContain("(soft)");
		expect(card.activeRun?.runId).toBe("run-1");
		expect(card.phase).toBe("implementing");
		expect(controller.getActive()!.ledger.status).toBe("paused");
		const { readFile } = await import("node:fs/promises");
		const progress = await readFile(join(cwd, ".agents", "work-programs", "test-program", "progress.md"), "utf8");
		expect(progress).toContain("paused (soft)");
		expect(progress).toContain("01 worker");
	});

	test("hard pause stops runs and rearms their cards", async () => {
		const { controller, cwd } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.phase = "implementing";
		card.activeRun = { kind: "worker", runId: "run-9", startedAt: Date.now() };
		const result = await controller.pause(true);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("(hard)");
		expect(card.activeRun).toBeUndefined();
		expect(card.phase as string).toBe("pending");
		const { readFile } = await import("node:fs/promises");
		const progress = await readFile(join(cwd, ".agents", "work-programs", "test-program", "progress.md"), "utf8");
		expect(progress).toContain("paused (hard)");
		expect(progress).toContain("stopped 1 run(s) (01 worker)");
		expect(progress).toContain("01 implementing→pending");
	});

	test("hard pause leaves runs it cannot stop untouched", async () => {
		const { controller, cwd } = await setupProgram();
		Object.assign(controller.runs, {
			stop: async () => {
				throw new Error("runner gone");
			},
		});
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.phase = "fixing";
		card.fixReason = "review";
		card.activeRun = { kind: "fix", runId: "run-9", startedAt: Date.now() };
		const result = await controller.pause(true);
		expect(result.ok).toBe(true);
		expect(card.activeRun?.runId).toBe("run-9");
		expect(card.phase).toBe("fixing");
		const { readFile } = await import("node:fs/promises");
		const progress = await readFile(join(cwd, ".agents", "work-programs", "test-program", "progress.md"), "utf8");
		expect(progress).toContain("could not stop");
	});

	test("resume rearms stranded cards and logs it", async () => {
		const { controller, cwd } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.phase = "reviewing";
		const result = await controller.resume();
		expect(result.ok).toBe(true);
		expect(controller.getActive()!.ledger.status).toBe("active");
		const { readFile } = await import("node:fs/promises");
		const progress = await readFile(join(cwd, ".agents", "work-programs", "test-program", "progress.md"), "utf8");
		expect(progress).toContain("resumed by operator");
		expect(progress).toContain("01 reviewing→review_pending");
	});
});

describe("session idle detection", () => {
	test("reports idle when pi is not processing a run", async () => {
		const { controller } = await setupProgram(undefined, { idle: true });
		expect(controller.sessionIdle()).toBe(true);
	});

	test("reports busy while pi is processing a run", async () => {
		const { controller } = await setupProgram(undefined, { idle: false });
		expect(controller.sessionIdle()).toBe(false);
	});

	test("treats a pi build without the idle helper as idle", async () => {
		const { controller, cwd } = await setupProgram();
		// Strip the helper to emulate an older pi, then re-initialize.
		const ctx = fakeSessionContext({ cwd });
		delete (ctx as { isIdle?: unknown }).isIdle;
		await controller.initialize(ctx);
		expect(controller.sessionIdle()).toBe(true);
	});
});

describe("runtime config", () => {
	test("lowers maxCycles, records it, and persists it into plan.md", async () => {
		const { controller, cwd } = await setupProgram();
		const result = await controller.setConfig({ maxCycles: 1 });
		expect(result.ok).toBe(true);
		expect(result.text).toContain("maxCycles 3→1");
		const ledger = controller.getActive()!.ledger;
		expect(ledger.maxCycles).toBe(1);
		const { readFile } = await import("node:fs/promises");
		const plan = await readFile(join(cwd, ".agents", "work-programs", "test-program", "plan.md"), "utf8");
		expect(plan).toContain("maxCycles: 1");
		expect(plan.startsWith("---")).toBe(true);
		const progress = await readFile(join(cwd, ".agents", "work-programs", "test-program", "progress.md"), "utf8");
		expect(progress).toContain("config updated — maxCycles 3→1");
	});

	test("the change survives a sync from disk", async () => {
		const { controller } = await setupProgram();
		await controller.setConfig({ maxCycles: 1, reviewProfile: "enhanced" });
		const synced = await controller.syncFromDisk();
		expect(synced.ok).toBe(true);
		const ledger = controller.getActive()!.ledger;
		expect(ledger.maxCycles).toBe(1);
		expect(ledger.reviewProfile).toBe("enhanced");
	});

	test("onExhausted accept resolves an open cycle decision in bulk", async () => {
		const { controller } = await setupProgram();
		const ledger = controller.getActive()!.ledger;
		const card = ledger.cards["01"]!;
		card.phase = "triaging";
		card.cycles = 3;
		const { createDecision } = await import("../src/engine/decisions.ts");
		createDecision(
			{ programDir: "/prog", ledger },
			{
				kind: "cycle-exhausted",
				card: "01",
				message: "Card 01 has used all 2 review cycles and findings are still open.",
				expectedAction: 'work_program({ action: "cycle_decision", card: "01", choice: "accept" | "block" })',
			},
		);
		const result = await controller.setConfig({ onExhausted: "accept" });
		expect(result.ok).toBe(true);
		expect(result.text).toContain("Accepted 1 open cycle decision(s)");
		expect(ledger.onExhausted).toBe("accept");
		expect(ledger.decisions.find((entry) => entry.kind === "cycle-exhausted")?.status).toBe("resolved");
		expect(card.phase as string).toBe("approved");
	});

	test("rejects nonsense and unrelated keys", async () => {
		const { controller } = await setupProgram();
		expect((await controller.setConfig({ maxCycles: 99 })).ok).toBe(false);
		expect((await controller.setConfig({ reviewProfile: "deep" as never })).ok).toBe(false);
		expect((await controller.setConfig({})).ok).toBe(false);
	});

	test("mode is refused while a run is in flight, other knobs still apply", async () => {
		const { controller } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.activeRun = { kind: "worker", runId: "run-1", startedAt: Date.now() };
		const blocked = await controller.setConfig({ mode: "captain" });
		expect(blocked.ok).toBe(false);
		expect(blocked.text).toContain("in flight");
		const applied = await controller.setConfig({ maxParallel: 1 });
		expect(applied.ok).toBe(true);
		expect(controller.getActive()!.ledger.maxParallel).toBe(1);
	});
});

describe("card-scoped config", () => {
	test("sets a card's maxCycles and review profile into ledger + front matter", async () => {
		const { controller, cwd } = await setupProgram();
		const result = await controller.setConfig({ card: "01", maxCycles: 5, reviewProfile: "enhanced" });
		expect(result.ok).toBe(true);
		expect(result.text).toContain("card 01 maxCycles");
		const ledger = controller.getActive()!.ledger;
		expect(ledger.cards["01"]?.maxCycles).toBe(5);
		expect(ledger.cards["01"]?.reviewProfile).toBe("enhanced");
		// Program defaults are untouched.
		expect(ledger.maxCycles).toBe(3);
		const { readFile } = await import("node:fs/promises");
		const cardText = await readFile(join(cwd, ".agents", "work-programs", "test-program", "tasks", "01-card.md"), "utf8");
		expect(cardText.startsWith("---")).toBe(true);
		expect(cardText).toContain("maxCycles: 5");
		expect(cardText).toContain("review: enhanced");
		expect(cardText).toContain("## State: todo");
	});

	test("the card change survives a sync from disk", async () => {
		const { controller } = await setupProgram();
		await controller.setConfig({ card: "01", maxCycles: 1 });
		const synced = await controller.syncFromDisk();
		expect(synced.ok).toBe(true);
		expect(controller.getActive()!.ledger.cards["01"]?.maxCycles).toBe(1);
	});

	test("an empty-string model clears the card override", async () => {
		const { controller, cwd } = await setupProgram();
		await controller.setConfig({ card: "01", workerModel: "custom/model" });
		expect(controller.getActive()!.ledger.cards["01"]?.workerModel).toBe("custom/model");
		const cleared = await controller.setConfig({ card: "01", workerModel: "" });
		expect(cleared.ok).toBe(true);
		expect(controller.getActive()!.ledger.cards["01"]?.workerModel).toBeUndefined();
		const { readFile } = await import("node:fs/promises");
		const cardText = await readFile(join(cwd, ".agents", "work-programs", "test-program", "tasks", "01-card.md"), "utf8");
		expect(cardText).not.toContain("workerModel");
	});

	test("program-only knobs are refused with card set, unknown cards fail", async () => {
		const { controller } = await setupProgram();
		expect((await controller.setConfig({ card: "01", mode: "captain" as never })).ok).toBe(false);
		expect((await controller.setConfig({ card: "99", maxCycles: 2 })).ok).toBe(false);
		expect((await controller.setConfig({ card: "01", reviewProfile: "deep" as never })).ok).toBe(false);
		expect((await controller.setConfig({ card: "01" })).ok).toBe(false);
	});
});

describe("cycle cap without one_more", () => {
	test("maxCycles defaults to 3", async () => {
		const { controller } = await setupProgram();
		expect(controller.getActive()?.ledger.maxCycles).toBe(3);
	});

	test("accept lands the card and records the unfixed findings in the card", async () => {
		const { controller, cwd } = await setupProgram();
		const ledger = controller.getActive()!.ledger;
		const card = ledger.cards["01"]!;
		card.phase = "triaging";
		card.cycles = 2;
		const { createDecision, resolveDecision } = await import("../src/engine/decisions.ts");
		const triage = createDecision(
			{ programDir: "/prog", ledger },
			{
				kind: "review-triage",
				card: "01",
				message: "Card 01 review 2 (light) is ready for triage.",
				expectedAction: 'work_program({ action: "triage", card: "01", verdicts: [] })',
			},
		);
		resolveDecision({ programDir: "/prog", ledger }, triage.id, {
			verdicts: [
				{ finding: "P1 — accepted debt: reversible address hash", verdict: "approve" },
				{ finding: "P2 — nits", verdict: "reject" },
			],
		});
		const cycle = createDecision(
			{ programDir: "/prog", ledger },
			{
				kind: "cycle-exhausted",
				card: "01",
				summary: "1 approved finding(s) remain",
				message: "Card 01 has used all 2 review cycles and findings are still open.",
				expectedAction: 'work_program({ action: "cycle_decision", card: "01", choice: "accept" | "block" })',
			},
		);
		expect(cycle.kind).toBe("cycle-exhausted");

		const result = await controller.cycleDecision("01", "accept");
		expect(result.ok).toBe(true);
		expect(card.acceptedFindings).toEqual(["P1 — accepted debt: reversible address hash"]);
		const { readFile } = await import("node:fs/promises");
		const cardText = await readFile(
			join(cwd, ".agents", "work-programs", "test-program", "tasks", "01-card.md"),
			"utf8",
		);
		expect(cardText).toContain("## Accepted findings (approved at the review-cycle cap, carried unfixed)");
		expect(cardText).toContain("reversible address hash");
		expect(cardText).not.toContain("nits");
		const progress = await readFile(join(cwd, ".agents", "work-programs", "test-program", "progress.md"), "utf8");
		expect(progress).toContain("cycle decision: accept — 1 approved finding(s) carried unfixed");
	});

	test("block still parks the card", async () => {
		const { controller } = await setupProgram();
		const ledger = controller.getActive()!.ledger;
		const card = ledger.cards["01"]!;
		card.phase = "triaging";
		card.cycles = 2;
		const { createDecision } = await import("../src/engine/decisions.ts");
		createDecision(
			{ programDir: "/prog", ledger },
			{
				kind: "cycle-exhausted",
				card: "01",
				message: "Card 01 has used all 2 review cycles and findings are still open.",
				expectedAction: 'work_program({ action: "cycle_decision", card: "01", choice: "accept" | "block" })',
			},
		);
		const result = await controller.cycleDecision("01", "block");
		expect(result.ok).toBe(true);
		expect(card.phase as string).toBe("blocked");
		expect(card.acceptedFindings).toBeUndefined();
	});
});

describe("completion and close-out", () => {
	test("close refuses while any card is pending — even with remove", async () => {
		const { controller } = await setupProgram();
		const kept = await controller.closeProgram(false);
		expect(kept.ok).toBe(false);
		expect(kept.text).toContain("not done");
		const removed = await controller.closeProgram(true);
		expect(removed.ok).toBe(false);
		expect(removed.text).toContain("not done");
		// Records are untouched and the program is still active.
		expect(controller.getActive()?.slug).toBe("test-program");
	});

	test("close keeps the folder by default and deletes it with remove", async () => {
		const { controller, cwd } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.phase = "done";
		const kept = await controller.closeProgram(false);
		expect(kept.ok).toBe(true);
		expect(controller.getActive()?.slug).toBe("test-program");
		const programDir = join(cwd, ".agents", "work-programs", "test-program");
		const { stat } = await import("node:fs/promises");
		await stat(join(programDir, "plan.md"));
		const removed = await controller.closeProgram(true);
		expect(removed.ok).toBe(true);
		expect(controller.getActive()).toBeUndefined();
		await expect(stat(programDir)).rejects.toThrow();
	});

	test("a completed program clears the work-program UI", async () => {
		const { ui, calls } = recordingUi();
		const { controller } = await setupProgram(ui);
		const ledger = controller.getActive()!.ledger;
		ledger.cards["01"]!.phase = "done";
		ledger.status = "complete";
		calls.length = 0;
		const closed = await controller.closeProgram(false);
		expect(closed.ok).toBe(true);
		const widgets = calls.filter((call) => call.method === "setWidget");
		const statuses = calls.filter((call) => call.method === "setStatus");
		expect(widgets.length).toBeGreaterThan(0);
		expect(statuses.length).toBeGreaterThan(0);
		expect(widgets.at(-1)).toEqual({ method: "setWidget", key: "work-program", value: undefined });
		expect(statuses.at(-1)).toEqual({ method: "setStatus", key: "work-program", value: undefined });
	});

	test("completed programs do not auto-activate in a new session", async () => {
		const { controller, cwd } = await setupProgram();
		const ledger = controller.getActive()!.ledger;
		ledger.cards["01"]!.phase = "done";
		ledger.status = "complete";
		const closed = await controller.closeProgram(false);
		expect(closed.ok).toBe(true);
		// A fresh controller on the same project leaves the completed program alone.
		const pi = new FakePi();
		installRpcResponder(pi);
		const next = new WorkProgramController(pi.asExtensionApi());
		await next.initialize(fakeSessionContext({ cwd }));
		expect(next.getActive()).toBeUndefined();
		next.shutdown();
	});
});

describe("status clarity", () => {
	test("status surfaces blocked cards with redispatch hints", async () => {
		const { controller } = await setupProgram();
		const card = controller.getActive()!.ledger.cards["01"]!;
		card.phase = "blocked";
		card.blockedFrom = "fixing";
		card.fixReason = "review";
		card.lastError = "fix run run-9 ended as failed: boom";
		const text = await controller.statusText();
		expect(text).toContain("Issues:");
		expect(text).toContain("fix run run-9 ended as failed");
		expect(text).toContain("redispatch retries the pending review");
	});

	test("status shows in-flight heartbeat and merge queue", async () => {
		const { controller } = await setupProgram();
		const ledger = controller.getActive()!.ledger;
		const card = ledger.cards["01"]!;
		card.phase = "implementing";
		card.activeRun = { kind: "worker", runId: "run-1", startedAt: Date.now() - 65_000 };
		ledger.mergeQueue.push("01");
		const text = await controller.statusText();
		expect(text).toContain("worker run-1");
		expect(text).toContain("Merge queue: 01");
	});

	test("doctor reports in-flight, merge, and blocked state", async () => {
		const { controller } = await setupProgram();
		const ledger = controller.getActive()!.ledger;
		const card = ledger.cards["01"]!;
		card.phase = "blocked";
		card.lastError = "worker dispatch failed: agent not found";
		ledger.mergeQueue.push("01");
		const text = await controller.doctor();
		expect(text).toContain("blocked cards: 1");
		expect(text).toContain("agent not found");
		expect(text).toContain("merge queue: 01");
	});
});

describe("operator todos", () => {
	test("todoAdd parks a live card and persists the store", async () => {
		const { controller, cwd } = await setupProgram();
		const result = await controller.todoAdd({
			title: "Fetch the prod secret",
			body: "The agent has no vault access.",
			steps: [{ text: "Run the rotation", command: "vault rotate prod" }],
			card: "01",
			blocking: true,
		});
		expect(result.ok).toBe(true);
		expect(result.text).toContain("op-01");
		const ledger = controller.getActive()!.ledger;
		expect(ledger.cards["01"]?.phase).toBe("blocked");
		expect(ledger.cards["01"]?.waitingOn).toEqual(["op-01"]);
		const { readFile } = await import("node:fs/promises");
		const store = JSON.parse(
			await readFile(join(cwd, ".operator", "todos.json"), "utf8"),
		) as { items: Array<{ id: string; title: string; blocking: boolean; announced: boolean }> };
		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toMatchObject({ id: "op-01", title: "Fetch the prod secret", blocking: true, announced: true });
		const text = await controller.statusText();
		expect(text).toContain("op-01 BLOCKS card 01");
	});

	test("todoAdd defaults to advisory without a card and validates", async () => {
		const { controller } = await setupProgram();
		const advisory = await controller.todoAdd({ title: "Nice polish" });
		expect(advisory.ok).toBe(true);
		expect(controller.getActive()!.ledger.cards["01"]?.phase).toBe("pending");
		expect((await controller.todoAdd({ title: "  " })).ok).toBe(false);
		expect((await controller.todoAdd({ title: "x", card: "99" })).ok).toBe(false);
		expect((await controller.todoAdd({ title: "x", blocking: true })).ok).toBe(false);
		expect((await controller.todoAdd({ title: "x", steps: "nope" as never })).ok).toBe(false);
	});

	test("todoUpdate rewrites a confusing todo and todoDone resumes the card", async () => {
		const { controller } = await setupProgram();
		await controller.todoAdd({ title: "Confusing blob", card: "01", blocking: true });
		const updated = await controller.todoUpdate({
			id: "op-01",
			title: "Fetch the prod secret",
			body: "Simple reason.",
			steps: [
				{ text: "Do step one", command: "vault read prod" },
				{ text: "Do step two" },
			],
		});
		expect(updated.ok).toBe(true);
		expect(updated.text).toContain("title");
		expect(updated.text).toContain("steps (2)");
		const listed = await controller.todoList();
		expect(listed.text).toContain("Fetch the prod secret");
		expect(listed.text).toContain("vault read prod");
		const done = await controller.todoDone({ id: "op-01", note: "in 1Password" });
		expect(done.ok).toBe(true);
		const card = controller.getActive()!.ledger.cards["01"]!;
		expect(card.phase).toBe("pending");
		expect(card.waitingOn).toBeUndefined();
		expect((await controller.todoDone({ id: "op-01" })).text).toContain("already done");
		expect((await controller.todoUpdate({ id: "op-99", title: "x" })).ok).toBe(false);
	});

	test("todoDrop releases the card without doing the work", async () => {
		const { controller } = await setupProgram();
		await controller.todoAdd({ title: "Blocked thing", card: "01", blocking: true });
		expect(controller.getActive()!.ledger.cards["01"]?.phase).toBe("blocked");
		const dropped = await controller.todoDrop({ id: "op-01", reason: "no longer needed" });
		expect(dropped.ok).toBe(true);
		expect(controller.getActive()!.ledger.cards["01"]?.phase).toBe("pending");
	});

	test("switching blocking off resumes; switching on parks", async () => {
		const { controller } = await setupProgram();
		await controller.todoAdd({ title: "Thing", card: "01", blocking: true });
		expect(controller.getActive()!.ledger.cards["01"]?.phase).toBe("blocked");
		await controller.todoUpdate({ id: "op-01", blocking: false });
		expect(controller.getActive()!.ledger.cards["01"]?.phase).toBe("pending");
		await controller.todoUpdate({ id: "op-01", blocking: true });
		expect(controller.getActive()!.ledger.cards["01"]?.phase).toBe("blocked");
	});
});

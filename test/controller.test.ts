import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { WorkProgramController } from "../src/engine/controller.ts";
import { makeCardText } from "./helpers.ts";
import { FakePi, fakeSessionContext, installRpcResponder } from "./fakes.ts";

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

async function setupProgram(): Promise<{ controller: WorkProgramController; cwd: string; pi: FakePi }> {
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
	await controller.initialize(fakeSessionContext({ cwd }));
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

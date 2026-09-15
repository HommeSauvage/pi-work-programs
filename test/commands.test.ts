import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { WorkProgramController } from "../src/engine/controller.ts";
import { registerCommands } from "../src/commands.ts";
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

async function setup(): Promise<{ controller: WorkProgramController; pi: FakePi }> {
	const root = await mkdtemp(join(tmpdir(), "wp-commands-"));
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
	registerCommands(pi.asExtensionApi(), controller);
	await controller.initialize(fakeSessionContext({ cwd }));
	return { controller, pi };
}

function commandCtx(): { ctx: unknown; notices: string[] } {
	const notices: string[] = [];
	return {
		ctx: {
			hasUI: false,
			ui: {
				notify: (message: string) => {
					notices.push(message);
				},
			},
		},
		notices,
	};
}

function handlerFor(pi: FakePi) {
	const command = pi.commands.find((entry) => entry.name === "work-program");
	if (!command) throw new Error("work-program command not registered");
	return command.handler;
}

describe("start/resume commands", () => {
	test("start wakes the agent so no manual nudge is needed", async () => {
		const { pi } = await setup();
		const { ctx } = commandCtx();
		await handlerFor(pi)("start test-program", ctx);
		const nudge = pi.messages.find((message) => message.content.includes("Continue execution now"));
		expect(nudge).toBeDefined();
		expect(nudge?.content).toContain("Started");
	});

	test("resume wakes the agent so no manual nudge is needed", async () => {
		const { controller, pi } = await setup();
		const { ctx } = commandCtx();
		await handlerFor(pi)("start test-program", ctx);
		pi.messages.length = 0;
		await controller.pause();
		await handlerFor(pi)("resume", ctx);
		const nudge = pi.messages.find((message) => message.content.includes("Continue execution now"));
		expect(nudge).toBeDefined();
		expect(nudge?.content).toContain("Resumed");
	});

	test("a failed start sends no wake-up", async () => {
		const { pi } = await setup();
		const { ctx, notices } = commandCtx();
		await handlerFor(pi)("start", ctx);
		expect(notices.some((notice) => notice.includes("Usage"))).toBe(true);
		expect(pi.messages).toHaveLength(0);
	});
});

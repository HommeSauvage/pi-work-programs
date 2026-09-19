import { describe, expect, test } from "bun:test";
import workProgramsExtension from "../src/index.ts";
import { FakePi, installRpcResponder } from "./fakes.ts";

/** The extension deliberately stays inert when PI_SUBAGENT_CHILD=1. A suite that
 *  runs inside a delegated child (work-program gates run from children) must clear
 *  it to exercise registration; the inert behaviour is covered by its own test. */
function withoutChildEnv<T>(run: () => T): T {
	const previous = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
}

describe("extension registration", () => {
	test("registers tools, command and hooks", () => {
		withoutChildEnv(() => {
			const pi = new FakePi();
			workProgramsExtension(pi.asExtensionApi());
			expect(pi.tools.map((tool) => tool.name).sort()).toEqual(["suggest_work_program", "work_program"]);
			expect(pi.commands.map((command) => command.name)).toEqual(["work-program"]);
			expect([...pi.hooks.keys()].sort()).toEqual(["context", "session_shutdown", "session_start", "tool_call"]);
			expect(pi.events.listenerCount("subagents:rpc:v1:ready")).toBe(2);
			expect(pi.events.listenerCount("subagent:async-complete")).toBe(2);
			expect(pi.events.listenerCount("intercom:extension-registry-ready")).toBe(1);
		});
	});

	test("stays inert inside subagent children", () => {
		const previous = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_SUBAGENT_CHILD = "1";
		try {
			const pi = new FakePi();
			workProgramsExtension(pi.asExtensionApi());
			expect(pi.tools).toHaveLength(0);
			expect(pi.commands).toHaveLength(0);
			expect(pi.hooks.size).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previous;
		}
	});

	test("context hook injects nothing without an active program", async () => {
		const pi = new FakePi();
		withoutChildEnv(() => workProgramsExtension(pi.asExtensionApi()));
		const handler = pi.hooks.get("context")?.[0];
		expect(handler).toBeDefined();
		const result = await handler!({ messages: [] }, {});
		expect(result).toBeUndefined();
	});

	test("tool_call hook allows progress.md edits when no program is active", async () => {
		const pi = new FakePi();
		withoutChildEnv(() => workProgramsExtension(pi.asExtensionApi()));
		const handler = pi.hooks.get("tool_call")?.[0];
		const result = await handler!({ toolName: "write", input: { path: "progress.md" } }, {});
		expect(result).toBeUndefined();
	});

	test("doctor reports dependency status", async () => {
		const pi = new FakePi();
		installRpcResponder(pi);
		withoutChildEnv(() => workProgramsExtension(pi.asExtensionApi()));
		const tool = pi.tools.find((entry) => entry.name === "work_program");
		expect(tool).toBeDefined();
		// Prime the RPC capability cache the same way a session_start would.
		pi.events.emit("subagents:rpc:v1:ready", {});
		const result = (await tool!.execute("t1", { action: "doctor" }, undefined, undefined, {})) as {
			content: Array<{ text: string }>;
		};
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("pi-subagents: ready");
		expect(text).toContain("pi-intercom: installed");
	});

	test("blocks work-program creation when tools are missing", async () => {
		const pi = new FakePi();
		pi.allTools = [];
		withoutChildEnv(() => workProgramsExtension(pi.asExtensionApi()));
		const tool = pi.tools.find((entry) => entry.name === "work_program");
		await expect(
			tool!.execute("t1", { action: "finalize_plan" }, undefined, undefined, {}),
		).rejects.toThrow(/blocked/);
	});
});

describe("dependency fallbacks", () => {
	test("a configured package source counts as intercom installed", async () => {
		const pi = new FakePi();
		pi.allTools = [{ name: "subagent" }];
		installRpcResponder(pi);
		withoutChildEnv(() => workProgramsExtension(pi.asExtensionApi()));
		pi.events.emit("subagents:rpc:v1:ready", {});
		const { DependencyProbe } = await import("../src/platform/deps.ts");
		const { SubagentsRpc } = await import("../src/platform/runs.ts");
		const runs = new SubagentsRpc(pi.asExtensionApi());
		runs.attach();
		const probe = new DependencyProbe(pi.asExtensionApi(), runs);
		const status = await probe.check({ intercomConfigured: true });
		expect(status.intercom.installed).toBe(true);
		expect(status.ok).toBe(true);
		runs.dispose();
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubagentsRpc } from "../src/platform/runs.ts";
import { FakePi, installRpcResponder } from "./fakes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("SubagentsRpc", () => {
	test("pings and exposes capabilities", async () => {
		const pi = new FakePi();
		installRpcResponder(pi);
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		rpc.attach();
		const capabilities = await rpc.ping();
		expect(capabilities?.version).toBe(1);
		expect(capabilities?.methods).toContain("spawn");
		expect(rpc.available()).toBe(true);
		rpc.dispose();
	});

	test("dispatches a detached run and captures the async dir", async () => {
		const pi = new FakePi();
		installRpcResponder(pi, { runId: "run-9", asyncDir: "/tmp/run-9" });
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		rpc.attach();
		const result = await rpc.dispatch({
			kind: "worker",
			agent: "worker",
			task: "do it",
			cwd: "/repo",
			label: "card 01",
		});
		expect(result.runId).toBe("run-9");
		expect(result.asyncDir).toBe("/tmp/run-9");
		rpc.dispose();
	});

	test("reads terminal state and output from run artifacts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-runs-"));
		tempDirs.push(dir);
		const asyncDir = join(dir, "async-subagent-runs", "r7");
		const resultsDir = join(dir, "async-subagent-results");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(asyncDir, { recursive: true });
		await mkdir(resultsDir, { recursive: true });
		await writeFile(
			join(asyncDir, "status.json"),
			JSON.stringify({ runId: "r7", state: "complete", steps: [{ status: "complete" }] }),
			"utf8",
		);
		await writeFile(
			join(resultsDir, "r7.json"),
			JSON.stringify({ runId: "r7", state: "complete", results: [{ output: "final answer" }] }),
			"utf8",
		);
		const pi = new FakePi();
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		const status = await rpc.status("r7", asyncDir);
		expect(status.state).toBe("complete");
		expect(status.output).toBe("final answer");
	});

	test("reports not_found when the run directory is gone", async () => {
		const pi = new FakePi();
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		const status = await rpc.status("missing", "/tmp/definitely-not-here-wp");
		expect(status.state).toBe("not_found");
	});

	test("running status is not terminal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-runs-"));
		tempDirs.push(dir);
		await mkdir(dir, { recursive: true });		await writeFile(join(dir, "status.json"), JSON.stringify({ runId: "r8", state: "running", steps: [] }), "utf8");
		const pi = new FakePi();
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		const status = await rpc.status("r8", dir);
		expect(status.state).toBe("running");
	});
});

describe("RunHeartbeat", () => {
	test("heartbeat reads liveness without disturbing the run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-hb-"));
		tempDirs.push(dir);
		const now = Date.now();
		await writeFile(
			join(dir, "status.json"),
			JSON.stringify({
				runId: "r9",
				state: "running",
				startedAt: now - 120_000,
				lastUpdate: now - 5_000,
				steps: [
					{ recentTools: ["read"], recentOutput: ["first"] },
					{ recentTools: ["read", "bash"], recentOutput: ["compiling", "bun test …"] },
				],
			}),
			"utf8",
		);
		const pi = new FakePi();
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		const hb = await rpc.heartbeat("r9", dir);
		expect(hb.state).toBe("running");
		expect(hb.steps).toBe(2);
		expect(hb.recentTools).toEqual(["read", "bash"]);
		expect(hb.tail).toContain("bun test");
		expect(hb.elapsedMs).toBeGreaterThan(100_000);
		expect(hb.lastUpdate).toBe(now - 5_000);
		// The sync snapshot variant reads the same artifacts.
		const snap = rpc.heartbeatSnapshot("r9", dir);
		expect(snap).toEqual(hb);
		rpc.dispose();
	});

	test("stop resolves when the runner acknowledges", async () => {
		const pi = new FakePi();
		installRpcResponder(pi);
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		rpc.attach();
		await rpc.stop("run-3");
		rpc.dispose();
	});

	test("heartbeat is unknown when artifacts are gone", async () => {
		const pi = new FakePi();
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		const hb = await rpc.heartbeat("missing", "/tmp/definitely-not-here-wp");
		expect(hb.state).toBe("unknown");
		expect(hb.tail).toBeUndefined();
		expect(rpc.heartbeatSnapshot("missing")).toEqual({ runId: "missing", state: "unknown" });
		rpc.dispose();
	});

	test("heartbeat tolerates a malformed status file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-hb-"));
		tempDirs.push(dir);
		await writeFile(join(dir, "status.json"), "{not json", "utf8");
		const pi = new FakePi();
		const rpc = new SubagentsRpc(pi.asExtensionApi());
		expect((await rpc.heartbeat("r10", dir)).state).toBe("unknown");
		rpc.dispose();
	});
});

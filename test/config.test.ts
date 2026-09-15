import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, applyOverrides, formatPlanConfig, normalizeSettings, parsePlanConfig } from "../src/config.ts";

describe("normalizeSettings", () => {
	test("applies partial overrides and keeps defaults", () => {
		const settings = normalizeSettings({
			mode: "captain",
			maxParallel: 5,
			review: { profile: "enhanced", maxCycles: 2 },
			gates: { card: ["bun test"], program: ["bun run check"] },
		});
		expect(settings.mode).toBe("captain");
		expect(settings.maxParallel).toBe(5);
		expect(settings.review.profile).toBe("enhanced");
		expect(settings.review.maxCycles).toBe(2);
		expect(settings.review.agent).toBe(DEFAULT_SETTINGS.review.agent);
		expect(settings.gates.card).toEqual(["bun test"]);
		expect(settings.gates.program).toEqual(["bun run check"]);
	});

	test("clamps parallelism and rejects invalid enums", () => {
		const settings = normalizeSettings({ mode: "nonsense", maxParallel: 0, parallelExecution: "magic" });
		expect(settings.mode).toBe(DEFAULT_SETTINGS.mode);
		expect(settings.maxParallel).toBe(1);
		expect(settings.parallelExecution).toBe(DEFAULT_SETTINGS.parallelExecution);
	});

	test("project overrides win over user settings", () => {
		const user = normalizeSettings({ mode: "session", maxParallel: 4 });
		const project = normalizeSettings({ mode: "captain" }, user);
		expect(project.mode).toBe("captain");
		expect(project.maxParallel).toBe(4);
	});
});

describe("plan config comment", () => {
	test("round-trips program overrides", () => {
		const comment = formatPlanConfig({
			mode: "managed",
			maxParallel: 3,
			parallelExecution: "direct",
			reviewProfile: "enhanced",
			maxCycles: 2,
			gates: { card: ["bun test"] },
		});
		const parsed = parsePlanConfig(`${comment}\n# Work program — x`);
		expect(parsed.mode).toBe("managed");
		expect(parsed.maxParallel).toBe(3);
		expect(parsed.parallelExecution).toBe("direct");
		expect((parsed.review as Record<string, unknown>).profile).toBe("enhanced");
		expect((parsed.review as Record<string, unknown>).maxCycles).toBe(2);
		expect((parsed.gates as Record<string, unknown>).card).toEqual(["bun test"]);
	});

	test("ignores malformed comments", () => {
		expect(parsePlanConfig("<!-- wp: {broken -->")).toEqual({});
		expect(parsePlanConfig("no comment")).toEqual({});
	});
});

describe("applyOverrides", () => {
	test("program overrides win over project settings", () => {
		const settings = applyOverrides(DEFAULT_SETTINGS, { mode: "captain", maxParallel: 6, maxCycles: 1 });
		expect(settings.mode).toBe("captain");
		expect(settings.maxParallel).toBe(6);
		expect(settings.review.maxCycles).toBe(1);
	});
});

import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPackageConfigured } from "../src/config.ts";

let agentDir: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_AGENT_DIR;
});

afterEach(async () => {
	if (agentDir) await rm(agentDir, { recursive: true, force: true });
	agentDir = undefined;
	if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = previousAgentDir;
});

test("isPackageConfigured matches npm, git and local package sources", async () => {
	agentDir = await mkdtemp(join(tmpdir(), "wp-config-"));
	process.env.PI_AGENT_DIR = agentDir;
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:pi-intercom@0.13.0", "git:github.com/x/pi-subagents@v1"] }),
		"utf8",
	);
	const cwd = await mkdtemp(join(tmpdir(), "wp-config-proj-"));
	try {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ packages: ["/Users/someone/Projects/pi-work-programs"] }),
			"utf8",
		);
		expect(await isPackageConfigured(cwd, ".pi", "pi-intercom")).toBe(true);
		expect(await isPackageConfigured(cwd, ".pi", "pi-subagents")).toBe(true);
		expect(await isPackageConfigured(cwd, ".pi", "pi-work-programs")).toBe(true);
		expect(await isPackageConfigured(cwd, ".pi", "pi-unrelated")).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

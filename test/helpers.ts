import { join } from "node:path";
import type { DriverHost } from "../src/engine/driver.ts";
import { buildLedger } from "../src/program/ledger.ts";
import { parseCard } from "../src/program/parse.ts";
import { DEFAULT_SETTINGS, applyOverrides } from "../src/config.ts";
import type {
	CardLedger,
	DispatchRequest,
	DispatchResult,
	DriverPorts,
	GateOps,
	GateResult,
	GitOps,
	ParsedCard,
	ProgramConfigOverrides,
	ProgramLedger,
	RunHeartbeat,
	RunOps,
	RunStatus,
	WorkProgramSettings,
} from "../src/shared/types.ts";

export class FakeGit implements GitOps {
	headSha = "base0";
	/** When true, commitPaths/commitAll record nothing (clean tree). */
	nothingStaged = false;
	statusOutput = "";
	mergeResult: { code: number; conflicted: string[]; output: string } = { code: 0, conflicted: [], output: "" };
	ancestor = true;
	unmerged: string[] = [];
	mergeInProgress = false;
	commits: string[] = [];
	removedWorktrees: string[] = [];
	deletedBranches: string[] = [];

	async statusPorcelain(): Promise<string> {
		return this.statusOutput;
	}
	async head(): Promise<string> {
		return this.headSha;
	}
	async currentBranch(): Promise<string> {
		return "feat/foo";
	}
	async worktreeAdd(): Promise<void> {}
	async worktreeRemove(_cwd: string, path: string): Promise<void> {
		this.removedWorktrees.push(path);
	}
	async branchDelete(_cwd: string, branch: string): Promise<void> {
		this.deletedBranches.push(branch);
	}
	async diffStat(): Promise<string> {
		return "";
	}
	async commitLog(): Promise<string> {
		return "";
	}
	async mergeNoCommit(): Promise<{ code: number; conflicted: string[]; output: string }> {
		return this.mergeResult;
	}
	async isAncestor(): Promise<boolean> {
		return this.ancestor;
	}
	async mergeAbort(): Promise<void> {}
	async unmergedPaths(): Promise<string[]> {
		return this.unmerged;
	}
	async merging(): Promise<boolean> {
		return this.mergeInProgress;
	}
	async commitAll(_cwd: string, message: string): Promise<string> {
		this.commits.push(message);
		this.headSha = `sha${this.commits.length}`;
		return this.headSha;
	}
	async diffCachedQuiet(): Promise<boolean> {
		return this.nothingStaged;
	}
	/** Paths the fake repo treats as gitignored (prefix match). */
	ignoredPrefixes: string[] = [];
	async ignoredPaths(_cwd: string, paths: string[]): Promise<string[]> {
		return paths.filter((path) => this.ignoredPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
	}
	async commitRecords(cwd: string, message: string, paths: string[]): Promise<{ commit: string; skipped: string[] }> {
		const skipped = await this.ignoredPaths(cwd, paths);
		const stageable = paths.filter((path) => !skipped.includes(path));
		if (stageable.length === 0 && paths.length > 0) return { commit: this.headSha, skipped };
		return { commit: await this.commitPaths(cwd, message, stageable), skipped };
	}
	async commitMerge(_cwd: string): Promise<string> {
		this.commits.push("merge");
		this.headSha = `sha${this.commits.length}`;
		return this.headSha;
	}
	async commitPaths(_cwd: string, message: string, _paths: string[]): Promise<string> {
		if (this.nothingStaged) return this.headSha;
		this.commits.push(message);
		this.headSha = `sha${this.commits.length}`;
		return this.headSha;
	}
	async revParse(): Promise<string> {
		return this.headSha;
	}
	async changedFiles(): Promise<string[]> {
		return [];
	}
}

export interface FakeState {
	files: Map<string, string>;
	dispatched: Array<{ runId: string; request: DispatchRequest }>;
	resumed: Array<{ target: string; runId: string; message: string }>;
	stopped: string[];
	statuses: Map<string, RunStatus>;
	progress: string[];
	asked: string[];
	gateResults: Map<string, GateResult[]>;
	notifications: string[];
}

export interface TestHost {
	host: DriverHost;
	fake: FakeState;
	git: FakeGit;
	ledger: ProgramLedger;
	/** Complete a run with an output payload. */
	completeRun(runId: string, payload?: { output?: string; structured?: unknown }): void;
	failRun(runId: string, error?: string): void;
	lastRunId(): string;
}

export function makeCardText(input: {
	id: string;
	title?: string;
	depends?: string[];
	kind?: "write" | "recon";
	state?: string;
	evidence?: string;
	review?: "light" | "enhanced";
}): string {
	const depends = input.depends && input.depends.length > 0 ? input.depends.join(", ") : "—";
	const lines = [
		`# Card ${input.id} — ${input.title ?? `card ${input.id}`}`,
		"",
		`**Scope:** do the thing for ${input.id}.`,
		"",
		`Depends on: ${depends}`,
		`Kind: ${input.kind ?? "write"}`,
		...(input.review ? [`Review: ${input.review}`] : []),
		"",
		"## Steps",
		"",
		"1. Do it.",
		"",
		"## Done when",
		"",
		"- It is done.",
		"",
		"## Evidence",
		"",
		input.evidence ?? "(none yet)",
		"",
		`## State: ${input.state ?? "todo"}`,
		"",
	];
	return lines.join("\n");
}

export function createTestHost(input: {
	cards: Array<{
		id: string;
		depends?: string[];
		kind?: "write" | "recon";
		state?: string;
		evidence?: string;
	}>;
	overrides?: ProgramConfigOverrides;
	gates?: { card?: string[]; program?: string[] };
	mode?: "session" | "managed" | "captain";
	maxParallel?: number;
	parallelExecution?: "worktrees" | "direct";
}): TestHost {
	const settings: WorkProgramSettings = applyOverrides(
		{
			...DEFAULT_SETTINGS,
			gates: {
				card: input.gates?.card ?? DEFAULT_SETTINGS.gates.card,
				program: input.gates?.program ?? DEFAULT_SETTINGS.gates.program,
			},
		},
		{
			...(input.mode ? { mode: input.mode } : {}),
			...(input.maxParallel ? { maxParallel: input.maxParallel } : {}),
			...(input.parallelExecution ? { parallelExecution: input.parallelExecution } : {}),
			...(input.overrides ?? {}),
		},
	);
	const parsed: ParsedCard[] = input.cards.map((card) => {
		const path = `tasks/${card.id}-card.md`;
		const text = makeCardText({
			id: card.id,
			depends: card.depends,
			...(card.kind ? { kind: card.kind } : {}),
			...(card.state ? { state: card.state } : {}),
			...(card.evidence ? { evidence: card.evidence } : {}),
		});
		return parseCard(path, card.id, text);
	});
	const planLines = ["# Work program — test", "", "| # | card | phase | depends on |", "| --- | --- | --- | --- |"];
	for (const card of input.cards) {
		planLines.push(`| ${card.id} | \`tasks/${card.id}-card.md\` — card ${card.id} | 1 | ${(card.depends ?? []).join(", ") || "—"} |`);
	}
	const ledger = buildLedger({
		slug: "test-program",
		title: "Test program",
		dir: ".agents/work-programs/test-program",
		settings,
		overrides: input.overrides,
		baseBranch: "feat/foo",
		baseCommit: "base0",
		cards: parsed,
		planText: planLines.join("\n"),
	});
	ledger.status = "active";

	const programDir = "/repo/.agents/work-programs/test-program";
	const files = new Map<string, string>();
	for (const card of parsed) {
		files.set(join(programDir, card.path), makeCardText({ id: card.id, depends: card.dependsOn, ...(card.evidence ? { evidence: card.evidence } : {}) }));
	}
	files.set(join(programDir, "plan.md"), planLines.join("\n"));
	files.set(join(programDir, "progress.md"), "# progress\n");

	const fake: FakeState = {
		files,
		dispatched: [],
		resumed: [],
		stopped: [],
		statuses: new Map(),
		progress: [],
		asked: [],
		gateResults: new Map(),
		notifications: [],
	};
	const git = new FakeGit();
	let runCounter = 0;

	function heartbeatSnapshot(runId: string): RunHeartbeat {
		const state = fake.statuses.get(runId);
		return {
			runId,
			state: state?.state ?? "running",
			elapsedMs: 60_000,
			lastUpdate: Date.now() - 5_000,
			steps: 2,
			recentTools: ["read"],
			tail: "working…",
		};
	}

	const cardCwd = (card: CardLedger): string => {
		if (ledger.parallelExecution === "worktrees" && card.lane) return card.lane.path;
		return programDir;
	};

	const runs: RunOps = {
		available: () => true,
		dispatch: async (request: DispatchRequest): Promise<DispatchResult> => {
			runCounter += 1;
			const runId = `run-${runCounter}`;
			fake.dispatched.push({ runId, request });
			fake.statuses.set(runId, { state: "running" });
			return { runId };
		},
		resume: async (target: string, message: string): Promise<DispatchResult> => {
			runCounter += 1;
			const runId = `run-${runCounter}`;
			fake.resumed.push({ target, runId, message });
			fake.statuses.set(runId, { state: "running" });
			fake.dispatched.push({ runId, request: { kind: "fix", agent: "worker", task: message, cwd: "/repo", label: "resume" } });
			return { runId };
		},
		status: async (runId: string): Promise<RunStatus> => fake.statuses.get(runId) ?? { state: "not_found" },
		stop: async (runId: string): Promise<void> => {
			fake.stopped.push(runId);
			const current = fake.statuses.get(runId);
			if (current && (current.state === "running" || current.state === "unknown")) {
				fake.statuses.set(runId, { state: "stopped" });
			}
		},
		heartbeat: async (runId: string): Promise<RunHeartbeat> => heartbeatSnapshot(runId),
		heartbeatSnapshot: (runId: string): RunHeartbeat => heartbeatSnapshot(runId),
	};

	const gates: GateOps = {
		run: async (command: string, _cwd: string): Promise<GateResult> => {
			const results = fake.gateResults.get(command) ?? [{ command, code: 0, at: Date.now(), tail: "" }];
			return results[0] as GateResult;
		},
	};

	const ports: DriverPorts = {
		readFile: async (path) => fake.files.get(path) ?? "",
		writeFile: async (path, content) => {
			fake.files.set(path, content);
		},
		appendProgress: async (line) => {
			fake.progress.push(line);
		},
		notify: (message) => {
			fake.notifications.push(message);
		},
		ask: (message) => {
			fake.asked.push(message);
		},
		git,
		gates,
		runs,
		persist: async () => {},
		readCard: async (_ledger, card) => fake.files.get(join(programDir, card.path)) ?? "",
		writeCard: async (_ledger, card, content) => {
			fake.files.set(join(programDir, card.path), content);
		},
		worktreeBase: () => "/wt/test-program",
		runCwd: (_ledger, card) => cardCwd(card),
	};

	const host: DriverHost = {
		cwd: "/repo",
		programDir,
		ledger,
		ports,
		save: async () => {},
		refreshUi: () => {},
	};

	return {
		host,
		fake,
		git,
		ledger,
		completeRun: (runId, payload) => {
			fake.statuses.set(runId, {
				state: "complete",
				...(payload?.output !== undefined ? { output: payload.output } : {}),
				...(payload?.structured !== undefined ? { structured: payload.structured } : {}),
			});
		},
		failRun: (runId, error) => {
			fake.statuses.set(runId, { state: "failed", ...(error ? { error } : {}) });
		},
		lastRunId: () => `run-${runCounter}`,
	};
}

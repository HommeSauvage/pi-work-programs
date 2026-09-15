import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RPC_TIMEOUT_MS, SUBAGENT_RPC_READY_EVENT, SUBAGENT_RPC_REPLY_EVENT_PREFIX, SUBAGENT_RPC_REQUEST_EVENT, SUBAGENT_RPC_VERSION, STATUS_TIMEOUT_MS } from "../constants.ts";
import type { DispatchRequest, DispatchResult, RunHeartbeat, RunOps, RunStatus } from "../shared/types.ts";

interface RpcEnvelope {
	version: number;
	requestId: string;
	success: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

export interface SubagentsCapabilities {
	ping: unknown;
	events: Record<string, string>;
	methods: string[];
	version: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

function isTerminalState(state: unknown): state is RunStatus["state"] {
	return (
		state === "complete" ||
		state === "failed" ||
		state === "stopped" ||
		state === "paused" ||
		state === "rejected"
	);
}

export class SubagentsRpc implements RunOps {
	private pingData: Record<string, unknown> | undefined;
	private readonly asyncDirs = new Map<string, string>();
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly pi: ExtensionAPI) {}

	attach(): void {
		this.disposers.push(
			this.pi.events.on(SUBAGENT_RPC_READY_EVENT, (data: unknown) => {
				const record = asRecord(data);
				if (record) this.pingData = record;
			}),
		);
		this.disposers.push(
			this.pi.events.on("subagent:async-complete", (data: unknown) => {
				const record = asRecord(data);
				const id = typeof record?.id === "string" ? record.id : undefined;
				const asyncDir = typeof record?.asyncDir === "string" ? record.asyncDir : undefined;
				if (id && asyncDir) this.asyncDirs.set(id, asyncDir);
			}),
		);
	}

	dispose(): void {
		for (const dispose of this.disposers) {
			try {
				dispose();
			} catch {
				// ignore
			}
		}
		this.disposers.length = 0;
	}

	available(): boolean {
		return this.pingData !== undefined;
	}

	capabilities(): SubagentsCapabilities | undefined {
		if (!this.pingData) return undefined;
		const events = asRecord(this.pingData.events) ?? {};
		const methods = Array.isArray(this.pingData.methods)
			? this.pingData.methods.filter((entry): entry is string => typeof entry === "string")
			: [];
		const version = typeof this.pingData.version === "number" ? this.pingData.version : SUBAGENT_RPC_VERSION;
		return {
			ping: this.pingData,
			events: Object.fromEntries(
				Object.entries(events).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			),
			methods,
			version,
		};
	}

	async ping(): Promise<SubagentsCapabilities | undefined> {
		try {
			const data = await this.request("ping", {}, RPC_TIMEOUT_MS);
			const record = asRecord(data);
			if (record) this.pingData = record;
			return this.capabilities();
		} catch {
			return this.capabilities();
		}
	}

	private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const requestId = randomUUID();
		const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
		const reply = await new Promise<RpcEnvelope>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`pi-subagents RPC ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const unsubscribe = this.pi.events.on(replyEvent, (data: unknown) => {
				clearTimeout(timer);
				unsubscribe();
				const record = asRecord(data);
				if (!record) {
					reject(new Error(`pi-subagents RPC ${method} returned a malformed reply`));
					return;
				}
				resolve({
					version: typeof record.version === "number" ? record.version : 0,
					requestId: typeof record.requestId === "string" ? record.requestId : requestId,
					success: record.success === true,
					...(record.data !== undefined ? { data: record.data } : {}),
					...(asRecord(record.error) ? { error: asRecord(record.error) as RpcEnvelope["error"] } : {}),
				});
			});
			this.pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: SUBAGENT_RPC_VERSION, requestId, method, params });
		});
		if (!reply.success) {
			throw new Error(reply.error?.message ?? `pi-subagents RPC ${method} failed`);
		}
		return reply.data;
	}

	async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		const params: Record<string, unknown> = {
			agent: request.agent,
			task: request.task,
			cwd: request.cwd,
			context: "fresh",
			label: request.label,
			async: true,
		};
		if (request.model) params.model = request.model;
		if (request.thinking) params.thinking = request.thinking;
		if (request.outputSchema) params.outputSchema = request.outputSchema;
		if (request.timeoutMs) params.timeoutMs = request.timeoutMs;
		const data = asRecord(await this.request("spawn", params, RPC_TIMEOUT_MS));
		const details = asRecord(data?.details);
		const runId = typeof details?.runId === "string" ? details.runId : typeof details?.asyncId === "string" ? details.asyncId : undefined;
		const asyncDir = typeof details?.asyncDir === "string" ? details.asyncDir : undefined;
		if (!runId) throw new Error(`pi-subagents spawn returned no run id (${JSON.stringify(details ?? data)?.slice(0, 400)})`);
		if (asyncDir) this.asyncDirs.set(runId, asyncDir);
		return asyncDir ? { runId, asyncDir } : { runId };
	}

	async resume(runId: string, message: string): Promise<DispatchResult> {
		const data = asRecord(await this.request("resume", { id: runId, message }, RPC_TIMEOUT_MS));
		const details = asRecord(data?.details);
		const newRunId =
			typeof details?.runId === "string" ? details.runId : typeof details?.asyncId === "string" ? details.asyncId : undefined;
		const asyncDir = typeof details?.asyncDir === "string" ? details.asyncDir : undefined;
		if (!newRunId) throw new Error("pi-subagents resume returned no run id");
		if (asyncDir) this.asyncDirs.set(newRunId, asyncDir);
		return asyncDir ? { runId: newRunId, asyncDir } : { runId: newRunId };
	}

	/**
	 * Read-only liveness snapshot for UI display. Reads the run's status.json
	 * from disk only — never contacts the runner, steers, resumes, or stops.
	 */
	async heartbeat(runId: string, asyncDir?: string): Promise<RunHeartbeat> {
		return this.heartbeatSnapshot(runId, asyncDir);
	}

	/** Sync variant of heartbeat for the synchronous TUI widget path. Same read-only file reads. */
	heartbeatSnapshot(runId: string, asyncDir?: string): RunHeartbeat {
		const dir = asyncDir ?? this.asyncDirs.get(runId);
		if (!dir) return { runId, state: "unknown" };
		const status = readJsonFile(join(dir, "status.json"));
		if (!status) return { runId, state: "unknown" };
		return snapshotFromStatus(runId, status);
	}

	/** Stop a live run immediately (hard pause). Throws when the run cannot be stopped. */
	async stop(runId: string): Promise<void> {
		await this.request("stop", { id: runId }, RPC_TIMEOUT_MS);
	}

	async status(runId: string, asyncDir?: string): Promise<RunStatus> {
		const dir = asyncDir ?? this.asyncDirs.get(runId);
		if (dir) {
			const status = readJsonFile(join(dir, "status.json"));
			if (!status) return { state: "not_found" };
			const state = status.state;
			if (!isTerminalState(state)) {
				if (state === "queued" || state === "running") return { state };
				return { state: "unknown" };
			}
			return this.terminalStatus(runId, dir, state, status);
		}
		try {
			const data = asRecord(await this.request("status", { id: runId }, STATUS_TIMEOUT_MS));
			const text = typeof data?.text === "string" ? data.text : "";
			if (data?.isError === true || text.includes("Async run not found")) return { state: "not_found" };
			if (text.includes("state: running") || text.includes("running")) return { state: "running" };
			return { state: "unknown" };
		} catch {
			return {
				state: "unknown",
				error: this.pingData ? "pi-subagents status unavailable" : "pi-subagents RPC unavailable",
			};
		}
	}

	private terminalStatus(
		runId: string,
		asyncDir: string,
		state: RunStatus["state"],
		status: Record<string, unknown>,
	): RunStatus {
		const root = dirname(dirname(asyncDir));
		const result = this.readResult(runId, join(root, "async-subagent-results"));
		const output = extractOutput(result) ?? extractStatusOutput(status);
		const structured = asRecord(result?.structuredOutput) ?? extractStepsStructured(result);
		const error = typeof status.error === "string" ? status.error : typeof result?.error === "string" ? result.error : undefined;
		const mapped: RunStatus = { state, ...(output !== undefined ? { output } : {}), ...(structured !== undefined ? { structured } : {}) };
		if (error) mapped.error = error;
		return mapped;
	}

	private readResult(runId: string, resultsDir: string): Record<string, unknown> | undefined {
		const publicPath = join(resultsDir, `${runId}.json`);
		const direct = readJsonFile(publicPath);
		if (direct) return direct;
		const pendingRoot = join(resultsDir, "result-pending");
		try {
			for (const sessionDir of readdirSync(pendingRoot)) {
				const candidate = readJsonFile(join(pendingRoot, sessionDir, `${runId}.json`));
				if (candidate) return candidate;
			}
		} catch {
			// no pending results
		}
		return undefined;
	}
}

function snapshotFromStatus(runId: string, status: Record<string, unknown>): RunHeartbeat {
	const state = typeof status.state === "string" ? status.state : "unknown";
	const startedAt = typeof status.startedAt === "number" ? status.startedAt : undefined;
	const lastUpdate =
		typeof status.lastUpdate === "number"
			? status.lastUpdate
			: typeof status.lastUpdateAt === "number"
				? (status.lastUpdateAt as number)
				: undefined;
	const endedAt = typeof status.endedAt === "number" ? status.endedAt : undefined;
	const durationMs = typeof status.durationMs === "number" ? status.durationMs : undefined;
	const steps = Array.isArray(status.steps) ? status.steps : undefined;
	const lastStep = steps !== undefined && steps.length > 0 ? asRecord(steps[steps.length - 1]) : undefined;
	const snapshot: RunHeartbeat = { runId, state };
	const elapsed = durationMs ?? (startedAt !== undefined ? (endedAt ?? lastUpdate ?? Date.now()) - startedAt : undefined);
	if (elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0) snapshot.elapsedMs = elapsed;
	if (lastUpdate !== undefined) snapshot.lastUpdate = lastUpdate;
	if (steps !== undefined) snapshot.steps = steps.length;
	if (lastStep) {
		const tools = lastStep.recentTools;
		if (Array.isArray(tools)) {
			const names = tools
				.map((tool) => {
					if (typeof tool === "string") return tool;
					const record = asRecord(tool);
					const name = record?.name ?? record?.tool;
					return typeof name === "string" ? name : undefined;
				})
				.filter((name): name is string => name !== undefined)
				.slice(-3);
			if (names.length > 0) snapshot.recentTools = names;
		}
		const tail = stepTail(lastStep);
		if (tail) snapshot.tail = tail;
	}
	return snapshot;
}

function stepTail(step: Record<string, unknown>): string | undefined {
	const recent = step.recentOutput;
	if (Array.isArray(recent)) {
		const text = recent
			.filter((line): line is string => typeof line === "string")
			.slice(-3)
			.join("\n")
			.trim();
		if (text.length > 0) return text.length > 500 ? `…${text.slice(-500)}` : text;
	}
	const outputTail = step.outputTail;
	if (typeof outputTail === "string" && outputTail.trim().length > 0) {
		const text = outputTail.trim();
		return text.length > 500 ? `…${text.slice(-500)}` : text;
	}
	return undefined;
}

function extractOutput(result: Record<string, unknown> | undefined): string | undefined {
	if (!result) return undefined;
	const results = result.results;
	if (Array.isArray(results)) {
		for (let index = results.length - 1; index >= 0; index -= 1) {
			const record = asRecord(results[index]);
			const output = record?.output;
			if (typeof output === "string" && output.trim().length > 0) return output;
		}
	}
	const summary = result.summary;
	if (typeof summary === "string" && summary.trim().length > 0) return summary;
	return undefined;
}

function extractStepsStructured(result: Record<string, unknown> | undefined): unknown {
	const results = asRecord(result)?.results;
	if (!Array.isArray(results)) return undefined;
	for (const entry of results) {
		const record = asRecord(entry);
		if (record?.structuredOutput !== undefined) return record.structuredOutput;
	}
	return undefined;
}

function extractStatusOutput(status: Record<string, unknown>): string | undefined {
	const steps = status.steps;
	if (!Array.isArray(steps)) return undefined;
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const record = asRecord(steps[index]);
		const recent = record?.recentOutput;
		if (Array.isArray(recent)) {
			const text = recent.filter((line): line is string => typeof line === "string").join("\n");
			if (text.trim().length > 0) return text;
		}
	}
	return undefined;
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (data: unknown) => void;

export class FakeEventBus {
	private readonly listeners = new Map<string, Set<Handler>>();

	on(event: string, handler: Handler): () => void {
		const set = this.listeners.get(event) ?? new Set<Handler>();
		set.add(handler);
		this.listeners.set(event, set);
		return () => set.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.listeners.get(event) ?? [])]) handler(data);
	}

	listenerCount(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}
}

export interface FakeRegisteredTool {
	name: string;
	execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
}

export interface FakeRegisteredCommand {
	name: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
}

export class FakePi {
	readonly events = new FakeEventBus();
	readonly tools: FakeRegisteredTool[] = [];
	readonly commands: FakeRegisteredCommand[] = [];
	readonly hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	allTools: Array<{ name: string }> = [
		{ name: "subagent" },
		{ name: "intercom" },
		{ name: "read" },
	];
	sessionName: string | undefined;
	entries: Array<{ customType?: string; data?: unknown }> = [];
	messages: Array<{ customType?: string; content: string }> = [];
	execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];

	registerTool(definition: { name: string; execute: FakeRegisteredTool["execute"] }): void {
		this.tools.push(definition);
	}

	registerCommand(name: string, definition: Omit<FakeRegisteredCommand, "name">): void {
		this.commands.push({ name, ...definition });
	}

	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
		const list = this.hooks.get(event) ?? [];
		list.push(handler);
		this.hooks.set(event, list);
	}

	getAllTools(): Array<{ name: string }> {
		return this.allTools;
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ customType, data });
	}

	setSessionName(name: string): void {
		this.sessionName = name;
	}

	sendMessage(message: { customType?: string; content: string }): void {
		this.messages.push(message);
	}

	async exec(command: string, args: string[], options?: { cwd?: string }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
		killed: boolean;
	}> {
		this.execCalls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
		return { stdout: "", stderr: "", code: 0, killed: false };
	}

	asExtensionApi(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

/** Answer pi-subagents RPC requests with a canned ping/spawn/resume reply. */
export function installRpcResponder(pi: FakePi, options: { runId?: string; asyncDir?: string } = {}): void {
	pi.events.on("subagents:rpc:v1:request", (raw: unknown) => {
		const request = raw as { requestId: string; method: string };
		const replyEvent = `subagents:rpc:v1:reply:${request.requestId}`;
		if (request.method === "ping") {
			pi.events.emit(replyEvent, {
				version: 1,
				requestId: request.requestId,
				method: "ping",
				success: true,
				data: {
					version: 1,
					methods: ["ping", "spawn", "status", "resume", "steer", "stop"],
					capabilities: { asyncSpawn: true },
					events: { asyncComplete: "subagent:async-complete" },
				},
			});
			return;
		}
		if (request.method === "spawn") {
			pi.events.emit(replyEvent, {
				version: 1,
				requestId: request.requestId,
				method: "spawn",
				success: true,
				data: { text: "spawned", details: { mode: "single", runId: options.runId ?? "r1", asyncDir: options.asyncDir ?? "/tmp/fake-run" } },
			});
			return;
		}
		if (request.method === "stop") {
			pi.events.emit(replyEvent, {
				version: 1,
				requestId: request.requestId,
				method: "stop",
				success: true,
				data: { text: "stopped" },
			});
			return;
		}
		pi.events.emit(replyEvent, {
			version: 1,
			requestId: request.requestId,
			method: request.method,
			success: false,
			error: { code: "unsupported", message: `no fake for ${request.method}` },
		});
	});
}


export interface StubUi {
	notify: (message: string, level?: string) => void;
	setStatus: (key: string, value: string | undefined) => void;
	setWidget: (key: string, value: string[] | undefined) => void;
	theme: { fg: (color: string, text: string) => string };
}

export function fakeSessionContext(input: {
	cwd: string;
	entries?: unknown[];
	ui?: StubUi;
	idle?: boolean;
}): ExtensionContext {
	const ui: StubUi = input.ui ?? {
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		theme: { fg: (_color: string, text: string) => text },
	};
	return {
		cwd: input.cwd,
		hasUI: false,
		isIdle: () => input.idle !== false,
		ui,
		sessionManager: {
			getEntries: () => input.entries ?? [],
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		signal: undefined,
	} as unknown as ExtensionContext;
}

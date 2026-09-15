import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INTERCOM_TOOL_NAME } from "../constants.ts";
import type { SubagentsRpc } from "./runs.ts";

export interface DependencyStatus {
	ok: boolean;
	subagents: {
		installed: boolean;
		ready: boolean;
		tool: boolean;
		version?: number;
		methods: string[];
		error?: string;
	};
	intercom: { installed: boolean; tool: boolean; signaled: boolean };
	missing: string[];
	hints: string[];
}

export const SUBAGENTS_INSTALL_HINT = "pi install npm:pi-subagents";
export const INTERCOM_INSTALL_HINT = "pi install npm:pi-intercom";

export class DependencyProbe {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly runs: SubagentsRpc,
	) {}

	async check(input?: { intercomReady?: boolean; intercomConfigured?: boolean }): Promise<DependencyStatus> {
		const tools = new Set(this.pi.getAllTools().map((tool) => tool.name));
		const subagentToolPresent = tools.has("subagent");
		const intercomToolPresent = tools.has(INTERCOM_TOOL_NAME);
		const intercomSignaled = input?.intercomReady === true;
		const capabilities = this.runs.available() ? this.runs.capabilities() : await this.runs.ping();
		const methods = capabilities?.methods ?? [];
		const spawnSupported = capabilities === undefined ? false : methods.length === 0 || methods.includes("spawn");
		const subagentsReady = capabilities !== undefined && spawnSupported;
		const intercomInstalled = intercomToolPresent || intercomSignaled || input?.intercomConfigured === true;
		const missing: string[] = [];
		const hints: string[] = [];
		if (!subagentsReady) {
			missing.push("pi-subagents");
			hints.push(SUBAGENTS_INSTALL_HINT);
		}
		if (!intercomInstalled) {
			missing.push("pi-intercom");
			hints.push(INTERCOM_INSTALL_HINT);
		}
		const subagents: DependencyStatus["subagents"] = {
			installed: capabilities !== undefined,
			ready: subagentsReady,
			tool: subagentToolPresent,
			methods,
		};
		if (capabilities?.version !== undefined) subagents.version = capabilities.version;
		if (!capabilities) subagents.error = "pi-subagents RPC bridge did not answer a ping";
		else if (!spawnSupported) subagents.error = "the installed pi-subagents does not expose the spawn RPC method";
		return {
			ok: missing.length === 0,
			subagents,
			intercom: {
				installed: intercomInstalled,
				tool: intercomToolPresent,
				signaled: intercomSignaled || input?.intercomConfigured === true,
			},
			missing,
			hints,
		};
	}
}

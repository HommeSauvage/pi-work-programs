import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GATE_TIMEOUT_MS } from "../constants.ts";
import { truncateTail } from "../shared/text.ts";
import type { GateOps, GateResult } from "../shared/types.ts";

export class Gates implements GateOps {
	constructor(private readonly pi: ExtensionAPI) {}

	async run(command: string, cwd: string): Promise<GateResult> {
		const result = await this.pi.exec("bash", ["-lc", command], { cwd, timeout: GATE_TIMEOUT_MS });
		const tail = truncateTail(`${result.stdout}\n${result.stderr}`.trim(), 8_000);
		return {
			command,
			code: result.killed ? -1 : result.code,
			at: Date.now(),
			tail,
		};
	}
}

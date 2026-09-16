import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import {
	BRIEF_CUSTOM_TYPE,
	INTERCOM_READY_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_RPC_READY_EVENT,
} from "./constants.ts";
import { WorkProgramController } from "./engine/controller.ts";
import { registerTools } from "./tools.ts";

export default function workProgramsExtension(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	const controller = new WorkProgramController(pi);
	const disposers: Array<() => void> = [
		pi.events.on(SUBAGENT_RPC_READY_EVENT, () => {
			void controller.onDependenciesChanged();
		}),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => {
			controller.scheduleDrive();
		}),
		pi.events.on(INTERCOM_READY_EVENT, () => {
			controller.markIntercomReady();
			void controller.onDependenciesChanged();
		}),
	];

	registerTools(pi, controller);
	registerCommands(pi, controller);

	pi.on("session_start", async (_event, ctx) => {
		await controller.initialize(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const dispose of disposers) {
			try {
				dispose();
			} catch {
				// best effort
			}
		}
		controller.shutdown();
	});

	pi.on("context", async (event: ContextEvent): Promise<{ messages: ContextEvent["messages"] } | undefined> => {
		if (!controller.getActive()) return;
		const brief = controller.contextBrief();
		if (brief.length === 0) return;
		const message = {
			role: "custom",
			customType: BRIEF_CUSTOM_TYPE,
			content: brief,
			display: false,
			timestamp: Date.now(),
		} as unknown as ContextEvent["messages"][number];
		return { messages: [...event.messages, message] };
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input as { path?: string };
		const path = typeof input.path === "string" ? input.path : "";
		if (path.length === 0) return;
		const active = controller.getActive();
		if (!active) return;
		if (path.endsWith("progress.md")) {
			if (!path.includes(active.slug)) return;
			return {
				block: true,
				reason:
					"progress.md is owned by pi-work-programs; the extension records card, review, and merge events automatically.",
			};
		}
		// The todo store is single-writer (drive + todo actions). Workers append to
		// .operator/todo.md (imported automatically); everyone else uses todos,
		// todo_add, todo_update, todo_done, todo_drop.
		if (path.includes(".operator") && path.endsWith("todos.json")) {
			return {
				block: true,
				reason:
				"todos.json is owned by pi-work-programs; use work_program todos/todo_add/todo_update/todo_done/todo_drop instead (workers: append to .operator/todo.md, it is imported automatically).",
			};
		}
	});
}

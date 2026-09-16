import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkProgramController } from "./engine/controller.ts";
import type { Mode } from "./shared/types.ts";

const ACTIONS = ["status", "list", "new", "start", "pause", "resume", "mode", "sync", "todos", "doctor", "close"] as const;

function completions(prefix: string): Array<{ value: string; label: string }> | null {
	const items = ACTIONS.map((action) => ({ value: action, label: action }));
	const filtered = items.filter((item) => item.value.startsWith(prefix));
	return filtered.length > 0 ? filtered : null;
}

/** Follow-up that hands the session to the agent after start/resume so the
 *  operator never has to type "continue" to get motion. */
function startResumeNudge(controller: WorkProgramController, verb: string): string {
	const brief = controller.contextBrief();
	return [
		`[WORK PROGRAM] ${verb}${brief ? ` — ${brief.split("\n")[0] ?? ""}` : ""}.`,
		"Continue execution now: check status, let ready work dispatch, triage any open reviews.",
		"If the drive reports errors, surface them to the operator instead of waiting in silence.",
	].join("\n");
}

export function registerCommands(pi: ExtensionAPI, controller: WorkProgramController): void {
	pi.registerCommand("work-program", {
		description:
			"Work programs: status | list | new <title> | start <slug> | pause [--hard] | resume | mode <session|managed|captain> | sync | todos | doctor | close [--remove]",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
			const action = parts[0] ?? "status";
			const rest = parts.slice(1);
			switch (action) {
				case "status": {
					ctx.ui.notify(await controller.statusText(), "info");
					return;
				}
				case "list": {
					ctx.ui.notify(await controller.listPrograms(), "info");
					return;
				}
				case "doctor": {
					ctx.ui.notify(await controller.doctor(), "info");
					return;
				}
				case "new": {
					let title = rest.join(" ").trim();
					if (title.length === 0) {
						if (!ctx.hasUI) {
							ctx.ui.notify("Usage: /work-program new <title>", "warning");
							return;
						}
						const entered = await ctx.ui.input("Work program title", "");
						if (!entered) return;
						title = entered.trim();
					}
					if (title.length === 0) return;
					let brief = "";
					if (ctx.hasUI) {
						const entered = await ctx.ui.input("North star (brief)", "");
						brief = entered?.trim() ?? "";
					}
					const choice = ctx.hasUI
						? await ctx.ui.select("Orchestration mode", [
								"managed — extension runs the loop; this agent decides at checkpoints",
								"session — this agent dispatches every step",
								"captain — one orchestrator per card",
							])
						: undefined;
					const mode: Mode | undefined = choice?.startsWith("session")
						? "session"
						: choice?.startsWith("captain")
							? "captain"
							: choice?.startsWith("managed")
								? "managed"
								: undefined;
					const result = await controller.suggestWorkProgram({ title, brief, confirmed: true, ...(mode ? { mode } : {}) });
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					return;
				}
				case "start": {
					const slug = rest[0];
					if (!slug) {
						ctx.ui.notify("Usage: /work-program start <slug>", "warning");
						return;
					}
					const result = await controller.startProgram(slug);
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					if (result.ok) controller.nudgeAgent(startResumeNudge(controller, "Started"));
					return;
				}
				case "pause": {
					const hard = rest.includes("--hard");
					const result = await controller.pause(hard);
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					return;
				}
				case "resume": {
					const result = await controller.resume();
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					if (result.ok) controller.nudgeAgent(startResumeNudge(controller, "Resumed"));
					return;
				}
				case "mode": {
					const mode = rest[0];
					if (!mode || !["session", "managed", "captain"].includes(mode)) {
						ctx.ui.notify("Usage: /work-program mode <session|managed|captain>", "warning");
						return;
					}
					const result = await controller.setMode(mode as Mode);
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					return;
				}
				case "sync": {
					const result = await controller.syncFromDisk();
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					return;
				}
				case "todos": {
					const result = await controller.todoList();
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					return;
				}
				case "close": {
					const remove = rest.includes("--remove") || rest.includes("-r");
					const result = await controller.closeProgram(remove);
					ctx.ui.notify(result.text, result.ok ? "info" : "error");
					return;
				}
				default:
					ctx.ui.notify(
						`Unknown action "${action}". Try: ${ACTIONS.join(", ")}`,
						"warning",
					);
			}
		},
	});
}

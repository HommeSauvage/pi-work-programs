import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkProgramController } from "./engine/controller.ts";
import type { FindingVerdict, Mode } from "./shared/types.ts";

interface SuggestParams {
	title: string;
	brief: string;
	rationale?: string;
	mode?: string;
}

interface WorkProgramParams {
	action: string;
	card?: string;
	role?: string;
	slug?: string;
	title?: string;
	brief?: string;
	mode?: string;
	resolution?: string;
	choice?: string;
	remove?: boolean;
	hard?: boolean;
	verdicts?: Array<{ finding: string; verdict: string; note?: string }>;
}

const ACTIONS = [
	"status",
	"protocol",
	"list",
	"create",
	"start",
	"finalize_plan",
	"sync",
	"pause",
	"resume",
	"mode",
	"dispatch",
	"triage",
	"unblock",
	"cycle_decision",
	"program_gate",
	"merge_resolved",
	"close",
	"doctor",
] as const;

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string): never {
	throw new Error(text);
}

export function registerTools(pi: ExtensionAPI, controller: WorkProgramController): void {
	pi.registerTool({
		name: "suggest_work_program",
		label: "Suggest Work Program",
		description:
			"Propose turning a large or multi-session request into a durable work program. The user is asked to confirm and choose an orchestration mode; on confirmation the program folder, plan scaffold and card templates are created and this agent must then write plan.md and tasks/*.md, validate with work_program({action:'finalize_plan'}), then STOP for operator review. Never start execution without the operator explicitly saying to start.",
		promptSnippet: "Propose a durable work program for large multi-session tasks",
		promptGuidelines: [
			"Use suggest_work_program when a request spans multiple sessions, has several dependent deliverables, or would outlive the current context; do not use it for ordinary single-change requests.",
			"After suggest_work_program returns scaffold instructions, write plan.md and tasks/*.md yourself (you have the conversation context), then validate with work_program action 'finalize_plan'.",
			"After finalize_plan, STOP: present the plan and cards to the operator for review and wait for an explicit start. Never call resume, start, or dispatch on your own — only after the operator explicitly says to start may you call work_program with action 'resume'.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short program title; becomes the folder slug" }),
			brief: Type.String({ description: "The north-star goal of the program" }),
			rationale: Type.Optional(Type.String({ description: "Why this deserves a work program" })),
			mode: Type.Optional(
				Type.String({ description: "Orchestration mode: session | managed | captain (defaults to config)" }),
			),
		}),
		async execute(_toolCallId, rawParams) {
			const params = rawParams as SuggestParams;
			if (!params.title || !params.brief) fail("title and brief are required");
			const mode = params.mode && ["session", "managed", "captain"].includes(params.mode) ? (params.mode as Mode) : undefined;
			const result = await controller.suggestWorkProgram({
				title: params.title,
				brief: params.brief,
				...(mode ? { mode } : {}),
			});
			if (!result.ok) fail(result.text);
			return textResult(result.text, { ok: true });
		},
	});

	pi.registerTool({
		name: "work_program",
		label: "Work Program",
		description:
			"Drive and inspect the active work program. Actions: status, protocol, list, create, start, finalize_plan, sync, pause, resume, mode, dispatch, triage, unblock, cycle_decision, program_gate, merge_resolved, close, doctor.",
		promptSnippet: "Inspect or drive the active work program (status, dispatch, triage, finalize plan)",
		promptGuidelines: [
			"Use work_program to inspect and drive a work program; never edit plan.md or progress.md directly.",
			"finalize_plan only validates and stages a program — it never starts execution. After writing a plan, STOP and wait for the operator to review; only call resume/start/dispatch after the operator explicitly says to start.",
			"When a work program completes, you receive a summary packet: reply with a completion summary, then ask whether to close the program. Only call close with remove:true after the operator explicitly confirms — never delete program records unprompted.",
			"Pause is soft by default (in-flight runs finish, resume reconciles); pass hard:true to stop runs immediately and rearm their cards. Resume restarts the drive.",
			"When a work-program decision packet arrives, answer with the exact work_program call it names (for review triage use action 'triage' with one verdict per finding).",
		],
		parameters: Type.Object({
			action: Type.String({ description: `One of: ${ACTIONS.join(", ")}` }),
			card: Type.Optional(Type.String({ description: "Card id for dispatch/triage/unblock/cycle/merge actions" })),
			role: Type.Optional(Type.String({ description: "dispatch role: worker | reviewer | reconciler" })),
			slug: Type.Optional(Type.String({ description: "Program slug for start" })),
			title: Type.Optional(Type.String({ description: "Title for create" })),
			brief: Type.Optional(Type.String({ description: "North star for create" })),
			mode: Type.Optional(Type.String({ description: "session | managed | captain" })),
			resolution: Type.Optional(Type.String({ description: "unblock resolution: redispatch | done | abandon" })),
			choice: Type.Optional(
				Type.String({ description: "cycle_decision: one_more | accept | block; program_gate: retry | block" }),
			),
			remove: Type.Optional(Type.Boolean({ description: "close with remove=true deletes the program folder" })),
			hard: Type.Optional(
				Type.Boolean({ description: "pause with hard=true stops in-flight runs immediately (default soft: let them finish)" }),
			),
			verdicts: Type.Optional(
				Type.Array(
					Type.Object({
						finding: Type.String({ description: "Short label or quote identifying the finding" }),
						verdict: Type.String({ description: "approve | reject | defer" }),
						note: Type.Optional(Type.String({ description: "Optional rationale" })),
					}),
				),
			),
		}),
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as WorkProgramParams;
			const action = params.action;
			const needsSubagents = [
				"create",
				"start",
				"finalize_plan",
				"dispatch",
				"triage",
				"unblock",
				"cycle_decision",
				"program_gate",
			].includes(action);
			if (needsSubagents) {
				const depError = controller.requireDependencies();
				if (depError) fail(depError);
			}
			switch (action) {
				case "status": {
					const text = await controller.statusText();
					return textResult(text, { ok: true });
				}
				case "protocol":
					return textResult(controller.protocol(), { ok: true });
				case "list":
					return textResult(await controller.listPrograms(), { ok: true });
				case "doctor":
					return textResult(await controller.doctor(), { ok: true });
				case "create": {
					if (!params.title || !params.brief) fail("create requires title and brief (or use suggest_work_program)");
					const mode =
						params.mode && ["session", "managed", "captain"].includes(params.mode) ? (params.mode as Mode) : undefined;
					const result = await controller.suggestWorkProgram({
						title: params.title,
						brief: params.brief,
						...(mode ? { mode } : {}),
					});
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "start": {
					if (!params.slug) fail("start requires slug");
					const result = await controller.startProgram(params.slug);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "finalize_plan": {
					const result = await controller.finalizePlan();
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "sync": {
					const result = await controller.syncFromDisk();
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "pause": {
					const result = await controller.pause(params.hard === true);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "resume": {
					const result = await controller.resume();
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "mode": {
					if (!params.mode || !["session", "managed", "captain"].includes(params.mode)) {
						fail("mode action requires mode: session | managed | captain");
					}
					const result = await controller.setMode(params.mode as Mode);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "dispatch": {
					if (!params.card || !params.role) fail("dispatch requires card and role");
					if (!["worker", "reviewer", "reconciler"].includes(params.role)) {
						fail("role must be worker | reviewer | reconciler");
					}
					const result = await controller.dispatch(params.card, params.role as "worker" | "reviewer" | "reconciler");
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "triage": {
					if (!params.card || !params.verdicts || params.verdicts.length === 0) {
						fail("triage requires card and a non-empty verdicts array");
					}
					const verdicts: FindingVerdict[] = [];
					for (const entry of params.verdicts) {
						const verdict = entry.verdict;
						if (verdict !== "approve" && verdict !== "reject" && verdict !== "defer") {
							fail(`verdict for "${entry.finding}" must be approve | reject | defer`);
						}
						verdicts.push({ finding: entry.finding, verdict, ...(entry.note ? { note: entry.note } : {}) });
					}
					const result = await controller.triage(params.card, verdicts);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "unblock": {
					if (!params.card || !params.resolution) fail("unblock requires card and resolution");
					if (!["redispatch", "done", "abandon"].includes(params.resolution)) {
						fail("resolution must be redispatch | done | abandon");
					}
					const result = await controller.unblock(
						params.card,
						params.resolution as "redispatch" | "done" | "abandon",
					);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "cycle_decision": {
					if (!params.card || !params.choice) fail("cycle_decision requires card and choice");
					if (!["one_more", "accept", "block"].includes(params.choice)) {
						fail("choice must be one_more | accept | block");
					}
					const result = await controller.cycleDecision(
						params.card,
						params.choice as "one_more" | "accept" | "block",
					);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "program_gate": {
					if (!params.choice) fail("program_gate requires choice: retry | block");
					if (!["retry", "block"].includes(params.choice)) fail("choice must be retry | block");
					const result = await controller.programGateDecision(params.choice as "retry" | "block");
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "merge_resolved": {
					if (!params.card) fail("merge_resolved requires card");
					const result = await controller.mergeResolved(params.card);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "close": {
					const result = await controller.closeProgram(params.remove === true);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				default:
					fail(`Unknown action "${action}". Valid actions: ${ACTIONS.join(", ")}`);
			}
		},
	});
}

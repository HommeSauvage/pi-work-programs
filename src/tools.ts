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
	maxCycles?: number;
	onExhausted?: string;
	reviewProfile?: string;
	maxParallel?: number;
	parallelExecution?: string;
	workerAgent?: string;
	workerModel?: string;
	workerThinking?: string;
	reviewerAgent?: string;
	reviewerModel?: string;
	reviewerThinking?: string;
	reviewerResume?: boolean;
	runTimeoutMs?: number;
	atlasEnabled?: boolean;
	atlasAgent?: string;
	atlasModel?: string;
	atlasThinking?: string;
	id?: string;
	body?: string;
	steps?: Array<{ text: string; command?: string; dangerous?: boolean }>;
	blocking?: boolean;
	note?: string;
	reason?: string;
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
	"config",
	"todos",
	"todo_add",
	"todo_update",
	"todo_done",
	"todo_drop",
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
			"Drive and inspect the active work program. Actions: status, protocol, list, create, start, finalize_plan, sync, pause, resume, mode, config, todos, todo_add, todo_update, todo_done, todo_drop, dispatch, triage, unblock, cycle_decision, program_gate, merge_resolved, close, doctor.",
		promptSnippet: "Inspect or drive the active work program (status, dispatch, triage, finalize plan)",
		promptGuidelines: [
			"Use work_program to inspect and drive a work program; never edit plan.md or progress.md directly.",
			"finalize_plan only validates and stages a program — it never starts execution. After writing a plan, STOP and wait for the operator to review; only call resume/start/dispatch after the operator explicitly says to start.",
			"When a work program completes, you receive a summary packet: reply with a completion summary, then ask whether to close the program. Only call close with remove:true after the operator explicitly confirms — never delete program records unprompted.",
			"Pause is soft by default (in-flight runs finish, resume reconciles); pass hard:true to stop runs immediately and rearm their cards. Resume restarts the drive.",
			"The program is retunable while it runs: work_program({ action: \"config\", maxCycles, onExhausted, reviewProfile, maxParallel, parallelExecution, workerAgent, workerModel, workerThinking, reviewerAgent, reviewerModel, reviewerThinking, reviewerResume, atlasEnabled, atlasAgent, atlasModel, atlasThinking }) updates the live ledger and persists into plan.md front matter, so it survives sync and reload. Use it instead of answering cycle decisions one by one (onExhausted: \"accept\" also resolves the open ones), and instead of editing plan.md by hand.",
			"Retune one card the same way with card set: work_program({ action: \"config\", card: \"05\", maxCycles: 5, reviewProfile: \"enhanced\" }) updates the live ledger row and persists into that card file's front matter. Card models work the same way (workerModel, reviewerModel, thinking); pass an empty string to clear a card override so it inherits the program default. Never hand-edit card front matter — always use config with card.",
			"When a work-program decision packet arrives, answer with the exact work_program call it names (for review triage use action 'triage' with one verdict per finding).",
			"Operator todos are chat-driven: list with todos, create with todo_add (blocking parks the card until resolved), rewrite with todo_update (title, body, steps), resolve with todo_done (the card resumes on its own) or todo_drop. Present open todos conversationally (title, why, exact steps/commands) instead of quoting storage. Never write or edit .operator/todos.json or .operator/todo.md directly — always use the todo actions.",
		],
		parameters: Type.Object({
			action: Type.String({ description: `One of: ${ACTIONS.join(", ")}` }),
			card: Type.Optional(Type.String({ description: "Card id for dispatch/triage/unblock/cycle/merge actions; for config, scopes the patch to one card's front matter" })),
			role: Type.Optional(Type.String({ description: "dispatch role: worker | reviewer | reconciler" })),
			slug: Type.Optional(Type.String({ description: "Program slug for start" })),
			title: Type.Optional(Type.String({ description: "Title for create" })),
			brief: Type.Optional(Type.String({ description: "North star for create" })),
			mode: Type.Optional(Type.String({ description: "session | managed | captain" })),
			resolution: Type.Optional(Type.String({ description: "unblock resolution: redispatch | done | abandon" })),
			choice: Type.Optional(
				Type.String({ description: "cycle_decision: accept | block (no extra review rounds); program_gate: retry | block" }),
			),
			remove: Type.Optional(Type.Boolean({ description: "close with remove=true deletes the program folder" })),
			hard: Type.Optional(
				Type.Boolean({ description: "pause with hard=true stops in-flight runs immediately (default soft: let them finish)" }),
			),
			maxCycles: Type.Optional(
				Type.Number({ description: "config: review cycles before the harness asks (0-32); lowering it applies to the next triage" }),
			),
			onExhausted: Type.Optional(
				Type.String({ description: "config: ask | accept | block when maxCycles is reached; accept also resolves open cycle decisions" }),
			),
			reviewProfile: Type.Optional(Type.String({ description: "config: light | enhanced review profile" })),
			maxParallel: Type.Optional(Type.Number({ description: "config: how many cards may run at once (1-32)" })),
			parallelExecution: Type.Optional(Type.String({ description: "config: worktrees | direct" })),
			workerAgent: Type.Optional(Type.String({ description: "config: worker subagent (program-level, or per-card with card set)" })),
			workerModel: Type.Optional(Type.String({ description: "config: model for worker runs (empty string clears a card override)" })),
			workerThinking: Type.Optional(Type.String({ description: "config: thinking level for worker runs (empty string clears a card override)" })),
			reviewerAgent: Type.Optional(Type.String({ description: "config: reviewer subagent (program-level, or per-card with card set)" })),
			reviewerModel: Type.Optional(Type.String({ description: "config: model for reviewer runs (empty string clears a card override)" })),
			reviewerThinking: Type.Optional(Type.String({ description: "config: thinking level for reviewer runs (empty string clears a card override)" })),
			reviewerResume: Type.Optional(
				Type.Boolean({ description: "config: resume the same reviewer across a card's review cycles (default true); false = fresh reviewer every cycle" }),
			),
			runTimeoutMs: Type.Optional(
				Type.Number({ description: "config: wall-clock timeout per run in ms (default 4h; pi-subagents kills runs at 30m otherwise)" }),
			),
			atlasEnabled: Type.Optional(
				Type.Boolean({ description: "config: build/maintain the program atlas (scout exploration) and inject it into worker/reviewer briefs" }),
			),
			atlasAgent: Type.Optional(Type.String({ description: "config: scout subagent for atlas builds/refreshes (default \"scout\")" })),
			atlasModel: Type.Optional(Type.String({ description: "config: model for atlas scout runs (empty string clears)" })),
			atlasThinking: Type.Optional(Type.String({ description: "config: thinking level for atlas scout runs (empty string clears)" })),
			id: Type.Optional(Type.String({ description: "todo id (op-NN) for todo_update/todo_done/todo_drop" })),
			body: Type.Optional(Type.String({ description: "todo_add/todo_update: why, context, details" })),
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						text: Type.String({ description: "Step instruction" }),
						command: Type.Optional(Type.String({ description: "Exact command to run" })),
						dangerous: Type.Optional(Type.Boolean({ description: "Fails dangerously — operator must STOP and read" })),
					}),
				),
			),
			blocking: Type.Optional(Type.Boolean({ description: "todo_add/todo_update: true parks the card until resolved (default when a live card is named)" })),
			note: Type.Optional(Type.String({ description: "todo_done: what was done / where it lives" })),
			reason: Type.Optional(Type.String({ description: "todo_drop: why this is no longer needed" })),
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
				case "config": {
					const patch: Record<string, unknown> = {};
					if (params.card !== undefined) patch.card = params.card;
					if (params.maxCycles !== undefined) patch.maxCycles = params.maxCycles;
					if (params.onExhausted !== undefined) patch.onExhausted = params.onExhausted;
					if (params.reviewProfile !== undefined) patch.reviewProfile = params.reviewProfile;
					if (params.maxParallel !== undefined) patch.maxParallel = params.maxParallel;
					if (params.parallelExecution !== undefined) patch.parallelExecution = params.parallelExecution;
					if (params.mode !== undefined) patch.mode = params.mode;
					if (params.workerAgent !== undefined) patch.workerAgent = params.workerAgent;
					if (params.workerModel !== undefined) patch.workerModel = params.workerModel;
					if (params.workerThinking !== undefined) patch.workerThinking = params.workerThinking;
					if (params.reviewerAgent !== undefined) patch.reviewerAgent = params.reviewerAgent;
					if (params.reviewerModel !== undefined) patch.reviewerModel = params.reviewerModel;
					if (params.reviewerThinking !== undefined) patch.reviewerThinking = params.reviewerThinking;
					if (params.reviewerResume !== undefined) patch.reviewerResume = params.reviewerResume;
					if (params.runTimeoutMs !== undefined) patch.runTimeoutMs = params.runTimeoutMs;
					if (params.atlasEnabled !== undefined) patch.atlasEnabled = params.atlasEnabled;
					if (params.atlasAgent !== undefined) patch.atlasAgent = params.atlasAgent;
					if (params.atlasModel !== undefined) patch.atlasModel = params.atlasModel;
					if (params.atlasThinking !== undefined) patch.atlasThinking = params.atlasThinking;
					const result = await controller.setConfig(patch as Parameters<typeof controller.setConfig>[0]);
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "todos": {
					const result = await controller.todoList();
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "todo_add": {
					if (!params.title) fail("todo_add requires title");
					const result = await controller.todoAdd({
						title: params.title,
						...(params.body !== undefined ? { body: params.body } : {}),
						...(params.steps !== undefined ? { steps: params.steps } : {}),
						...(params.card !== undefined ? { card: params.card } : {}),
						...(params.blocking !== undefined ? { blocking: params.blocking } : {}),
					});
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "todo_update": {
					if (!params.id) fail("todo_update requires id");
					const result = await controller.todoUpdate({
						id: params.id,
						...(params.title !== undefined ? { title: params.title } : {}),
						...(params.body !== undefined ? { body: params.body } : {}),
						...(params.steps !== undefined ? { steps: params.steps } : {}),
						...(params.card !== undefined ? { card: params.card } : {}),
						...(params.blocking !== undefined ? { blocking: params.blocking } : {}),
					});
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "todo_done": {
					if (!params.id) fail("todo_done requires id");
					const result = await controller.todoDone({ id: params.id, ...(params.note !== undefined ? { note: params.note } : {}) });
					if (!result.ok) fail(result.text);
					return textResult(result.text, { ok: true });
				}
				case "todo_drop": {
					if (!params.id) fail("todo_drop requires id");
					const result = await controller.todoDrop({ id: params.id, ...(params.reason !== undefined ? { reason: params.reason } : {}) });
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
					if (!["accept", "block"].includes(params.choice)) {
						fail("choice must be accept | block (extra review rounds are not offered)");
					}
					const result = await controller.cycleDecision(
						params.card,
						params.choice as "accept" | "block",
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

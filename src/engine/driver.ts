import { loadResources } from "../protocol/resources.ts";
import {
	captainBrief,
	fixBrief,
	gateFixBrief,
	reconcilerBrief,
	reviewTask,
	workerBrief,
} from "../protocol/briefs.ts";
import { appendHarnessEvidence, gateEvidenceLines, setCardState } from "../program/card-edit.ts";
import { laneBranch, reviewPath } from "../program/ledger.ts";
import { parseEvidence } from "../program/parse.ts";
import { oneLine, truncateTail } from "../shared/text.ts";
import type {
	CardLedger,
	DriverPorts,
	FindingVerdict,
	GateResult,
	ProgramLedger,
	RunStatus,
} from "../shared/types.ts";
import {
	blockedDecisionMessage,
	cancelOpenDecisionsFor,
	createDecision,
	cycleDecisionMessage,
	packetText,
	programCompleteMessage,
	programGateDecisionMessage,
	resolveDecision,
	reviewDecisionMessage,
} from "./decisions.ts";
import { openDecisionFor, openDecisions, readyCards, writersInFlight } from "./phases.ts";

const UNKNOWN_RUN_GRACE_MS = 10 * 60_000;

export interface DriverHost {
	cwd: string;
	programDir: string;
	ledger: ProgramLedger;
	ports: DriverPorts;
	save(): Promise<void>;
	refreshUi(): void;
}

const TERMINAL_STATES = new Set(["complete", "failed", "stopped", "paused", "rejected", "not_found"]);
const CAPTAIN_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		verdict: { type: "string" },
		commit: { type: "string" },
		reviewPath: { type: "string" },
		cycles: { type: "number" },
		findings: { type: "object" },
		gates: { type: "array" },
		blockers: { type: "array", items: { type: "string" } },
	},
	required: ["verdict"],
	additionalProperties: true,
};

function ledgerCards(ledger: ProgramLedger): CardLedger[] {
	return ledger.order
		.map((id) => ledger.cards[id])
		.filter((card): card is CardLedger => card !== undefined);
}

function cardPath(host: DriverHost, card: CardLedger): string {
	return `${host.programDir}/${card.path}`;
}

function planPath(host: DriverHost): string {
	return `${host.programDir}/plan.md`;
}

async function readCardText(host: DriverHost, card: CardLedger): Promise<string> {
	return host.ports.readCard(host.ledger, card);
}

async function writeCardText(host: DriverHost, card: CardLedger, text: string): Promise<void> {
	await host.ports.writeCard(host.ledger, card, text);
}

async function progress(host: DriverHost, line: string): Promise<void> {
	const match = /^(\S+)\s+(.*)$/.exec(line);
	const formatted = match ? `[card ${match[1]}] ${match[2]}` : `[program] ${line}`;
	await host.ports.appendProgress(formatted);
}

async function runCardGates(host: DriverHost, card: CardLedger, cwd: string): Promise<{ ok: boolean; gates: GateResult[] }> {
	const commands = host.ledger.gates.card;
	const gates: GateResult[] = [];
	if (commands.length === 0) {
		card.gates = [];
		return { ok: true, gates };
	}
	card.phase = "verifying";
	await host.save();
	for (const command of commands) {
		const result = await host.ports.gates.run(command, cwd);
		gates.push(result);
	}
	card.gates = gates;
	return { ok: gates.every((gate) => gate.code === 0), gates };
}

function gateFailures(gates: GateResult[]): string[] {
	return gates.filter((gate) => gate.code !== 0).map((gate) => `${gate.command} (exit ${gate.code})`);
}

function isTerminal(status: RunStatus): boolean {
	return TERMINAL_STATES.has(status.state);
}

function activeRunOf(card: CardLedger): { kind: string; runId: string; asyncDir?: string } | undefined {
	const active = card.activeRun;
	if (!active) return undefined;
	return { kind: active.kind, runId: active.runId, ...(active.asyncDir ? { asyncDir: active.asyncDir } : {}) };
}

export async function drive(host: DriverHost): Promise<void> {
	const { ledger, ports } = host;
	if (ledger.status !== "active") return;
	if (!ports.runs.available()) {
		ports.notify("pi-subagents is not available; work program loop is paused", "warning");
		return;
	}

	await reconcileRuns(host);
	if (ledger.mode === "managed" || ledger.mode === "captain") {
		await dispatchReadyCards(host);
		await dispatchReviews(host);
		await dispatchFixes(host);
	}
	await finishApprovedCards(host);
	await ensurePackets(host);
	await processMergeQueue(host);
	await maybeRunProgramGate(host);
	await host.save();
	host.refreshUi();
}

async function reconcileRuns(host: DriverHost): Promise<void> {
	for (const card of ledgerCards(host.ledger)) {
		const active = activeRunOf(card);
		if (!active) continue;
		const status = await host.ports.runs.status(active.runId, active.asyncDir);
		if (status.state === "unknown") {
			const startedAt = card.activeRun?.startedAt ?? 0;
			if (startedAt > 0 && Date.now() - startedAt > UNKNOWN_RUN_GRACE_MS) {
				card.activeRun = undefined;
				await blockCard(host, card, `run ${active.runId} state could not be determined; needs a decision`);
				await host.save();
			}
			continue;
		}
		if (!isTerminal(status)) continue;
		card.activeRun = undefined;
		switch (active.kind) {
			case "worker":
				await onWorkerComplete(host, card, status, active.runId);
				break;
			case "reviewer":
				await onReviewerComplete(host, card, status, active.runId);
				break;
			case "fix":
				await onFixComplete(host, card, status, active.runId);
				break;
			case "captain":
				await onCaptainComplete(host, card, status, active.runId);
				break;
			case "reconciler":
				await onReconcilerComplete(host, card, status, active.runId);
				break;
		}
		await host.save();
	}
}

async function blockCard(host: DriverHost, card: CardLedger, reason: string): Promise<void> {
	if (card.phase !== "blocked") card.blockedFrom = card.phase;
	card.phase = "blocked";
	card.lastError = reason;
	cancelOpenDecisionsFor(host, card.id, reason);
	createDecision(host, {
		kind: "blocked",
		card: card.id,
		message: blockedDecisionMessage(card.id, reason),
		expectedAction: `work_program({ action: "unblock", card: "${card.id}", resolution: "redispatch" | "done" | "abandon" })`,
	});
	await progress(host, `${card.id} blocked — ${oneLine(reason, 120)}`);
	host.ports.notify(`Work program: card ${card.id} blocked — ${oneLine(reason, 100)}`, "error");
}

function isInfraDispatchError(error: unknown): boolean {
	return /timed out|timeout|runner startup|control .confirm|no run id|ECONN|EPIPE|EAI_AGAIN|socket hang up|temporarily unavailable/i.test(
		String(error),
	);
}

/**
 * Dispatch with one immediate retry for infrastructure flakes (runner startup,
 * RPC timeouts). A failed dispatch creates no run, so a single retry is safe;
 * anything else blocks with detail instead of stalling the drive loop.
 */
async function dispatchWithInfraRetry(
	host: DriverHost,
	card: CardLedger,
	request: Parameters<typeof dispatchRun>[2],
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await dispatchRun(host, card, request);
		return { ok: true };
	} catch (error) {
		if (!isInfraDispatchError(error)) return { ok: false, error: oneLine(String(error), 200) };
		try {
			await dispatchRun(host, card, request);
			await progress(host, `${card.id} dispatch retry succeeded after an infra failure`);
			return { ok: true };
		} catch (retryError) {
			return {
				ok: false,
				error: `infra failure twice: ${oneLine(String(retryError), 160)} (first: ${oneLine(String(error), 120)})`,
			};
		}
	}
}

async function onWorkerComplete(host: DriverHost, card: CardLedger, status: RunStatus, runId: string): Promise<void> {
	if (status.state === "paused") {
		await blockCard(host, card, `worker run ${runId} paused by operator — redispatch to continue from the lane state`);
		return;
	}
	if (status.state !== "complete") {
		await blockCard(
			host,
			card,
			`worker run ${runId} ended as ${status.state}${status.error ? `: ${status.error}` : " (no error reported)"}`,
		);
		return;
	}
	const text = await readCardText(host, card);
	if (!parseEvidence(text)) {
		await blockCard(host, card, "worker finished without an `## Evidence` section");
		return;
	}
	card.workerSummary = status.output ? truncateTail(status.output, 6_000) : "";
	const outcome = await runCardGates(host, card, host.ports.runCwd(host.ledger, card));
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "implementation");
		return;
	}
	card.phase = "review_pending";
	await progress(host, `${card.id} implemented (gates green)`);
}

async function startGateFix(
	host: DriverHost,
	card: CardLedger,
	gates: GateResult[],
	origin: "implementation" | "merge" | "captain",
): Promise<void> {
	const attempts = (card.gateAttempts ?? 0) + 1;
	card.gateAttempts = attempts;
	if (attempts > 3) {
		await blockCard(host, card, `gates still failing after ${attempts - 1} fix attempts: ${gateFailures(gates).join("; ")}`);
		return;
	}
	card.fixReason = "gate";
	card.lastError = undefined;
	const task = gateFixBrief({ ledger: host.ledger, card, failures: gates, origin });
	const cwd = card.merge?.state === "merged" ? host.cwd : host.ports.runCwd(host.ledger, card);
	const dispatched = await dispatchWithInfraRetry(host, card, {
		kind: "fix",
		agent: host.ledger.workerAgent,
		task,
		cwd,
		model: host.ledger.workerModel,
		thinking: host.ledger.workerThinking,
		label: `wp ${host.ledger.slug} card ${card.id} gate fix`,
	});
	if (!dispatched.ok) {
		await blockCard(host, card, `gate-fix dispatch failed: ${dispatched.error}`);
	}
}

async function onReviewerComplete(host: DriverHost, card: CardLedger, status: RunStatus, runId: string): Promise<void> {
	if (status.state === "paused") {
		await blockCard(host, card, `reviewer run ${runId} paused by operator — redispatch to re-run the review`);
		return;
	}
	if (status.state !== "complete") {
		await blockCard(
			host,
			card,
			`reviewer run ${runId} ended as ${status.state}${status.error ? `: ${status.error}` : " (no error reported)"}`,
		);
		return;
	}
	const cycle = card.cycles + 1;
	const path = reviewPath(host.programDir, card.id, cycle);
	const written = (await host.ports.readFile(path))?.trim() ?? "";
	const output = status.output?.trim() ?? "";
	const review = written.length > 0 ? written : output;
	if (review.length === 0) {
		await blockCard(host, card, "reviewer returned no findings");
		return;
	}
	if (written.length === 0) await host.ports.writeFile(path, `${review}\n`);
	card.cycles = cycle;
	card.phase = "triaging";
	const profile = card.reviewProfile ?? host.ledger.reviewProfile;
	createDecision(host, {
		kind: "review-triage",
		card: card.id,
		reviewPath: path,
		summary: oneLine(output, 300),
		message: reviewDecisionMessage(host.ledger, card.id, cycle, profile),
		expectedAction: `work_program({ action: "triage", card: "${card.id}", verdicts: [{ "finding": "<label>", "verdict": "approve" | "reject" | "defer", "note": "..." }] })`,
	});
	await progress(host, `${card.id} review ${cycle} ready — awaiting triage`);
}

async function onFixComplete(host: DriverHost, card: CardLedger, status: RunStatus, runId: string): Promise<void> {
	const wasMerged = card.merge?.state === "merged";
	if (status.state === "paused") {
		await blockCard(host, card, `fix run ${runId} paused by operator — redispatch to retry the pending fixes`);
		return;
	}
	if (status.state !== "complete") {
		await blockCard(
			host,
			card,
			`fix run ${runId} ended as ${status.state}${status.error ? `: ${status.error}` : " (no error reported)"}`,
		);
		return;
	}
	card.fixReason = undefined;
	const cwd = wasMerged ? host.cwd : host.ports.runCwd(host.ledger, card);
	const outcome = await runCardGates(host, card, cwd);
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, wasMerged ? "merge" : "implementation");
		return;
	}
	if (wasMerged) {
		await markDoneAndCommit(host, card, [`merge: recorded manually (${(card.merge?.commit ?? "").slice(0, 7)})`]);
		await finalizeMergedCard(host, card, card.merge?.commit ?? "");
		return;
	}
	card.phase = "review_pending";
	await progress(host, `${card.id} fixes applied — re-review queued`);
}

async function onCaptainComplete(host: DriverHost, card: CardLedger, status: RunStatus, runId: string): Promise<void> {
	if (status.state === "paused") {
		await blockCard(host, card, `captain run ${runId} paused by operator — redispatch to restart the card loop`);
		return;
	}
	if (status.state !== "complete") {
		await blockCard(
			host,
			card,
			`captain run ${runId} ended as ${status.state}${status.error ? `: ${status.error}` : " (no error reported)"}`,
		);
		return;
	}
	const structured = status.structured as Record<string, unknown> | undefined;
	if (!structured || typeof structured.verdict !== "string") {
		await blockCard(host, card, "captain did not return structured output");
		return;
	}
	card.workerSummary = status.output ? truncateTail(status.output, 6_000) : "";
	if (structured.verdict === "done") {
		const reviewFile = typeof structured.reviewPath === "string" ? structured.reviewPath : "";
		const reviewText = await host.ports.readFile(reviewFile).catch(() => "");
		const cycles = typeof structured.cycles === "number" ? structured.cycles : 0;
		if (reviewFile.length === 0 || reviewText.trim().length === 0 || cycles < 1) {
			await blockCard(host, card, "captain reported done without a recorded review pass");
			return;
		}
		card.cycles = Math.max(card.cycles, cycles);
	}
	if (structured.verdict !== "done") {
		const blockers = Array.isArray(structured.blockers)
			? structured.blockers.filter((entry): entry is string => typeof entry === "string")
			: [];
		await blockCard(host, card, blockers.length > 0 ? blockers.join("; ") : "captain reported a blocker");
		return;
	}
	const outcome = await runCardGates(host, card, host.ports.runCwd(host.ledger, card));
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "captain");
		return;
	}
	card.phase = "approved";
	await progress(host, `${card.id} captain loop done (gates green)`);
}

async function dispatchRun(
	host: DriverHost,
	card: CardLedger,
	request: {
		kind: "worker" | "reviewer" | "fix" | "captain" | "reconciler";
		agent: string;
		task: string;
		cwd: string;
		model?: string;
		thinking?: string;
		label: string;
		outputSchema?: Record<string, unknown>;
	},
): Promise<void> {
	const result = await host.ports.runs.dispatch({
		kind: request.kind,
		agent: request.agent,
		task: request.task,
		cwd: request.cwd,
		label: request.label,
		...(request.model ? { model: request.model } : {}),
		...(request.thinking ? { thinking: request.thinking } : {}),
		...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
	});
	card.activeRun = {
		kind: request.kind,
		runId: result.runId,
		startedAt: Date.now(),
		...(result.asyncDir ? { asyncDir: result.asyncDir } : {}),
	};
	card.runs += 1;
	card.blockedFrom = undefined;
	if (request.kind === "worker") {
		card.workerRun = result.runId;
		card.phase = "implementing";
	} else if (request.kind === "reviewer") {
		card.reviewRun = result.runId;
		card.phase = "reviewing";
	} else if (request.kind === "fix") {
		card.fixRuns = [...(card.fixRuns ?? []), result.runId];
		card.workerRun = result.runId;
		card.phase = "fixing";
	} else if (request.kind === "captain") {
		card.captainRun = result.runId;
		card.phase = "implementing";
	} else {
		card.reconcilerRun = result.runId;
		card.phase = "reconciling";
	}
	await host.save();
}

async function ensureLane(host: DriverHost, card: CardLedger): Promise<void> {
	if (host.ledger.parallelExecution !== "worktrees") return;
	if (card.lane) return;
	const base = await host.ports.git.head(host.cwd);
	const branch = laneBranch(host.ledger.laneBranchPattern, host.ledger.baseBranch, card.id);
	const path = `${host.ports.worktreeBase(host.ledger)}/${card.id}`;
	await host.ports.git.worktreeAdd(host.cwd, path, branch, base);
	card.lane = { path, branch, base };
	await host.save();
}

export async function startWorkerFor(host: DriverHost, card: CardLedger): Promise<void> {
	const ledger = host.ledger;
	card.gateAttempts = 0;
	card.lastError = undefined;
	try {
		await ensureLane(host, card);
	} catch (error) {
		await blockCard(host, card, `lane setup failed: ${oneLine(String(error), 200)}`);
		return;
	}
	if (ledger.mode === "captain") {
		const reviewProfile = card.reviewProfile ?? ledger.reviewProfile;
		const path = reviewPath(host.programDir, card.id, card.cycles + 1);
		const task = captainBrief({
			ledger,
			card,
			cardPath: cardPath(host, card),
			planPath: planPath(host),
			cwd: host.ports.runCwd(ledger, card),
			gates: ledger.gates.card,
			reviewProfile,
			reviewPath: path,
		});
		const dispatched = await dispatchWithInfraRetry(host, card, {
			kind: "captain",
			agent: "work-program-captain",
			task,
			cwd: host.ports.runCwd(ledger, card),
			label: `wp ${ledger.slug} card ${card.id} captain`,
			outputSchema: CAPTAIN_OUTPUT_SCHEMA,
		});
		if (!dispatched.ok) {
			await blockCard(host, card, `captain dispatch failed: ${dispatched.error}`);
		}
		return;
	}
	const task = workerBrief({
		ledger,
		card,
		cardPath: cardPath(host, card),
		planPath: planPath(host),
		cwd: host.ports.runCwd(ledger, card),
		gates: ledger.gates.card,
	});
	try {
		const dispatched = await dispatchWithInfraRetry(host, card, {
			kind: "worker",
			agent: ledger.workerAgent,
			task,
			cwd: host.ports.runCwd(ledger, card),
			model: ledger.workerModel,
			thinking: ledger.workerThinking,
			label: `wp ${ledger.slug} card ${card.id}`,
		});
		if (!dispatched.ok) {
			await blockCard(host, card, `worker dispatch failed: ${dispatched.error}`);
		}
	} catch (error) {
		await blockCard(host, card, `worker dispatch failed: ${oneLine(String(error), 200)}`);
	}
}

async function dispatchReadyCards(host: DriverHost): Promise<void> {
	const ledger = host.ledger;
	const capacity = ledger.parallelExecution === "direct" ? 1 : ledger.maxParallel;
	const ready = readyCards(ledger);
	if (ready.length === 0) return;
	const inFlight = writersInFlight(ledger);
	let slots = Math.max(0, capacity - inFlight);
	for (const card of ready) {
		if (slots <= 0) break;
		slots -= 1;
		await startWorkerFor(host, card);
		if (card.phase === "blocked") continue;
		await progress(host, `${card.id} dispatched (${ledger.mode})`);
		host.ports.notify(`Work program: card ${card.id} dispatched`, "info");
	}
}

export async function startReviewFor(host: DriverHost, card: CardLedger): Promise<void> {
	const ledger = host.ledger;
	const profile = card.reviewProfile ?? ledger.reviewProfile;
	const cwd = host.ports.runCwd(ledger, card);
	const base = card.lane?.base ?? (await host.ports.git.head(cwd));
	const branch = card.lane?.branch ?? (await host.ports.git.currentBranch(cwd));
	const [commitLog, diffStat, changedFiles] = await Promise.all([
		host.ports.git.commitLog(cwd, `${base}..HEAD`),
		host.ports.git.diffStat(cwd, base, "HEAD"),
		host.ports.git.changedFiles(cwd, base, "HEAD"),
	]);
	const path = reviewPath(host.programDir, card.id, card.cycles + 1);
	await host.ports.writeFile(path, "");
	const task = reviewTask({
		resources: loadResources(),
		ledger,
		card,
		profile,
		cardPath: cardPath(host, card),
		reviewPath: path,
		cwd,
		branch,
		base,
		commitLog,
		diffStat,
		changedFiles,
		workerSummary: card.workerSummary ?? "",
		gates: card.gates ?? [],
	});
	try {
		await dispatchRun(host, card, {
			kind: "reviewer",
			agent: ledger.reviewerAgent,
			task,
			cwd,
			model: ledger.reviewerModel,
			thinking: ledger.reviewerThinking,
			label: `wp ${ledger.slug} card ${card.id} review`,
		});
	} catch (error) {
		await blockCard(host, card, `reviewer dispatch failed: ${oneLine(String(error), 200)}`);
		return;
	}
	await progress(host, `${card.id} review ${card.cycles + 1} dispatched (${profile})`);
}

async function dispatchReviews(host: DriverHost): Promise<void> {
	const ledger = host.ledger;
	const reviewing = ledgerCards(ledger).filter((card) => card.phase === "reviewing").length;
	let slots = Math.max(0, ledger.maxParallel - reviewing);
	for (const card of ledgerCards(ledger)) {
		if (card.phase !== "review_pending") continue;
		if (slots <= 0) break;
		slots -= 1;
		await startReviewFor(host, card);
	}
}

async function dispatchFixes(host: DriverHost): Promise<void> {
	const ledger = host.ledger;
	for (const card of ledgerCards(ledger)) {
		if (card.phase !== "fixing" || card.activeRun) continue;
		if (openDecisionFor(ledger, card.id)) continue;
		if (!card.lane) {
			try {
				await ensureLane(host, card);
			} catch (error) {
				await blockCard(host, card, `lane setup failed: ${oneLine(String(error), 200)}`);
				continue;
			}
		}
		const decision = [...ledger.decisions]
			.reverse()
			.find((entry) => entry.card === card.id && entry.kind === "review-triage" && entry.status === "resolved");
		const verdicts = decision?.verdicts ?? [];
		const approved = verdicts.filter((verdict) => verdict.verdict === "approve");
		if (approved.length === 0) {
			card.phase = "approved";
			continue;
		}
		card.fixReason = "review";
		const task = fixBrief({
			ledger,
			card,
			reviewPath: decision?.reviewPath ?? "",
			verdicts,
			gates: ledger.gates.card,
		});
		const cwd = host.ports.runCwd(ledger, card);
		if (card.workerRun) {
			try {
				const result = await host.ports.runs.resume(card.workerRun, task);
				card.activeRun = {
					kind: "fix",
					runId: result.runId,
					startedAt: Date.now(),
					...(result.asyncDir ? { asyncDir: result.asyncDir } : {}),
				};
				card.fixRuns = [...(card.fixRuns ?? []), result.runId];
				card.workerRun = result.runId;
				card.runs += 1;
				card.blockedFrom = undefined;
				await progress(host, `${card.id} fix dispatched (resumed worker)`);
				await host.save();
				continue;
			} catch (error) {
				host.ports.notify(
					`Work program: could not resume the retained worker for card ${card.id} (${oneLine(String(error), 120)}); dispatching a fresh worker.`,
					"warning",
				);
				await progress(host, `${card.id} resume failed — fresh fix worker dispatched`);
			}
		}
		const dispatched = await dispatchWithInfraRetry(host, card, {
			kind: "fix",
			agent: ledger.workerAgent,
			task,
			cwd,
			model: ledger.workerModel,
			thinking: ledger.workerThinking,
			label: `wp ${ledger.slug} card ${card.id} review fixes`,
		});
		if (!dispatched.ok) {
			await blockCard(host, card, `fix dispatch failed: ${dispatched.error}`);
			continue;
		}
		await progress(host, `${card.id} fix dispatched (fresh worker)`);
	}
}

async function finishApprovedCards(host: DriverHost): Promise<void> {
	for (const card of ledgerCards(host.ledger)) {
		if (card.phase !== "approved") continue;
		await finishCard(host, card);
	}
}

export async function finishCard(host: DriverHost, card: CardLedger): Promise<void> {
	const ledger = host.ledger;
	if (ledger.parallelExecution === "worktrees") {
		card.phase = "queued";
		card.merge = { state: "queued", attempts: card.merge?.attempts ?? 0 };
		if (!ledger.mergeQueue.includes(card.id)) ledger.mergeQueue.push(card.id);
		await progress(host, `${card.id} approved — queued for merge`);
	} else {
		await completeDirectCard(host, card);
	}
	await host.save();
	host.refreshUi();
	host.ports.notify(`Work program: card ${card.id} approved`, "info");
}

async function completeDirectCard(host: DriverHost, card: CardLedger): Promise<void> {
	const text = await readCardText(host, card);
	let updated = setCardState(text, "done");
	updated = appendHarnessEvidence(updated, [
		...gateEvidenceLines(card.gates ?? [], "gate"),
		`review: ${card.cycles} cycle(s) completed`,
		`completed: ${new Date().toISOString()}`,
	]);
	await writeCardText(host, card, updated);
	const cwd = host.cwd;
	const commit = await host.ports.git.commitPaths(cwd, `wp(${host.ledger.slug}): card ${card.id} done`, [
		`${host.programDir}/${card.path}`,
		`${host.programDir}/plan.md`,
		`${host.programDir}/progress.md`,
	]);
	card.phase = "done";
	card.activeRun = undefined;
	await progress(host, `${card.id} done (${commit.slice(0, 7)})`);
}

async function ensurePackets(host: DriverHost): Promise<void> {
	const pending = openDecisions(host.ledger).filter((decision) => !decision.packetSent);
	if (pending.length === 0) return;
	for (const decision of pending) decision.packetSent = true;
	const text = packetText(host.ledger, pending);
	host.ports.ask(text);
	await host.save();
}

export function rearmPackets(ledger: ProgramLedger): void {
	for (const decision of ledger.decisions) {
		if (decision.status === "open") decision.packetSent = false;
	}
}

/** Porcelain entries outside the program's own record folder and lane worktrees. */
async function foreignChanges(host: DriverHost): Promise<string[]> {
	const raw = await host.ports.git.statusPorcelain(host.cwd);
	const excluded = new Set<string>();
	const cwd = host.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const programAbs = host.programDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const programRel = programAbs.startsWith(`${cwd}/`) ? programAbs.slice(cwd.length + 1) : programAbs;
	excluded.add(programRel);
	for (const id of host.ledger.order) {
		const lane = host.ledger.cards[id]?.lane;
		if (!lane) continue;
		const laneRel = lane.path.replace(/\\/g, "/").replace(/\/+$/, "");
		excluded.add(laneRel.startsWith(`${cwd}/`) ? laneRel.slice(cwd.length + 1) : laneRel);
	}
	return raw
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.filter((line) => {
			const body = line.length > 3 ? line.slice(3).trim() : line.trim();
			const path = body.includes(" -> ") ? (body.split(" -> ").pop() ?? body) : body;
			const normalized = path.replace(/^"|"$/g, "").replace(/\\/g, "/");
			for (const prefix of excluded) {
				if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return false;
			}
			return true;
		});
}

async function processMergeQueue(host: DriverHost): Promise<void> {
	const ledger = host.ledger;
	if (ledger.parallelExecution !== "worktrees") return;
	while (ledger.mergeQueue.length > 0) {
		const headId = ledger.mergeQueue[0];
		if (headId === undefined) return;
		const card = ledger.cards[headId];
		if (!card) {
			ledger.mergeQueue.shift();
			continue;
		}
		if (card.phase === "done") {
			ledger.mergeQueue.shift();
			continue;
		}
		if (card.phase === "blocked") {
			if (card.merge?.state === "conflict" || card.merge?.state === "merging") {
				// A merge is mid-flight (conflict markers / MERGE_HEAD on disk). Park the
				// queue here so unblock+redispatch continues the same merge instead of
				// losing the queue position. Surfaced via status/doctor; no progress spam.
				return;
			}
			ledger.mergeQueue.shift();
			await progress(host, `${card.id} removed from the merge queue (blocked)`);
			await host.save();
			continue;
		}
		if (card.phase === "fixing" || card.phase === "reconciling" || card.activeRun) return;
		const dirty = await foreignChanges(host);
		if (dirty.length > 0) {
			if (!ledger.mergeQueuePaused) {
				ledger.mergeQueuePaused = true;
				host.ports.notify("Work program: merge queue paused (program worktree is dirty)", "warning");
			}
			return;
		}
		if (ledger.mergeQueuePaused) {
			ledger.mergeQueuePaused = false;
			host.ports.notify("Work program: merge queue resumed", "info");
		}
		if (card.phase === "queued") {
			card.phase = "merging";
			card.merge = { state: "merging", attempts: card.merge?.attempts ?? 0 };
			await host.save();
		}
		if (card.phase !== "merging" || !card.lane) return;
		const result = await host.ports.git.mergeNoCommit(host.cwd, card.lane.branch);
		card.merge = { state: "merging", attempts: (card.merge?.attempts ?? 0) + 1 };
		await host.save();
		if (result.conflicted.length > 0) {
			card.merge.state = "conflict";
			await beginReconcile(host, card, result);
			return;
		}
		if (result.code !== 0) {
			await host.ports.git.mergeAbort(host.cwd).catch(() => undefined);
			card.merge = { state: "queued", attempts: card.merge?.attempts ?? 1 };
			await blockCard(host, card, `git merge failed (exit ${result.code}): ${oneLine(result.output, 200)}`);
			ledger.mergeQueue.shift();
			await host.save();
			continue;
		}
		await completeMerge(host, card);
		return;
	}
}

async function beginReconcile(
	host: DriverHost,
	card: CardLedger,
	merge: { conflicted: string[]; output: string },
	force = false,
): Promise<void> {
	const ledger = host.ledger;
	const attempts = (card.reconcileAttempts ?? 0) + 1;
	card.reconcileAttempts = attempts;
	if (attempts > 3) {
		await blockCard(host, card, `merge conflicts unresolved after ${attempts - 1} reconciliation attempts`);
		return;
	}
	if (ledger.mode === "session" && !force) {
		card.phase = "reconciling";
		createDecision(host, {
			kind: "blocked",
			card: card.id,
			message: `Merging card ${card.id} hit conflicts in: ${merge.conflicted.join(", ")}.`,
			expectedAction: `work_program({ action: "dispatch", card: "${card.id}", role: "reconciler" }) — or resolve manually and call work_program({ action: "merge_resolved", card: "${card.id}" })`,
		});
		return;
	}
	const existingIntent = await host.ports.git.commitLog(host.cwd, "-8");
	const task = reconcilerBrief({
		ledger,
		card,
		branch: card.lane?.branch ?? "",
		cwd: host.cwd,
		conflicted: merge.conflicted,
		mergeOutput: merge.output,
		incomingIntent: `Card ${card.id} scope: ${card.title}`,
		existingIntent,
		gateCommands: ledger.gates.card,
	});
	const dispatched = await dispatchWithInfraRetry(host, card, {
		kind: "reconciler",
		agent: "work-program-reconciler",
		task,
		cwd: host.cwd,
		label: `wp ${ledger.slug} card ${card.id} reconcile`,
	});
	if (!dispatched.ok) {
		await blockCard(
			host,
			card,
			`reconciler dispatch failed: ${dispatched.error} (conflict in ${merge.conflicted.join(", ") || "unknown paths"} preserved)`,
		);
		return;
	}
	await progress(host, `${card.id} merge conflict — reconciler dispatched`);
}

async function onReconcilerComplete(host: DriverHost, card: CardLedger, status: RunStatus, runId: string): Promise<void> {
	if (status.state === "paused") {
		await blockCard(
			host,
			card,
			`reconciler run ${runId} paused by operator — the merge conflict is preserved; unblock with redispatch to continue`,
		);
		return;
	}
	if (status.state !== "complete") {
		await blockCard(
			host,
			card,
			`reconciler run ${runId} ended as ${status.state}${status.error ? `: ${status.error}` : " (no error reported; conflict preserved)"}`,
		);
		return;
	}
	const unmerged = await host.ports.git.unmergedPaths(host.cwd);
	if (unmerged.length > 0) {
		await beginReconcile(host, card, {
			conflicted: unmerged,
			output: status.output ?? "",
		});
		return;
	}
	if (await host.ports.git.merging(host.cwd)) {
		await host.ports.git.commitAll(host.cwd, `wp(${host.ledger.slug}): merge card ${card.id} (reconciled)`);
	}
	await completeMerge(host, card);
}

function recordPaths(host: DriverHost, card: CardLedger): string[] {
	return [...programRecordPaths(host), `${host.programDir}/${card.path}`];
}

function programRecordPaths(host: DriverHost): string[] {
	const paths = [`${host.programDir}/plan.md`, `${host.programDir}/progress.md`];
	for (const id of host.ledger.order) {
		const card = host.ledger.cards[id];
		if (card) paths.push(`${host.programDir}/${card.path}`);
	}
	return paths;
}

/** Write `State: done` plus harness evidence into the main card and commit the program records. */
async function markDoneAndCommit(host: DriverHost, card: CardLedger, extraLines: string[] = []): Promise<string> {
	const mainCardPath = `${host.programDir}/${card.path}`;
	const baseText = (await host.ports.readFile(mainCardPath)) || (await readCardText(host, card));
	let updated = setCardState(baseText, "done");
	updated = appendHarnessEvidence(updated, [
		...gateEvidenceLines(card.gates ?? [], "gate"),
		...extraLines,
		`completed: ${new Date().toISOString()}`,
	]);
	await host.ports.writeFile(mainCardPath, updated);
	return host.ports.git.commitPaths(host.cwd, `wp(${host.ledger.slug}): card ${card.id} done`, recordPaths(host, card));
}

async function completeMerge(host: DriverHost, card: CardLedger): Promise<void> {
	const commit = await host.ports.git.commitPaths(
		host.cwd,
		`wp(${host.ledger.slug}): merge card ${card.id} — ${oneLine(card.title, 60)}`,
		[],
	);
	card.merge = { state: "merged", commit, attempts: card.merge?.attempts ?? 1 };
	const outcome = await runCardGates(host, card, host.cwd);
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "merge");
		return;
	}
	await markDoneAndCommit(host, card, [
		`merge: lane ${card.lane?.branch ?? "?"} → ${host.ledger.baseBranch} (${commit.slice(0, 7)})`,
	]);
	await finalizeMergedCard(host, card, commit);
}

async function finalizeMergedCard(host: DriverHost, card: CardLedger, commit: string): Promise<void> {
	card.phase = "done";
	card.activeRun = undefined;
	const index = host.ledger.mergeQueue.indexOf(card.id);
	if (index >= 0) host.ledger.mergeQueue.splice(index, 1);
	await progress(host, `${card.id} merged (${commit.slice(0, 7)})`);
	await host.save();
	if (card.lane) {
		const lane = card.lane;
		try {
			const landed = await host.ports.git.isAncestor(host.cwd, lane.branch, "HEAD");
			if (!landed) {
				host.ports.notify(
					`Work program: lane ${lane.branch} is not merged into HEAD; keeping worktree and branch for inspection.`,
					"warning",
				);
			} else {
				await host.ports.git.worktreeRemove(host.cwd, lane.path);
				await host.ports.git.branchDelete(host.cwd, lane.branch);
				card.lane = undefined;
			}
		} catch (error) {
			host.ports.notify(`Work program: lane cleanup failed for card ${card.id}: ${oneLine(String(error), 120)}`, "warning");
		}
	}
	host.ports.notify(`Work program: card ${card.id} merged`, "info");
}

/** Finalize a merge that a human or the orchestrator already resolved and committed. */
export async function finishManualMerge(host: DriverHost, card: CardLedger): Promise<void> {
	const commit = await host.ports.git.head(host.cwd);
	card.merge = { state: "merged", commit, attempts: card.merge?.attempts ?? 1 };
	const outcome = await runCardGates(host, card, host.cwd);
	if (!outcome.ok) {
		await startGateFix(host, card, outcome.gates, "merge");
		return;
	}
	await markDoneAndCommit(host, card, [`merge: recorded manually (${commit.slice(0, 7)})`]);
	await finalizeMergedCard(host, card, commit);
}

async function maybeRunProgramGate(host: DriverHost): Promise<void> {
	const ledger = host.ledger;
	if (ledger.status !== "active") return;
	const cards = ledgerCards(ledger);
	if (cards.length === 0) return;
	if (!cards.every((card) => card.phase === "done")) return;
	if (openDecisionFor(ledger)) return;
	const commands = ledger.gates.program;
	if (commands.length === 0) {
		await completeProgram(host, "no program gate configured");
		return;
	}
	const results: GateResult[] = [];
	for (const command of commands) {
		results.push(await host.ports.gates.run(command, host.cwd));
	}
	ledger.programGate = results;
	const failed = results.filter((gate) => gate.code !== 0);
	if (failed.length > 0) {
		createDecision(host, {
			kind: "gate-failed",
			message: programGateDecisionMessage(gateFailures(failed)),
			expectedAction: `work_program({ action: "program_gate", card: "${cards[0]?.id ?? ""}", choice: "retry" | "block" })`,
		});
		return;
	}
	await completeProgram(host, "program gate green");
}

/** Finalize a completed program: record it, clear the way for the UI to go quiet,
 *  and hand the session agent a summary + close question (answered on confirm only). */
async function completeProgram(host: DriverHost, how: string): Promise<void> {
	const ledger = host.ledger;
	ledger.status = "complete";
	await progress(host, `program complete (${how})`);
	await host.ports.git
		.commitPaths(host.cwd, `wp(${ledger.slug}): program complete`, programRecordPaths(host))
		.catch(() => undefined);
	host.ports.notify(`Work program ${ledger.slug} complete`, "info");
	host.ports.ask(programCompleteMessage(ledger));
}

/* ---------------------------------------------------------------------------
 * Tool-facing mutations
 * ------------------------------------------------------------------------- */

export function applyTriage(host: DriverHost, cardId: string, verdicts: FindingVerdict[]): { ok: boolean; error?: string } {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	const decision = openDecisionFor(host.ledger, cardId);
	if (!decision || decision.kind !== "review-triage") {
		return { ok: false, error: `card ${cardId} has no open review decision` };
	}
	const approved = verdicts.filter((verdict) => verdict.verdict === "approve");
	resolveDecision(host, decision.id, { verdicts });
	if (approved.length === 0) {
		card.phase = "approved";
		return { ok: true };
	}
	if (card.cycles >= host.ledger.maxCycles) {
		if (host.ledger.onExhausted === "accept") {
			card.phase = "approved";
			return { ok: true };
		}
		if (host.ledger.onExhausted === "block") {
			card.phase = "blocked";
			card.lastError = `review cycle limit (${host.ledger.maxCycles}) reached with approved findings`;
			return { ok: true };
		}
		card.phase = "triaging";
		createDecision(host, {
			kind: "cycle-exhausted",
			card: cardId,
			summary: `${approved.length} approved finding(s) remain`,
			message: cycleDecisionMessage(cardId, host.ledger.maxCycles),
			expectedAction: `work_program({ action: "cycle_decision", card: "${cardId}", choice: "one_more" | "accept" | "block" })`,
		});
		return { ok: true };
	}
	card.phase = "fixing";
	return { ok: true };
}

export async function applyUnblock(
	host: DriverHost,
	cardId: string,
	resolution: "redispatch" | "done" | "abandon",
): Promise<{ ok: boolean; error?: string }> {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	if (card.phase !== "blocked" && card.phase !== "reconciling") {
		return { ok: false, error: `card ${cardId} is ${card.phase}; only a blocked card can be unblocked` };
	}
	const decision = openDecisionFor(host.ledger, cardId);
	if (decision) resolveDecision(host, decision.id);
	if (resolution === "abandon") {
		card.phase = "blocked";
		card.lastError = "abandoned by operator";
		const index = host.ledger.mergeQueue.indexOf(cardId);
		if (index >= 0) host.ledger.mergeQueue.splice(index, 1);
		await host.ports.git.mergeAbort(host.cwd).catch(() => undefined);
		return { ok: true };
	}
	const reviewed = host.ledger.decisions.some(
		(entry) => entry.card === cardId && entry.kind === "review-triage" && entry.status === "resolved",
	);
	const blockedFrom = card.blockedFrom;
	const needsFix = card.fixReason !== undefined || blockedFrom === "fixing" || blockedFrom === "verifying";
	card.lastError = undefined;
	card.activeRun = undefined;
	card.blockedFrom = undefined;
	if (resolution === "done") {
		if (!reviewed) {
			return { ok: false, error: `card ${cardId} has no completed review; use "redispatch" instead` };
		}
		card.fixReason = undefined;
		if (host.ledger.parallelExecution === "worktrees" && card.lane) {
			card.phase = "approved";
			await finishCard(host, card);
			return { ok: true };
		}
		await completeDirectCard(host, card);
		return { ok: true };
	}
	const unmerged = await host.ports.git.unmergedPaths(host.cwd);
	if (unmerged.length > 0) {
		card.phase = "reconciling";
		await beginReconcile(host, card, { conflicted: unmerged, output: "" }, true);
		return { ok: true };
	}
	if (card.merge?.state === "merged") {
		card.phase = "merging";
		await finishManualMerge(host, card);
		return { ok: true };
	}
	if (host.ledger.parallelExecution === "worktrees" && card.lane) {
		if (needsFix) {
			// A fix was in flight when the card blocked — go back to fixing so the
			// approved findings are actually applied instead of skipped to merge.
			if (card.fixReason === "gate") {
				const failures = (card.gates ?? []).filter((gate) => gate.code !== 0);
				if (failures.length > 0 && (card.gateAttempts ?? 0) <= 3) {
					await startGateFix(host, card, failures, "implementation");
					return { ok: true };
				}
			}
			if (reviewed) {
				card.phase = "fixing";
				return { ok: true };
			}
			card.phase = "pending";
			card.gateAttempts = 0;
			card.fixReason = undefined;
			return { ok: true };
		}
		if (!reviewed) {
			card.phase = "pending";
			card.gateAttempts = 0;
			return { ok: true };
		}
		card.fixReason = undefined;
		card.phase = "approved";
		await finishCard(host, card);
		return { ok: true };
	}
	card.phase = "pending";
	card.gateAttempts = 0;
	card.fixReason = undefined;
	return { ok: true };
}

export function applyCycleDecision(
	host: DriverHost,
	cardId: string,
	choice: "one_more" | "accept" | "block",
): { ok: boolean; error?: string } {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	const decision = openDecisionFor(host.ledger, cardId);
	if (!decision || decision.kind !== "cycle-exhausted") {
		return { ok: false, error: `card ${cardId} has no open cycle decision` };
	}
	resolveDecision(host, decision.id);
	if (choice === "one_more") {
		card.phase = "fixing";
		return { ok: true };
	}
	if (choice === "accept") {
		card.phase = "approved";
		return { ok: true };
	}
	card.phase = "blocked";
	card.lastError = "cycle limit reached; blocked by decision";
	return { ok: true };
}

export function applyProgramGateDecision(
	host: DriverHost,
	choice: "retry" | "block",
): { ok: boolean; error?: string } {
	const decision = openDecisions(host.ledger).find((entry) => entry.kind === "gate-failed");
	if (!decision) return { ok: false, error: "no open program gate decision" };
	resolveDecision(host, decision.id);
	if (choice === "retry") {
		host.ledger.programGate = [];
		return { ok: true };
	}
	host.ledger.status = "paused";
	return { ok: true };
}

export async function dispatchManual(
	host: DriverHost,
	cardId: string,
	role: "worker" | "reviewer" | "reconciler",
): Promise<{ ok: boolean; error?: string }> {
	const card = host.ledger.cards[cardId];
	if (!card) return { ok: false, error: `unknown card ${cardId}` };
	if (card.activeRun) return { ok: false, error: `card ${cardId} already has an active run` };
	if (role === "worker") {
		const depBlocked = card.dependsOn.some((dep) => host.ledger.cards[dep]?.phase !== "done");
		if (depBlocked) return { ok: false, error: `card ${cardId} has unmet dependencies` };
		if (card.phase !== "pending" && card.phase !== "ready" && card.phase !== "blocked") {
			return { ok: false, error: `card ${cardId} is ${card.phase}, not ready for a worker` };
		}
		await startWorkerFor(host, card);
		return { ok: true };
	}
	if (role === "reviewer") {
		const depBlocked = card.dependsOn.some((dep) => host.ledger.cards[dep]?.phase !== "done");
		if (depBlocked) return { ok: false, error: `card ${cardId} has unmet dependencies` };
		if (card.phase !== "review_pending") {
			return { ok: false, error: `card ${cardId} is ${card.phase}; only a pending review can be dispatched` };
		}
		await startReviewFor(host, card);
		return { ok: true };
	}
	const unmerged = await host.ports.git.unmergedPaths(host.cwd);
	if (unmerged.length === 0) {
		return { ok: false, error: `card ${cardId} has no unresolved merge conflict` };
	}
	const decision = openDecisionFor(host.ledger, cardId);
	if (decision) resolveDecision(host, decision.id);
	card.phase = "reconciling";
	await beginReconcile(host, card, { conflicted: unmerged, output: "" }, true);
	return { ok: true };
}

export type { FindingVerdict };

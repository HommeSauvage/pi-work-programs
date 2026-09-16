import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oneLine } from "../shared/text.ts";
import type { ProgramLedger } from "../shared/types.ts";

export const OPERATOR_TODO_REL_PATH = join(".operator", "todo.md");
export const OPERATOR_TODOS_REL_PATH = join(".operator", "todos.json");

export function operatorTodoPath(cwd: string): string {
	return join(cwd, ".operator", "todo.md");
}

export function streamHeading(stream: string): string {
	return `## ${stream}`;
}

/**
 * Verbatim file header. Created once when the file is missing; existing
 * content is never rewritten (agents may only append).
 */
export const OPERATOR_TODO_HEADER = `# Operator todo

Things that need human hands, in checkbox form. Tick a box (\`[x]\`) when an
item is done.

**Rules for agents adding work here:**

- NEVER delete or rewrite existing content — only APPEND new items. (Ticked
  items stay until the operator clears them.)
- This file holds unrelated items from different work streams. Each stream
  gets one \`## <stream name>\` heading; append your item under it (create the
  heading if the stream isn't listed).
- Item format:

  \`\`\`
  ### [ ] Short title - [work program name if any] - [card number if any]
  Short summary of what and why.
  Blocking: yes (when the named card cannot proceed without this; otherwise no)
  1. Exact step, with the exact command to run.
  2. Next step…
  \`\`\`

- This file is the workers' append-only inbox: the supervisor records items
  structurally from here, and humans manage them with \`work_program\`
  todos/todo_add/todo_update/todo_done/todo_drop (never by editing this file).

- Every runnable step names its exact command. If a step can fail
  dangerously, say so and say STOP. Write for a reader with zero context.

---
`;

export interface OperatorTodoItem {
	title: string;
	done: boolean;
}

export interface OperatorTodoSummary {
	open: OperatorTodoItem[];
	done: number;
}

function isSectionHeading(line: string): boolean {
	return /^##(?!#)/.test(line);
}

function headingStream(line: string): string {
	return line.replace(/^##\s*/, "").trim();
}

const ITEM_RE = /^###\s*\[( |x|X)\]\s*(.*)$/;

/**
 * Parse the open/done items under one stream heading. Pure: items outside
 * the stream's section (other streams, preamble) are ignored.
 */
export function parseOperatorTodos(text: string, stream: string): OperatorTodoSummary {
	const open: OperatorTodoItem[] = [];
	let done = 0;
	let inStream = false;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (isSectionHeading(line)) {
			inStream = headingStream(line) === stream;
			continue;
		}
		if (!inStream) continue;
		const match = ITEM_RE.exec(line);
		if (!match) continue;
		const title = (match[2] ?? "").trim();
		if ((match[1] ?? " ").toLowerCase() === "x") {
			done += 1;
		} else {
			open.push({ title: title.length > 0 ? title : "(untitled item)", done: false });
		}
	}
	return { open, done };
}

export function readOperatorTodoFileSync(cwd: string): string | undefined {
	try {
		return readFileSync(operatorTodoPath(cwd), "utf8");
	} catch {
		return undefined;
	}
}

export function summarizeOperatorTodos(cwd: string, stream: string): OperatorTodoSummary | undefined {
	const text = readOperatorTodoFileSync(cwd);
	if (text === undefined) return undefined;
	return parseOperatorTodos(text, stream);
}

/**
 * Create the operator todo file with the verbatim header when it is missing
 * (or empty — nothing to preserve). Never touches existing content.
 * Never throws; reports whether it created the file.
 */
export async function ensureOperatorTodoFile(input: {
	readFile: (path: string) => Promise<string | undefined>;
	writeFile: (path: string, content: string) => Promise<void>;
	cwd: string;
}): Promise<boolean> {
	let existing: string | undefined;
	try {
		existing = await input.readFile(operatorTodoPath(input.cwd));
	} catch {
		return false;
	}
	if (existing !== undefined && existing.trim().length > 0) return false;
	try {
		await input.writeFile(operatorTodoPath(input.cwd), OPERATOR_TODO_HEADER);
		return true;
	} catch {
		return false;
	}
}

/** Structured todo store (`.operator/todos.json`) — the single source of truth.
 *
 *  Why JSON instead of the markdown inbox: stable ids (`op-07`), explicit
 *  open/done/dropped states, blocking-vs-advisory flags, and exact steps with
 *  commands. The markdown file stays only as the workers' append-only inbox
 *  (subagent children have no tools, so they cannot call the todo actions);
 *  the drive imports new inbox entries here automatically. Humans never touch
 *  either file — they use `work_program` todos/todo_add/todo_update/
 *  todo_done/todo_drop, which is also what wakes the drive back up.
 */
export type TodoState = "open" | "done" | "dropped";

export interface TodoStep {
	text: string;
	command?: string;
	dangerous?: boolean;
}

export interface TodoItem {
	id: string;
	title: string;
	body: string;
	steps: TodoStep[];
	stream: string;
	card?: string;
	blocking: boolean;
	state: TodoState;
	createdAt: number;
	updatedAt: number;
	/** Set once the operator has been pinged about this item (no repeat wake-ups). */
	announced?: boolean;
}

export interface TodoStore {
	version: 1;
	counter: number;
	items: TodoItem[];
	/** Content hashes of markdown inbox entries already imported (dedupe). */
	imported: string[];
}

export function operatorTodosJsonPath(cwd: string): string {
	return join(cwd, OPERATOR_TODOS_REL_PATH);
}

export function emptyTodoStore(): TodoStore {
	return { version: 1, counter: 0, items: [], imported: [] };
}

/** Tolerant parse: missing/empty/corrupt storage reads as an empty store (never throws). */
export function parseTodoStore(text: string | undefined): TodoStore {
	if (!text || text.trim().length === 0) return emptyTodoStore();
	try {
		const raw = JSON.parse(text) as { items?: unknown; counter?: unknown; imported?: unknown };
		if (!raw || !Array.isArray(raw.items)) return emptyTodoStore();
		const items: TodoItem[] = [];
		for (const entry of raw.items) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.id !== "string" || typeof record.title !== "string") continue;
			items.push({
				id: record.id,
				title: record.title,
				body: typeof record.body === "string" ? record.body : "",
				steps: Array.isArray(record.steps)
					? (record.steps as Array<Record<string, unknown>>)
							.filter((step) => step && typeof step.text === "string")
							.map((step) => ({
								text: String(step.text),
								...(typeof step.command === "string" && step.command.length > 0 ? { command: step.command } : {}),
								...(step.dangerous === true ? { dangerous: true as const } : {}),
							}))
					: [],
				stream: typeof record.stream === "string" ? record.stream : "",
				...(typeof record.card === "string" && record.card.length > 0 ? { card: record.card } : {}),
				blocking: record.blocking === true,
				state: record.state === "done" || record.state === "dropped" ? record.state : "open",
				createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
				updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
				...(record.announced === true ? { announced: true as const } : {}),
			});
		}
		return {
			version: 1,
			counter: typeof raw.counter === "number" && raw.counter >= 0 ? Math.floor(raw.counter) : items.length,
			items,
			imported: Array.isArray(raw.imported) ? raw.imported.filter((hash): hash is string => typeof hash === "string") : [],
		};
	} catch {
		return emptyTodoStore();
	}
}

export function serializeTodoStore(store: TodoStore): string {
	return `${JSON.stringify(store, null, 2)}\n`;
}

function nextTodoId(store: TodoStore): string {
	store.counter += 1;
	return `op-${String(store.counter).padStart(2, "0")}`;
}

export interface NewTodoInput {
	title: string;
	body?: string;
	steps?: TodoStep[];
	stream: string;
	card?: string;
	blocking?: boolean;
}

/** Append an item, assigning the next stable id. Mutates (and returns) the store. */
export function addTodo(store: TodoStore, input: NewTodoInput): TodoItem {
	const now = Date.now();
	const item: TodoItem = {
		id: nextTodoId(store),
		title: input.title,
		body: input.body ?? "",
		steps: input.steps ?? [],
		stream: input.stream,
		...(input.card ? { card: input.card } : {}),
		blocking: input.blocking === true,
		state: "open",
		createdAt: now,
		updatedAt: now,
	};
	store.items.push(item);
	pruneTodoStore(store);
	return item;
}

export interface UpdateTodoPatch {
	title?: string;
	body?: string;
	steps?: TodoStep[];
	card?: string;
	blocking?: boolean;
}

/** Patch an item's human-facing fields. Returns undefined for unknown ids. */
export function updateTodo(store: TodoStore, id: string, patch: UpdateTodoPatch): TodoItem | undefined {
	const item = store.items.find((entry) => entry.id === id);
	if (!item) return undefined;
	if (patch.title !== undefined) item.title = patch.title;
	if (patch.body !== undefined) item.body = patch.body;
	if (patch.steps !== undefined) item.steps = patch.steps;
	if (patch.blocking !== undefined) item.blocking = patch.blocking;
	if (patch.card !== undefined) {
		if (patch.card.length > 0) item.card = patch.card;
		else delete item.card;
	}
	item.updatedAt = Date.now();
	return item;
}

/** Mark an item done or dropped. Returns undefined for unknown ids. */
export function closeTodo(store: TodoStore, id: string, state: "done" | "dropped"): TodoItem | undefined {
	const item = store.items.find((entry) => entry.id === id);
	if (!item) return undefined;
	item.state = state;
	item.updatedAt = Date.now();
	return item;
}

/** Open items for one stream, blocking first, oldest first. */
export function openTodos(store: TodoStore, stream: string): TodoItem[] {
	return store.items
		.filter((item) => item.stream === stream && item.state === "open")
		.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt);
}

export function openBlockingTodos(store: TodoStore, stream: string): TodoItem[] {
	return openTodos(store, stream).filter((item) => item.blocking);
}

export function openBlockingForCard(store: TodoStore, stream: string, cardId: string): TodoItem[] {
	return openTodos(store, stream).filter((item) => item.blocking && item.card === cardId);
}

function hashString(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
	}
	return hash.toString(16);
}

const INBOX_ITEM_RE = /^###\s*\[( |x|X)\]\s*(.*)$/;
const INBOX_CARD_SUFFIX_RE = /\s*-\s*(\d{1,3}(?:\.\d+)?)\s*$/;
const INBOX_STEP_RE = /^(?:\d+[.)]|[-*])\s+(.*)$/;

interface InboxEntry {
	title: string;
	done: boolean;
	stream: string;
	body: string;
}

/** Split the markdown inbox into per-stream entries (title + trailing body block). */
function parseInboxEntries(mdText: string): InboxEntry[] {
	const entries: InboxEntry[] = [];
	let stream = "";
	let current: InboxEntry | undefined;
	const flush = (): void => {
		if (current) entries.push(current);
		current = undefined;
	};
	for (const rawLine of mdText.split("\n")) {
		const line = rawLine.trimEnd();
		const trimmed = line.trim();
		if (/^##(?!#)/.test(trimmed)) {
			flush();
			stream = trimmed.replace(/^##\s*/, "").trim();
		continue;
	}
		const match = INBOX_ITEM_RE.exec(trimmed);
		if (match) {
			flush();
			current = {
				title: (match[2] ?? "").trim() || "(untitled item)",
				done: (match[1] ?? " ").toLowerCase() === "x",
				stream,
				body: "",
			};
			continue;
		}
		if (current && trimmed.length > 0) {
			current.body = current.body.length > 0 ? `${current.body}\n${trimmed}` : trimmed;
		}
	}
	flush();
	return entries.filter((entry) => entry.stream.length > 0);
}

function inboxEntryHash(entry: InboxEntry): string {
	return hashString(`${entry.stream}\n${entry.title}\n${entry.body}`);
}

/**
 * Import markdown inbox entries not seen before. Pure apart from mutating the
 * passed store: assigns ids, keeps unknown/done cards advisory, and records
 * hashes so re-imports are no-ops. `isLiveCard` decides the blocking default
 * (a named card that is still in play blocks; anything else is advisory).
 */
export function importInboxTodos(
	mdText: string | undefined,
	store: TodoStore,
	isLiveCard: (cardId: string) => boolean,
): { added: TodoItem[]; imported: number } {
	if (!mdText || mdText.trim().length === 0) return { added: [], imported: 0 };
	const seen = new Set(store.imported);
	const added: TodoItem[] = [];
	let imported = 0;
	for (const entry of parseInboxEntries(mdText)) {
		const hash = inboxEntryHash(entry);
		if (seen.has(hash)) continue;
		seen.add(hash);
		store.imported.push(hash);
		imported += 1;
		const cardMatch = INBOX_CARD_SUFFIX_RE.exec(entry.title);
		const card = cardMatch?.[1];
		const live = card !== undefined && isLiveCard(card);
		let blocking = live;
		const steps: TodoStep[] = [];
		const bodyLines: string[] = [];
		for (const line of entry.body.split("\n")) {
			const blockingMatch = /^blocking\s*:\s*(yes|no|true|false|y|n)\s*$/i.exec(line.trim());
			if (blockingMatch) {
				blocking = /^(yes|true|y)$/i.test(blockingMatch[1] ?? "");
				continue;
			}
			const stepMatch = INBOX_STEP_RE.exec(line.trim());
			if (stepMatch) {
				const text = (stepMatch[1] ?? "").trim();
				if (text.length === 0) continue;
				const command = /`([^`]+)`/.exec(text)?.[1]?.trim();
				steps.push({
					text,
					...(command ? { command } : {}),
					...(/\bstop\b/i.test(text) ? { dangerous: true as const } : {}),
				});
				continue;
			}
			bodyLines.push(line.trim());
		}
		if (!live) blocking = false;
		// Strip the conventional ` - stream - card` suffix (bracketed or not) so the
		// structured title stays clean; the stream/card live on as fields.
		let cleanTitle = entry.title.replace(/\s*-\s*\[[^\]]*\](\s*-\s*\[[^\]]*\])?\s*$/, "").trim();
		if (card && cleanTitle.endsWith(card)) {
			cleanTitle = cleanTitle.slice(0, -card.length).replace(/\s*-\s*$/, "").trim();
			if (entry.stream.length > 0 && cleanTitle.endsWith(entry.stream)) {
				cleanTitle = cleanTitle.slice(0, -entry.stream.length).replace(/\s*-\s*$/, "").trim();
			}
		}
		if (cleanTitle.length === 0) cleanTitle = entry.title;
		const now = Date.now();
		const item: TodoItem = {
			id: nextTodoId(store),
			title: cleanTitle,
			body: bodyLines.join("\n").trim(),
			steps,
			stream: entry.stream,
			...(card ? { card } : {}),
			blocking,
			state: entry.done ? "done" : "open",
			createdAt: now,
			updatedAt: now,
		};
		store.items.push(item);
		if (item.state === "open") added.push(item);
	}
	// Bound the dedupe list; collisions only cause a re-import (new id), never loss.
	if (store.imported.length > 500) store.imported = store.imported.slice(-500);
	pruneTodoStore(store);
	return { added, imported };
}

/** Keep every open item plus the most recent closed ones (bounded file). */
function pruneTodoStore(store: TodoStore): void {
	const open = store.items.filter((item) => item.state === "open");
	const closed = store.items
		.filter((item) => item.state !== "open")
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 50);
	store.items = [...open, ...closed].sort((a, b) => a.createdAt - b.createdAt);
}

export interface TodoSummary {
	open: TodoItem[];
	blocking: TodoItem[];
	done: number;
}

export function summarizeStoreForStream(store: TodoStore, stream: string): TodoSummary {
	const open = openTodos(store, stream);
	return { open, blocking: open.filter((item) => item.blocking), done: store.items.filter((item) => item.stream === stream && item.state === "done").length };
}

/** Synchronous read for UI paths (status widget, brief). Never throws. */
export function readTodoStoreSync(cwd: string): TodoStore | undefined {
	try {
		const text = readFileSync(operatorTodosJsonPath(cwd), "utf8");
		return parseTodoStore(text);
	} catch {
		return undefined;
	}
}

/** JSON summary with legacy-markdown fallback (pre-store programs). Never throws. */
export function summarizeTodosSync(cwd: string, stream: string): TodoSummary | undefined {
	try {
		const store = readTodoStoreSync(cwd);
		if (store) return summarizeStoreForStream(store, stream);
	} catch {
		// fall through to the legacy inbox below
	}
	try {
		const legacy = readOperatorTodoFileSync(cwd);
		if (legacy === undefined) return undefined;
		const parsed = parseOperatorTodos(legacy, stream);
		return {
			open: parsed.open.map((item) => ({
				id: "",
				title: item.title,
				body: "",
				steps: [],
				stream,
				blocking: false,
				state: "open" as const,
				createdAt: 0,
				updatedAt: 0,
			})),
			blocking: [],
			done: parsed.done,
		};
	} catch {
		return undefined;
	}
}

/** Coerce tool-supplied steps: plain objects with trimmed text/command (bounded). */
export function normalizeTodoSteps(raw: unknown): TodoStep[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) return [];
	const steps: TodoStep[] = [];
	for (const entry of raw.slice(0, 20)) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const text = typeof record.text === "string" ? record.text.trim().slice(0, 500) : "";
		if (text.length === 0) continue;
		const command = typeof record.command === "string" ? record.command.trim().slice(0, 500) : "";
		steps.push({
			text,
			...(command.length > 0 ? { command } : {}),
			...(record.dangerous === true ? { dangerous: true as const } : {}),
		});
	}
	return steps;
}

/** Human-readable listing for `todos` (blocking first, with exact next actions). */
export function formatTodoList(store: TodoStore, stream: string): string {
	const summary = summarizeStoreForStream(store, stream);
	const lines = [
		`Operator todos — ${stream}: ${summary.open.length} open (${summary.blocking.length} blocking)`,
	];
	if (summary.open.length === 0) lines.push("(none open)");
	for (const item of summary.open) {
		const where = item.card ? `card ${item.card}` : "no card";
		lines.push(
			item.blocking ? `! ${item.id} BLOCKS ${where}: ${item.title}` : `· ${item.id} (${where}): ${item.title}`,
		);
		if (item.body) lines.push(`  ${oneLine(item.body, 200)}`);
		item.steps.slice(0, 8).forEach((step, index) => {
			lines.push(
				`  ${index + 1}. ${oneLine(step.text, 180)}${step.command ? ` — \`${step.command}\`` : ""}${step.dangerous ? " (STOP — may fail dangerously)" : ""}`,
			);
		});
		if (item.steps.length > 8) lines.push(`  … ${item.steps.length - 8} more step(s)`);
		if (item.blocking) lines.push(`  → work_program({ action: "todo_done", id: "${item.id}" }) when finished`);
	}
	lines.push(`Done: ${summary.done} · rewrite via todo_update, complete via todo_done, drop via todo_drop.`);
	return lines.join("\n");
}

/** One-liner for worker/fix/captain prompts: park human-only work, don't guess. */
export function operatorTodoRule(repoRoot: string, stream: string, cardId: string): string {
	return `If you are blocked on something only a human can do (credentials, external approvals, secrets, physical access), do NOT guess or stall: append an item to ${operatorTodoPath(repoRoot)} under \`${streamHeading(stream)}\` (create the heading if it is missing; append-only — never touch other content) in the file's item format naming this program and card (${stream}, ${cardId}) with a \`Blocking: yes\` line when the card cannot proceed without it (\`Blocking: no\` otherwise), then stop and report via contact_supervisor.`;
}

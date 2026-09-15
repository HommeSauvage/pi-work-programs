import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OPERATOR_TODO_REL_PATH = join(".operator", "todo.md");

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
  1. Exact step, with the exact command to run.
  2. Next step…
  \`\`\`

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

/** One-liner for worker/fix/captain prompts: park human-only work, don't guess. */
export function operatorTodoRule(repoRoot: string, stream: string, cardId: string): string {
	return `If you are blocked on something only a human can do (credentials, external approvals, secrets, physical access), do NOT guess or stall: append an item to ${operatorTodoPath(repoRoot)} under \`${streamHeading(stream)}\` (create the heading if it is missing; append-only — never touch other content) in the file's item format naming this program and card (${stream}, ${cardId}), then stop and report via contact_supervisor.`;
}

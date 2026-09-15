import { describe, expect, test } from "bun:test";
import {
	OPERATOR_TODO_HEADER,
	ensureOperatorTodoFile,
	operatorTodoPath,
	operatorTodoRule,
	parseOperatorTodos,
	streamHeading,
} from "../src/program/operator-todos.ts";

describe("operator todo header", () => {
	test("matches the required verbatim shape", () => {
		expect(OPERATOR_TODO_HEADER.startsWith("# Operator todo\n")).toBe(true);
		expect(OPERATOR_TODO_HEADER).toContain("NEVER delete or rewrite existing content — only APPEND new items.");
		expect(OPERATOR_TODO_HEADER).toContain("## <stream name>");
		expect(OPERATOR_TODO_HEADER).toContain("### [ ] Short title - [work program name if any] - [card number if any]");
		expect(OPERATOR_TODO_HEADER).toContain("say STOP");
		expect(OPERATOR_TODO_HEADER.endsWith("---\n")).toBe(true);
	});

	test("stream headings render as h2", () => {
		expect(streamHeading("inference-subscriptions")).toBe("## inference-subscriptions");
	});
});

describe("parseOperatorTodos", () => {
	const text = [
		"# Operator todo",
		"",
		"### [ ] Orphan before any stream — ignored",
		"",
		"## other-stream",
		"### [ ] Someone else's item",
		"",
		"## demo",
		"### [ ] Fix the flaky gate - demo - 01",
		"### [x] Done thing - demo - 01",
		"### [X] Uppercase done - demo - 02",
		"not an item",
		"",
		"## trailing-stream",
		"### [ ] After the stream ends",
		"",
	].join("\n");

	test("counts only its own stream's items", () => {
		const summary = parseOperatorTodos(text, "demo");
		expect(summary.open.map((item) => item.title)).toEqual(["Fix the flaky gate - demo - 01"]);
		expect(summary.done).toBe(2);
	});

	test("ignores other streams and the preamble", () => {
		expect(parseOperatorTodos(text, "other-stream").open).toHaveLength(1);
		expect(parseOperatorTodos(text, "missing").open).toHaveLength(0);
		expect(parseOperatorTodos(text, "missing").done).toBe(0);
	});

	test("headings without a space still match", () => {
		expect(parseOperatorTodos("##demo\n### [ ] Hi\n", "demo").open).toHaveLength(1);
	});

	test("blank titles get a placeholder instead of vanishing", () => {
		const summary = parseOperatorTodos("## demo\n### [ ]\n", "demo");
		expect(summary.open[0]?.title).toBe("(untitled item)");
	});
});

describe("ensureOperatorTodoFile", () => {
	test("creates the file with the header when missing", async () => {
		const files = new Map<string, string>();
		const created = await ensureOperatorTodoFile({
			readFile: async (path) => files.get(path),
			writeFile: async (path, content) => {
				files.set(path, content);
			},
			cwd: "/repo",
		});
		expect(created).toBe(true);
		expect(files.get(operatorTodoPath("/repo"))).toBe(OPERATOR_TODO_HEADER);
	});

	test("leaves existing content alone — even without the header", async () => {
		const files = new Map([[operatorTodoPath("/repo"), "## demo\n### [ ] Keep me\n"]]);
		const created = await ensureOperatorTodoFile({
			readFile: async (path) => files.get(path),
			writeFile: async (path, content) => {
				files.set(path, content);
			},
			cwd: "/repo",
		});
		expect(created).toBe(false);
		expect(files.get(operatorTodoPath("/repo"))).toBe("## demo\n### [ ] Keep me\n");
	});

	test("never throws on hostile storage", async () => {
		const created = await ensureOperatorTodoFile({
			readFile: async () => {
				throw new Error("disk gone");
			},
			writeFile: async () => {
				throw new Error("disk gone");
			},
			cwd: "/repo",
		});
		expect(created).toBe(false);
	});
});

describe("operatorTodoRule", () => {
	test("names the file, stream, and card", () => {
		const rule = operatorTodoRule("/repo", "demo", "03");
		expect(rule).toContain("/repo/.operator/todo.md");
		expect(rule).toContain("## demo");
		expect(rule).toContain("demo, 03");
		expect(rule).toContain("contact_supervisor");
	});
});

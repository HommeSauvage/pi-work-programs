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

describe("todo store", () => {
	test("add assigns stable ids and round-trips", async () => {
		const { addTodo, emptyTodoStore, parseTodoStore, serializeTodoStore } = await import(
			"../src/program/operator-todos.ts"
		);
		const store = emptyTodoStore();
		const first = addTodo(store, { title: "Do the thing", stream: "demo", card: "01", blocking: true });
		const second = addTodo(store, { title: "Advisory", stream: "demo" });
		expect(first.id).toBe("op-01");
		expect(second.id).toBe("op-02");
		expect(first.blocking).toBe(true);
		const reparsed = parseTodoStore(serializeTodoStore(store));
		expect(reparsed.items).toHaveLength(2);
		expect(reparsed.counter).toBe(2);
		expect(reparsed.items[0]?.title).toBe("Do the thing");
	});

	test("tolerant parse of missing and corrupt storage", async () => {
		const { parseTodoStore } = await import("../src/program/operator-todos.ts");
		expect(parseTodoStore(undefined).items).toEqual([]);
		expect(parseTodoStore("").items).toEqual([]);
		expect(parseTodoStore("{broken").items).toEqual([]);
		expect(parseTodoStore('{"items": "nope"}').items).toEqual([]);
	});

	test("update rewrites fields and close resolves", async () => {
		const { addTodo, closeTodo, emptyTodoStore, updateTodo } = await import("../src/program/operator-todos.ts");
		const store = emptyTodoStore();
		const item = addTodo(store, { title: "Hard to understand", stream: "demo", card: "02", blocking: true });
		const updated = updateTodo(store, item.id, {
			title: "Simpler title",
			steps: [{ text: "Run it", command: "bun run it" }],
		});
		expect(updated?.title).toBe("Simpler title");
		expect(updated?.steps).toEqual([{ text: "Run it", command: "bun run it" }]);
		expect(updateTodo(store, "op-99", { title: "x" })).toBeUndefined();
		expect(closeTodo(store, item.id, "done")?.state).toBe("done");
		expect(closeTodo(store, "op-99", "done")).toBeUndefined();
	});

	test("normalizeTodoSteps coerces and bounds", async () => {
		const { normalizeTodoSteps } = await import("../src/program/operator-todos.ts");
		expect(normalizeTodoSteps(undefined)).toBeUndefined();
		expect(normalizeTodoSteps("nope")).toEqual([]);
		const steps = normalizeTodoSteps([
			{ text: "  Run it  ", command: " bun run it ", dangerous: true },
			{ text: "   " },
			"not an object",
		]);
		expect(steps).toEqual([{ text: "Run it", command: "bun run it", dangerous: true }]);
	});
});

describe("inbox import", () => {
	const live = (id: string): boolean => id === "01";

	test("a named live card blocks by default; steps and commands survive", async () => {
		const { emptyTodoStore, importInboxTodos } = await import("../src/program/operator-todos.ts");
		const store = emptyTodoStore();
		const md = [
			"## demo",
			"### [ ] Fetch the prod secret - demo - 01",
			"The agent has no vault access.",
			"1. Run `vault read prod`.",
			"2. STOP if it asks to overwrite.",
			"",
		].join("\n");
		const { added, imported } = importInboxTodos(md, store, live);
		expect(imported).toBe(1);
		expect(added).toHaveLength(1);
		expect(added[0]?.id).toBe("op-01");
		expect(added[0]?.title).toBe("Fetch the prod secret");
		expect(added[0]?.card).toBe("01");
		expect(added[0]?.blocking).toBe(true);
		expect(added[0]?.body).toContain("no vault access");
		expect(added[0]?.steps[0]).toEqual({ text: "Run `vault read prod`.", command: "vault read prod" });
		expect(added[0]?.steps[1]?.dangerous).toBe(true);
	});

	test("explicit Blocking: no and unknown cards stay advisory", async () => {
		const { emptyTodoStore, importInboxTodos } = await import("../src/program/operator-todos.ts");
		const store = emptyTodoStore();
		const md = [
			"## demo",
			"### [ ] Optional polish - demo - 01",
			"Blocking: no",
			"### [ ] Ghost card item - demo - 09",
			"",
		].join("\n");
		const { added } = importInboxTodos(md, store, live);
		expect(added.map((item) => item.blocking)).toEqual([false, false]);
		expect(added[1]?.card).toBe("09");
	});

	test("re-imports are no-ops and done markers import as done", async () => {
		const { emptyTodoStore, importInboxTodos } = await import("../src/program/operator-todos.ts");
		const store = emptyTodoStore();
		const md = ["## demo", "### [ ] Same thing - demo - 01", "", "### [x] Old thing", ""].join("\n");
		expect(importInboxTodos(md, store, live).imported).toBe(2);
		expect(importInboxTodos(md, store, live).imported).toBe(0);
		expect(store.items).toHaveLength(2);
		expect(store.items.find((item) => item.title === "Old thing")?.state).toBe("done");
	});

	test("formatTodoList leads with blockers and next actions", async () => {
		const { addTodo, emptyTodoStore, formatTodoList } = await import("../src/program/operator-todos.ts");
		const store = emptyTodoStore();
		addTodo(store, { title: "Secret", stream: "demo", card: "01", blocking: true });
		addTodo(store, { title: "Nice to have", stream: "demo" });
		const text = formatTodoList(store, "demo");
		expect(text).toContain("2 open (1 blocking)");
		expect(text).toContain("! op-01 BLOCKS card 01: Secret");
		expect(text).toContain('todo_done", id: "op-01"');
	});
});

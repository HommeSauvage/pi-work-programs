import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	sortPaneTodos,
	WorkProgramTodosComponent,
	type ActionResultLike,
	type TodosPaneHost,
} from "../src/tui/todos-pane.ts";
import type { TodoItem } from "../src/program/operator-todos.ts";

type Theme = ExtensionContext["ui"]["theme"];

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function todo(overrides: Partial<TodoItem> & { id: string }): TodoItem {
	return {
		title: `Title for ${overrides.id}`,
		body: "",
		steps: [],
		stream: "test-program",
		blocking: false,
		state: "open",
		createdAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	};
}

interface HostCall {
	method: string;
	args: unknown;
}

function fakeHost(items: TodoItem[], stream = "test-program"): TodosPaneHost & { calls: HostCall[] } {
	const calls: HostCall[] = [];
	const ok = (text: string): ActionResultLike => ({ ok: true, text });
	return {
		calls,
		todoSnapshot: async () => ({ ok: true, stream, items: [...items] }),
		todoAdd: async (input) => {
			calls.push({ method: "todoAdd", args: input });
			return ok(`added ${input.title}`);
		},
		todoDone: async (input) => {
			calls.push({ method: "todoDone", args: input });
			return ok(`todo ${input.id} done`);
		},
		todoDrop: async (input) => {
			calls.push({ method: "todoDrop", args: input });
			return ok(`todo ${input.id} dropped`);
		},
		todoReopen: async (id) => {
			calls.push({ method: "todoReopen", args: id });
			return ok(`todo ${id} reopened`);
		},
	};
}

/** Build the component and settle its first async snapshot load. */
async function makePane(items: TodoItem[]) {
	const host = fakeHost(items);
	let closed = 0;
	const component = new WorkProgramTodosComponent(
		{ terminal: { rows: 40 }, requestRender() {} },
		THEME,
		host,
		() => {
			closed += 1;
		},
		{ refreshMs: 3_600_000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { component, host, closedCount: () => closed };
}

function rendered(component: WorkProgramTodosComponent, width = 100): string {
	return component.render(width).join("\n");
}

describe("sortPaneTodos", () => {
	test("filters to the stream and orders open (blocking first) before done before dropped", () => {
		const items = [
			todo({ id: "op-05", stream: "other", title: "another stream" }),
			todo({ id: "op-03", state: "dropped", updatedAt: 500 }),
			todo({ id: "op-02", state: "done", updatedAt: 900 }),
			todo({ id: "op-04", createdAt: 4_000 }),
			todo({ id: "op-01", blocking: true, card: "01" }),
			todo({ id: "op-02b", state: "done", updatedAt: 2_000 }),
		];
		expect(sortPaneTodos(items, "test-program").map((item) => item.id)).toEqual([
			"op-01", // blocking open first
			"op-04", // open by createdAt
			"op-02b", // done, newest first
			"op-02",
			"op-03", // dropped last
		]);
	});
});

describe("WorkProgramTodosComponent", () => {
	test("renders the stream, roster, and selected detail with steps", async () => {
		const { component } = await makePane([
			todo({
				id: "op-01",
				title: "Fetch the prod secret",
				blocking: true,
				card: "01",
				body: "The agent has no vault access.",
				steps: [{ text: "Run the rotation", command: "vault rotate prod", dangerous: true }],
			}),
			todo({ id: "op-02", title: "Nice polish" }),
		]);
		const text = rendered(component);
		expect(text).toContain("Operator todos");
		expect(text).toContain("test-program");
		expect(text).toContain("op-01");
		expect(text).toContain("Fetch the prod secret");
		expect(text).toContain("BLOCKS");
		expect(text).toContain("The agent has no vault access.");
		expect(text).toContain("Steps:");
		expect(text).toContain("vault rotate prod");
		expect(text).toContain("STOP");
		expect(text).toContain("1/2");
	});

	test("d marks the selected open todo done", async () => {
		const { component, host } = await makePane([
			todo({ id: "op-01", title: "First" }),
			todo({ id: "op-02", title: "Second" }),
		]);
		component.handleInput("d");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.calls).toEqual([{ method: "todoDone", args: { id: "op-01" } }]);
		expect(rendered(component)).toContain("todo op-01 done");
	});

	test("X requires confirmation before dropping", async () => {
		const { component, host } = await makePane([todo({ id: "op-01", title: "First" })]);
		component.handleInput("X");
		expect(host.calls).toHaveLength(0);
		expect(rendered(component)).toContain("Drop op-01");
		component.handleInput("y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.calls).toEqual([{ method: "todoDrop", args: { id: "op-01" } }]);
	});

	test("any non-confirm key cancels the drop prompt", async () => {
		const { component, host } = await makePane([todo({ id: "op-01", title: "First" })]);
		component.handleInput("X");
		component.handleInput("n");
		expect(host.calls).toHaveLength(0);
		expect(rendered(component)).not.toContain("Drop op-01");
	});

	test("u reopens a done todo selected via j", async () => {
		const { component, host } = await makePane([
			todo({ id: "op-01", title: "Open item" }),
			todo({ id: "op-02", title: "Finished item", state: "done", updatedAt: 2_000 }),
		]);
		component.handleInput("j"); // select op-02
		component.handleInput("u");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.calls).toEqual([{ method: "todoReopen", args: "op-02" }]);
	});

	test("d on a closed todo shows guidance instead of acting", async () => {
		const { component, host } = await makePane([todo({ id: "op-01", title: "Finished", state: "done", updatedAt: 2_000 })]);
		component.handleInput("d");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.calls).toHaveLength(0);
		expect(rendered(component)).toContain("Select an open todo to mark done.");
	});

	test("a opens a title editor; typing and Enter adds an advisory todo", async () => {
		const { component, host } = await makePane([todo({ id: "op-01", title: "Existing" })]);
		component.handleInput("a");
		expect(rendered(component)).toContain("New todo title:");
		for (const char of "Renew certs") component.handleInput(char);
		component.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.calls).toEqual([{ method: "todoAdd", args: { title: "Renew certs" } }]);
	});

	test("escape closes the pane", async () => {
		const { component, closedCount } = await makePane([todo({ id: "op-01", title: "First" })]);
		component.handleInput("\x1b");
		expect(closedCount()).toBe(1);
	});

	test("selection follows the same todo across refreshes", async () => {
		const items = [todo({ id: "op-01", title: "First" }), todo({ id: "op-02", title: "Second" })];
		const { component } = await makePane(items);
		component.handleInput("j"); // select op-02
		// New snapshot inserts a blocking todo that sorts before op-02.
		items.push(todo({ id: "op-03", title: "Urgent", blocking: true, card: "01" }));
		component.invalidate();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rendered(component)).toContain("3/3");
	});

	test("renders an error banner when the snapshot fails", async () => {
		let closed = 0;
		const component = new WorkProgramTodosComponent(
			{ terminal: { rows: 40 }, requestRender() {} },
			THEME,
			{
				todoSnapshot: async () => {
					throw new Error("disk on fire");
				},
				todoAdd: async () => ({ ok: false, text: "" }),
				todoDone: async () => ({ ok: false, text: "" }),
				todoDrop: async () => ({ ok: false, text: "" }),
				todoReopen: async () => ({ ok: false, text: "" }),
			},
			() => {
				closed += 1;
			},
			{ refreshMs: 3_600_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rendered(component)).toContain("disk on fire");
		component.handleInput("\x1b");
		expect(closed).toBe(1);
	});
});

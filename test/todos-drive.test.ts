import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyUnblock, drive } from "../src/engine/driver.ts";
import {
	addTodo,
	emptyTodoStore,
	parseTodoStore,
	serializeTodoStore,
} from "../src/program/operator-todos.ts";
import { createTestHost, makeCardText } from "./helpers.ts";

const PROGRAM_DIR = "/repo/.agents/work-programs/test-program";
const TODOS_PATH = "/repo/.operator/todos.json";

function seedBlocking(t: ReturnType<typeof createTestHost>, title = "Fetch the prod secret", card = "01"): string {
	const store = emptyTodoStore();
	const item = addTodo(store, { title, stream: "test-program", card, blocking: true });
	t.fake.files.set(TODOS_PATH, serializeTodoStore(store));
	return item.id;
}

function readStoreIds(t: ReturnType<typeof createTestHost>): string[] {
	return parseTodoStore(t.fake.files.get(TODOS_PATH)).items.map((item) => item.id);
}

function writeLaneEvidence(host: ReturnType<typeof createTestHost>, cardId: string, evidence: string): void {
	host.fake.files.set(
		join(PROGRAM_DIR, `tasks/${cardId}-card.md`),
		makeCardText({ id: cardId, evidence, state: "review" }),
	);
}

describe("blocking operator todos", () => {
	test("a waiting card is never dispatched (worker, review, or fix)", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		seedBlocking(t);
		await drive(t.host);
		expect(t.fake.dispatched).toHaveLength(0);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(t.ledger.cards["01"]?.waitingOn).toEqual(["op-01"]);
		expect(t.ledger.cards["01"]?.lastError).toContain("waiting on operator todo op-01");
	});

	test("a todo that arrives mid-run parks the card on completion instead of reviewing", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("implementing");
		const id = seedBlocking(t);
		writeLaneEvidence(t, "01", "$ bun test\npass");
		t.completeRun(t.fake.dispatched[0]!.runId, { output: "done" });
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.phase).toBe("blocked");
		expect(card.waitingOn).toEqual([id]);
		expect(t.fake.dispatched.some((entry) => entry.request.kind === "reviewer")).toBe(false);
	});

	test("inbox imports park once and never re-announce", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.files.set(
			"/repo/.operator/todo.md",
			["# Operator todo", "", "## test-program", "### [ ] Prod secret - test-program - 01", "Blocking: yes", ""].join(
				"\n",
			),
		);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		expect(readStoreIds(t)).toEqual(["op-01"]);
		const asked = t.fake.asked.filter((message) => message.includes("op-01"));
		expect(asked.length).toBeGreaterThan(0);
		const announced = parseTodoStore(t.fake.files.get(TODOS_PATH)).items[0]?.announced;
		expect(announced).toBe(true);
		await drive(t.host);
		expect(t.fake.asked.filter((message) => message.includes("op-01"))).toHaveLength(asked.length);
		expect(readStoreIds(t)).toEqual(["op-01"]);
	});

	test("advisory inbox items notify without parking", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		t.fake.files.set(
			"/repo/.operator/todo.md",
			["# Operator todo", "", "## test-program", "### [ ] Nice polish - test-program - 01", "Blocking: no", ""].join(
				"\n",
			),
		);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("implementing");
		expect(t.fake.notifications.some((note) => note.includes("op-01"))).toBe(true);
		expect(t.fake.asked.some((message) => message.includes("op-01"))).toBe(false);
	});

	test("resolving the todo rearms the card and clears the decision", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const id = seedBlocking(t);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
		const store = parseTodoStore(t.fake.files.get(TODOS_PATH));
		store.items.find((item) => item.id === id)!.state = "done";
		t.fake.files.set(TODOS_PATH, serializeTodoStore(store));
		await drive(t.host);
		const card = t.ledger.cards["01"]!;
		expect(card.waitingOn).toBeUndefined();
		expect(card.phase).toBe("implementing");
		expect(card.activeRun?.kind).toBe("worker");
		expect(t.ledger.decisions.find((entry) => entry.kind === "blocked")?.status).toBe("resolved");
	});

	test("an approved card holds its merge while waiting", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		const card = t.ledger.cards["01"]!;
		card.phase = "approved";
		card.lane = { path: "/wt/test-program/01", branch: "feat/foo-card-01", base: "base0" };
		seedBlocking(t);
		await drive(t.host);
		expect(t.git.commits).toHaveLength(0);
		expect(t.ledger.cards["01"]?.phase).toBe("blocked");
	});

	test("unblock redispatch overrides waiting and clears the marker", async () => {
		const t = createTestHost({ cards: [{ id: "01" }] });
		seedBlocking(t);
		await drive(t.host);
		expect(t.ledger.cards["01"]?.waitingOn).toEqual(["op-01"]);
		const result = await applyUnblock(t.host, "01", "redispatch");
		expect(result.ok).toBe(true);
		expect(t.ledger.cards["01"]?.waitingOn).toBeUndefined();
		expect(t.ledger.cards["01"]?.phase).toBe("pending");
	});
});

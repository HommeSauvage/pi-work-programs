import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import type { TodoItem, TodoSnapshot } from "../program/operator-todos.ts";
import { formatAgo } from "../shared/text.ts";

/**
 * Interactive overlay pane for operator todos, modeled on the subagent fleet
 * inspector (`pi-subagents` src/tui/fleet.ts): a bordered two-pane window that
 * takes keyboard focus away from the streaming chat, refreshes itself while
 * open, and lets the operator act (done / drop / reopen / quick-add) without
 * touching the janky inline rendering.
 */

const REFRESH_MS = 1000;
const MIN_REFRESH_MS = 250;

export interface ActionResultLike {
	ok: boolean;
	text: string;
}

/** Structural surface of WorkProgramController the pane needs (keeps the pane testable). */
export interface TodosPaneHost {
	todoSnapshot(): Promise<TodoSnapshot>;
	todoAdd(input: { title: string }): Promise<ActionResultLike>;
	todoDone(input: { id: string; note?: string }): Promise<ActionResultLike>;
	todoDrop(input: { id: string; reason?: string }): Promise<ActionResultLike>;
	todoReopen(id: string): Promise<ActionResultLike>;
}

type Theme = ExtensionContext["ui"]["theme"];
type PaneTui = {
	terminal?: { rows: number };
	requestRender(): void;
};

export interface TodosPaneOptions {
	refreshMs?: number;
}

/** Open items first (blocking first, oldest first), then done, then dropped — newest first. */
export function sortPaneTodos(items: TodoItem[], stream: string): TodoItem[] {
	const rank = (item: TodoItem): number => (item.state === "open" ? 0 : item.state === "done" ? 1 : 2);
	return items
		.filter((item) => item.stream === stream)
		.sort(
			(left, right) =>
				rank(left) - rank(right)
				|| Number(right.blocking) - Number(left.blocking)
				|| (left.state === "open" ? left.createdAt - right.createdAt : right.updatedAt - left.updatedAt)
				|| left.id.localeCompare(right.id),
		);
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

function statusGlyph(item: TodoItem, theme: Theme): string {
	if (item.state === "open") return item.blocking ? theme.fg("warning", "!") : theme.fg("muted", "·");
	if (item.state === "done") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

export class WorkProgramTodosComponent implements Component {
	private items: TodoItem[] = [];
	private stream = "";
	private error: string | undefined;
	private loaded = false;
	private selected = 0;
	private selectedId: string | undefined;
	private dropConfirming = false;
	private addDraft: string | undefined;
	private actionBusy = false;
	private actionNotice: ActionResultLike | undefined;
	private detailScroll = 0;
	private detailAutoFollow = true;
	private detailLineCount = 0;
	private detailViewportHeight = 8;
	private bodyHeight = 8;
	private disposed = false;
	private loadToken = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly refreshMs: number;
	private readonly tui: PaneTui;
	private readonly theme: Theme;
	private readonly host: TodosPaneHost;
	private readonly done: (result: undefined) => void;

	constructor(
		tui: PaneTui,
		theme: Theme,
		host: TodosPaneHost,
		done: (result: undefined) => void,
		options: TodosPaneOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.host = host;
		this.done = done;
		this.refreshMs = Math.max(MIN_REFRESH_MS, options.refreshMs ?? REFRESH_MS);
		this.load();
		this.scheduleRefresh();
	}

	/* ---- data ---- */

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			if (this.disposed) return;
			this.load();
			this.scheduleRefresh();
		}, this.refreshMs);
		this.refreshTimer.unref?.();
	}

	private stop(): void {
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	/** Reload the store off the hot path; the newest request wins. */
	private load(): void {
		const token = ++this.loadToken;
		void this.host
			.todoSnapshot()
			.then((snapshot) => {
				if (token !== this.loadToken || this.disposed) return;
				this.applySnapshot(snapshot);
			})
			.catch((error: unknown) => {
				if (token !== this.loadToken || this.disposed) return;
				this.loaded = true;
				this.error = error instanceof Error ? error.message : String(error);
				this.tui.requestRender();
			});
	}

	private applySnapshot(snapshot: TodoSnapshot): void {
		this.loaded = true;
		if (!snapshot.ok) {
			this.error = snapshot.error;
			this.tui.requestRender();
			return;
		}
		this.error = undefined;
		this.stream = snapshot.stream;
		this.items = sortPaneTodos(snapshot.items, snapshot.stream);
		const index = this.selectedId ? this.items.findIndex((item) => item.id === this.selectedId) : -1;
		this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, this.items.length - 1));
		this.selectedId = this.items[this.selected]?.id;
		this.tui.requestRender();
	}

	/* ---- interaction ---- */

	private selectedOpenItem(): TodoItem | undefined {
		const item = this.items[this.selected];
		return item && item.state === "open" ? item : undefined;
	}

	private selectedClosedItem(): TodoItem | undefined {
		const item = this.items[this.selected];
		return item && item.state !== "open" ? item : undefined;
	}

	private moveSelection(delta: number): void {
		if (this.items.length === 0) return;
		this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
		this.selectedId = this.items[this.selected]?.id;
		this.dropConfirming = false;
		this.detailScroll = 0;
		this.detailAutoFollow = true;
		this.tui.requestRender();
	}

	private jumpSelection(last: boolean): void {
		if (this.items.length === 0) return;
		this.selected = last ? this.items.length - 1 : 0;
		this.selectedId = this.items[this.selected]?.id;
		this.dropConfirming = false;
		this.detailScroll = 0;
		this.detailAutoFollow = true;
		this.tui.requestRender();
	}

	private runAction(action: () => Promise<ActionResultLike>): void {
		if (this.actionBusy) return;
		this.actionBusy = true;
		this.actionNotice = undefined;
		this.dropConfirming = false;
		this.tui.requestRender();
		void action()
			.then((result) => {
				this.actionNotice = result;
				this.load();
			})
			.catch((error: unknown) => {
				this.actionNotice = { ok: false, text: error instanceof Error ? error.message : String(error) };
			})
			.finally(() => {
				this.actionBusy = false;
				if (!this.disposed) this.tui.requestRender();
			});
	}

	private scrollDetail(delta: number): void {
		const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
		this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll + delta));
		this.detailAutoFollow = this.detailScroll >= maxScroll;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.addDraft !== undefined) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.addDraft = undefined;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "return") || data === "\r" || data === "\n") {
				const title = this.addDraft.trim();
				this.addDraft = undefined;
				if (title.length === 0) {
					this.actionNotice = { ok: false, text: "Todo title cannot be empty." };
					this.tui.requestRender();
					return;
				}
				this.runAction(() => this.host.todoAdd({ title }));
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f") {
				this.addDraft = this.addDraft.slice(0, -1);
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.addDraft += data;
				this.tui.requestRender();
			}
			return;
		}
		if (this.dropConfirming) {
			const item = this.selectedOpenItem();
			this.dropConfirming = false;
			if (matchesKey(data, "return") || data === "y" || data === "Y") {
				if (item) this.runAction(() => this.host.todoDrop({ id: item.id }));
				return;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.stop();
			this.done(undefined);
			return;
		}
		if (data === "j" || matchesKey(data, "down")) return this.moveSelection(1);
		if (data === "k" || matchesKey(data, "up")) return this.moveSelection(-1);
		if (matchesKey(data, "home") || data === "g") return this.jumpSelection(false);
		if (matchesKey(data, "end") || data === "G") return this.jumpSelection(true);
		if (matchesKey(data, "pageUp")) return this.moveSelection(-(this.bodyHeight - 2));
		if (matchesKey(data, "pageDown")) return this.moveSelection(this.bodyHeight - 2);
		if (matchesKey(data, "shift+j")) return this.scrollDetail(1);
		if (matchesKey(data, "shift+k")) return this.scrollDetail(-1);
		if (data === "r" || data === "R") {
			this.load();
			return;
		}
		if (this.actionBusy) return;
		if (data === "d") {
			const item = this.selectedOpenItem();
			if (!item) {
				this.actionNotice = { ok: false, text: "Select an open todo to mark done." };
				this.tui.requestRender();
				return;
			}
			this.runAction(() => this.host.todoDone({ id: item.id }));
			return;
		}
		if (matchesKey(data, "shift+x")) {
			const item = this.selectedOpenItem();
			if (!item) {
				this.actionNotice = { ok: false, text: "Select an open todo to drop." };
				this.tui.requestRender();
				return;
			}
			this.dropConfirming = true;
			this.tui.requestRender();
			return;
		}
		if (data === "u") {
			const item = this.selectedClosedItem();
			if (!item) {
				this.actionNotice = { ok: false, text: "Select a done or dropped todo to reopen." };
				this.tui.requestRender();
				return;
			}
			this.runAction(() => this.host.todoReopen(item.id));
			return;
		}
		if (data === "a") {
			this.addDraft = "";
			this.tui.requestRender();
			return;
		}
	}

	/* ---- rendering ---- */

	private counts(): { open: number; blocking: number; done: number; dropped: number } {
		const counts = { open: 0, blocking: 0, done: 0, dropped: 0 };
		for (const item of this.items) {
			if (item.state === "open") {
				counts.open += 1;
				if (item.blocking) counts.blocking += 1;
			} else if (item.state === "done") counts.done += 1;
			else counts.dropped += 1;
		}
		return counts;
	}

	private rosterLines(width: number): string[] {
		if (!this.loaded) return [this.theme.fg("dim", "Loading…")];
		if (this.items.length === 0) {
			return [this.error ? this.theme.fg("error", this.error) : this.theme.fg("dim", "No operator todos")];
		}
		const start = Math.max(
			0,
			Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.items.length - this.bodyHeight)),
		);
		return this.items.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const marker = index === this.selected ? this.theme.fg("accent", "›") : " ";
			const title = index === this.selected ? this.theme.bold(item.title) : item.title;
			const left = `${marker} ${statusGlyph(item, this.theme)} ${this.theme.fg("dim", item.id)} ${title}`;
			const right = this.theme.fg("dim", item.state === "open" ? (item.blocking ? "blocking" : "") : item.state);
			return rightAligned(left, right, width);
		});
	}

	private detailLines(width: number): { header: string[]; body: string[] } {
		if (this.error) return { header: [this.theme.fg("error", this.error)], body: [] };
		const item = this.items[this.selected];
		if (!item) return { header: [], body: [] };
		const badges = [
			item.state === "open" ? (item.blocking ? "BLOCKS" : "open") : item.state,
			item.card ? `card ${item.card}` : undefined,
			item.stream.length > 0 ? item.stream : undefined,
		].filter((badge): badge is string => badge !== undefined);
		const header = [
			`${this.theme.bold(item.id)} ${this.theme.fg("dim", `· ${badges.join(" · ")}`)}`,
			this.theme.fg("dim", `created ${formatAgo(item.createdAt)} · updated ${formatAgo(item.updatedAt)}`),
		];
		const body: string[] = [];
		if (item.body.length > 0) {
			body.push(...wrapTextWithAnsi(item.body, width), "");
		}
		if (item.steps.length > 0) {
			body.push(this.theme.fg("dim", "Steps:"));
			item.steps.forEach((step, index) => {
				const text = `${index + 1}. ${step.text}${step.command ? ` — ${step.command}` : ""}`;
				const wrapped = wrapTextWithAnsi(text, Math.max(1, width - 2));
				body.push(`  ${wrapped[0] ?? ""}`);
				for (const line of wrapped.slice(1)) body.push(`    ${line}`);
				if (step.dangerous) body.push(this.theme.fg("warning", "    ⚠ STOP — this step may fail dangerously"));
			});
			body.push("");
		}
		if (item.state !== "open") {
			body.push(this.theme.fg("dim", `This todo is ${item.state} — press u to reopen it.`));
		}
		return { header, body };
	}

	private statusLines(): string[] {
		if (this.addDraft !== undefined) {
			return [
				this.theme.fg("accent", `New todo title: ${this.addDraft}${this.theme.fg("dim", "▌")}`),
				this.theme.fg("dim", "Enter adds (advisory, no card) · Esc cancels · Backspace edits — use the agent/chat for cards, steps, and blocking"),
			];
		}
		if (this.dropConfirming) {
			const item = this.selectedOpenItem();
			return [
				this.theme.fg("warning", `Drop ${item?.id ?? "selected todo"} without doing the work?`),
				this.theme.fg("dim", "Enter/Y confirms · any other key cancels"),
			];
		}
		if (this.actionBusy) return [this.theme.fg("accent", "Action pending…")];
		if (this.actionNotice) {
			return [this.theme.fg(this.actionNotice.ok ? "success" : "error", this.actionNotice.text)];
		}
		return [];
	}

	render(width: number): string[] {
		if (width < 40) return [truncateToWidth("Operator todos needs at least 40 columns. Esc closes.", width)];
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		this.bodyHeight = Math.max(3, Math.floor(rows * 0.85) - 7);
		const rosterWidth = Math.max(26, Math.min(48, Math.floor((innerWidth - 1) * 0.42)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const roster = this.rosterLines(rosterWidth);
		const detail = this.detailLines(detailWidth);
		const header = detail.header.slice(0, Math.max(0, this.bodyHeight - 1));
		this.detailViewportHeight = Math.max(1, this.bodyHeight - header.length);
		this.detailLineCount = detail.body.length;
		const maxScroll = Math.max(0, detail.body.length - this.detailViewportHeight);
		if (this.detailAutoFollow) this.detailScroll = maxScroll;
		else if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		const visibleDetail = [
			...header,
			...detail.body.slice(this.detailScroll, this.detailScroll + this.detailViewportHeight),
		];
		const counts = this.counts();
		const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		const title = ` ${this.theme.bold("Operator todos")}${this.stream ? this.theme.fg("dim", ` · ${this.stream}`) : ""} `;
		const summary = `${counts.open} open${counts.blocking > 0 ? ` · ${counts.blocking} blocking` : ""}${counts.done > 0 ? ` · ${counts.done} done` : ""}${counts.dropped > 0 ? ` · ${counts.dropped} dropped` : ""} `;
		lines.push(this.theme.fg("border", "│") + rightAligned(title, this.theme.fg("dim", summary), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
		for (let index = 0; index < this.bodyHeight; index += 1) {
			lines.push(
				this.theme.fg("border", "│")
				+ fit(roster[index] ?? "", rosterWidth)
				+ this.theme.fg("border", "│")
				+ fit(visibleDetail[index] ?? "", detailWidth)
				+ this.theme.fg("border", "│"),
			);
		}
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
		const status = this.statusLines();
		for (const line of status.length > 0 ? status : [""]) {
			lines.push(this.theme.fg("border", "│") + fit(line.length > 0 ? ` ${line}` : "", innerWidth) + this.theme.fg("border", "│"));
		}
		const position = this.items.length ? `${this.selected + 1}/${this.items.length}` : "0/0";
		const footer = ` ↑/↓ move · d done · X drop · u reopen · a add · r refresh · J/K scroll · Esc close · ${position}`;
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.load();
	}

	dispose(): void {
		this.stop();
	}
}

/** Open the operator todos pane as a centered overlay (like the subagent fleet inspector). */
export async function openTodosPane(
	ctx: ExtensionContext,
	host: TodosPaneHost,
	options: TodosPaneOptions = {},
): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => new WorkProgramTodosComponent(tui, theme, host, done, options),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
		},
	);
}

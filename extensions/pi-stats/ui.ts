/**
 * Interactive TUI report for pi-stats.
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	fmtCompact,
	fmtCost,
	fmtDate,
	fmtDateTime,
	fmtDuration,
	fmtInt,
	type DayRow,
	type Report,
} from "./report.ts";

const TABS = ["Overview", "Models", "Activity", "Projects", "Tools", "Sessions"] as const;

function padRight(s: string, w: number): string {
	if (w <= 0) return "";
	if (visibleWidth(s) > w) return truncateToWidth(s, w);
	return s + " ".repeat(w - visibleWidth(s));
}

function padLeft(s: string, w: number): string {
	if (w <= 0) return "";
	if (visibleWidth(s) > w) return truncateToWidth(s, w);
	return " ".repeat(w - visibleWidth(s)) + s;
}

function bar(value: number, max: number, width: number, theme: any): string {
	const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
	const f = Math.min(width, filled);
	return theme.fg("accent", "█".repeat(f)) + theme.fg("dim", "░".repeat(Math.max(0, width - f)));
}

export interface StatsViewOptions {
	report: Report;
	theme: any;
	tui: TUI;
	rangeLabels: string[];
	rangeIndex: number;
	onCycleRange: (direction: number) => Promise<Report | null>;
	onRescan: () => Promise<Report | null>;
	done: () => void;
}

export class StatsView implements Component {
	private report: Report;
	private theme: any;
	private tui: TUI;
	private rangeLabels: string[];
	private rangeIndex: number;
	private onCycleRange: (direction: number) => Promise<Report | null>;
	private onRescan: () => Promise<Report | null>;
	private done: () => void;
	private tab = 0;
	private scroll = 0;

	loading = false;

	constructor(opts: StatsViewOptions) {
		this.report = opts.report;
		this.theme = opts.theme;
		this.tui = opts.tui;
		this.rangeLabels = opts.rangeLabels;
		this.rangeIndex = opts.rangeIndex;
		this.onCycleRange = opts.onCycleRange;
		this.onRescan = opts.onRescan;
		this.done = opts.done;
	}

	setReport(report: Report, rangeIndex: number): void {
		this.report = report;
		this.rangeIndex = rangeIndex;
		this.scroll = 0;
		this.loading = false;
		this.tui.requestRender();
	}

	invalidate(): void {
		/* stateless rendering */
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) {
			this.done();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.tab = (this.tab + TABS.length - 1) % TABS.length;
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l") || matchesKey(data, "tab")) {
			this.tab = (this.tab + 1) % TABS.length;
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, "1")) this.tab = 0;
		if (matchesKey(data, "2")) this.tab = 1;
		if (matchesKey(data, "3")) this.tab = 2;
		if (matchesKey(data, "4")) this.tab = 3;
		if (matchesKey(data, "5")) this.tab = 4;
		if (matchesKey(data, "6")) this.tab = 5;
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.scroll = Math.max(0, this.scroll - 1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) this.scroll += 1;
		if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 10);
		if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll += 10;
		if (matchesKey(data, "home") || matchesKey(data, "g")) this.scroll = 0;
		if (matchesKey(data, "end")) this.scroll = 9999;
		if (matchesKey(data, "d") || matchesKey(data, "]")) void this.cycleRange(1);
		if (matchesKey(data, "[")) void this.cycleRange(-1);
		if (matchesKey(data, "r")) void this.rescan();
		this.tui.requestRender();
	}

	private async cycleRange(direction: number): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.tui.requestRender();
		const report = await this.onCycleRange(direction);
		if (report) this.setReport(report, (this.rangeIndex + direction + this.rangeLabels.length) % this.rangeLabels.length);
		else {
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private async rescan(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.tui.requestRender();
		const report = await this.onRescan();
		if (report) this.setReport(report, this.rangeIndex);
		else {
			this.loading = false;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const header: string[] = [];
		const tabsLine = this.renderTabs(width);

		const title = theme.bold(theme.fg("accent", "π usage stats"));
		const right = theme.fg("dim", `${this.report.label} · ${fmtDate(Date.now())}`);
		header.push(truncateToWidth(title + "  " + right, width));
		header.push(theme.fg("borderMuted", "─".repeat(width)));
		header.push(tabsLine);
		header.push(theme.fg("borderMuted", "─".repeat(width)));

		let body: string[];
		if (this.loading) {
			body = [theme.fg("dim", "  scanning sessions…")];
		} else {
			body = this.body(width);
		}

		const footer = theme.fg("borderMuted", "─".repeat(width));
		const hint = theme.fg(
			"dim",
			"←/→ tabs · ↑/↓ scroll · d range · r rescan · q close",
		);
		const chrome = header.length + 2; // header + footer separators/hint
		const contentHeight = Math.max(4, this.tui.terminal.rows - chrome - 1);
		const maxScroll = Math.max(0, body.length - contentHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = body.slice(this.scroll, this.scroll + contentHeight);

		return [...header, ...visible, footer, hint].map((line) => truncateToWidth(line, width));
	}

	private renderTabs(width: number): string {
		const theme = this.theme;
		const parts: string[] = [];
		TABS.forEach((name, index) => {
			if (index === this.tab) parts.push(theme.bg("selectedBg", theme.fg("text", theme.bold(` ${name} `))));
			else parts.push(theme.fg("dim", ` ${name} `));
		});
		return truncateToWidth(parts.join(theme.fg("dim", " ")), width);
	}

	private kv(label: string, value: string, labelW = 22): string {
		return `  ${padRight(this.theme.fg("dim", label), labelW)}${value}`;
	}

	private section(title: string): string[] {
		return [
			"",
			`  ${this.theme.bold(this.theme.fg("accent", title))}`,
			`  ${this.theme.fg("borderMuted", "─".repeat(Math.max(4, Math.min(60, title.length + 30))))}`,
		];
	}

	private body(width: number): string[] {
		switch (this.tab) {
			case 0:
				return this.overview(width);
			case 1:
				return this.models(width);
			case 2:
				return this.activity(width);
			case 3:
				return this.projects(width);
			case 4:
				return this.tools(width);
			default:
				return this.sessions(width);
		}
	}

	private overview(width: number): string[] {
		const t = this.report.totals;
		const theme = this.theme;
		const toolCalls = this.report.tools.reduce((sum, row) => sum + row.count, 0);
		const lines: string[] = [];

		lines.push(...this.section("Summary"));
		lines.push(this.kv("Range", theme.fg("text", this.report.label)));
		lines.push(
			this.kv(
				"Period",
				theme.fg("text", `${fmtDate(t.first)} → ${fmtDate(t.last)}`) +
					theme.fg("dim", `  (${fmtInt(t.activeDays)} active days)`),
			),
		);
		lines.push(this.kv("Sessions", theme.fg("text", fmtInt(t.sessions))));
		lines.push(
			this.kv(
				"Messages",
				theme.fg("text", fmtInt(t.messages)) +
					theme.fg(
						"dim",
						`  user ${fmtInt(t.userMessages)} · assistant ${fmtInt(t.assistantMessages)} · tools ${fmtInt(toolCalls)}`,
					),
			),
		);
		lines.push(
			this.kv(
				"Data",
				theme.fg(
					"dim",
					`${fmtInt(this.report.scan.total)} files · ${fmtInt(this.report.scan.scanned)} re-read · ${fmtDuration(
						this.report.scan.ms,
					)}`,
				),
			),
		);

		lines.push(...this.section("Tokens"));
		lines.push(this.kv("Input", theme.fg("text", fmtCompact(t.input))));
		lines.push(
			this.kv(
				"Output",
				theme.fg("text", fmtCompact(t.output)) + theme.fg("dim", `  reasoning ${fmtCompact(t.reasoning)}`),
			),
		);
		lines.push(this.kv("Cache read", theme.fg("text", fmtCompact(t.cacheRead))));
		lines.push(this.kv("Cache write", theme.fg("text", fmtCompact(t.cacheWrite))));
		lines.push(this.kv("Total", theme.bold(theme.fg("text", fmtCompact(t.tokens)))));

		lines.push(...this.section("Cost"));
		lines.push(this.kv("Total cost", theme.bold(theme.fg("success", fmtCost(t.cost)))));
		lines.push(this.kv("Avg / session", theme.fg("success", fmtCost(t.sessions ? t.cost / t.sessions : 0))));
		lines.push(this.kv("Avg / message", theme.fg("success", fmtCost(t.messages ? t.cost / t.messages : 0))));
		lines.push(
			this.kv("Avg tokens / message", theme.fg("text", fmtCompact(t.messages ? t.tokens / t.messages : 0))),
		);

		const top = this.report.models.slice(0, 6);
		if (top.length) {
			lines.push(...this.section("Top models by cost"));
			const max = Math.max(...top.map((m) => m.cost), 0.000001);
			for (const m of top) {
				const pct = t.cost > 0 ? Math.round((m.cost / t.cost) * 100) : 0;
				const modelW = Math.max(18, Math.min(42, width - 34));
				lines.push(
					`  ${padRight(theme.fg("text", truncateToWidth(m.key, modelW)), modelW)} ` +
						padLeft(theme.fg("success", fmtCost(m.cost)), 10) +
						" " +
						bar(m.cost, max, 16, theme) +
						" " +
						padLeft(theme.fg("dim", `${pct}%`), 4),
				);
			}
		}
		return lines;
	}

	private tableHeader(cells: string[], theme: any): string {
		return cells.map((c) => theme.fg("muted", c)).join("");
	}

	private models(width: number): string[] {
		const theme = this.theme;
		const rows = this.report.models;
		if (!rows.length) return [theme.fg("dim", "  No model usage in range.")];
		const barW = 12;
		const fixed = 1 + 7 + 1 + 9 + 1 + 9 + 1 + 9 + 1 + 9 + 1 + 10 + 2 + barW + 2 + 5;
		const modelW = Math.max(16, Math.min(46, width - fixed - 2));
		const maxCost = Math.max(...rows.map((r) => r.cost), 0.000001);
		const totalCost = this.report.totals.cost;

		const lines: string[] = [];
		lines.push(
			this.tableHeader(
				[
					padRight("MODEL", modelW),
					padLeft("REQ", 7),
					padLeft("INPUT", 9),
					padLeft("OUTPUT", 9),
					padLeft("CACHE R", 9),
					padLeft("CACHE W", 9),
					padLeft("COST", 10),
					`  ${padRight("SHARE", barW + 6)}`,
				],
				theme,
			),
		);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 200))));
		for (const r of rows) {
			const pct = totalCost > 0 ? Math.round((r.cost / totalCost) * 100) : 0;
			lines.push(
				padRight(theme.fg("text", truncateToWidth(r.key, modelW)), modelW) +
					padLeft(fmtInt(r.requests), 7) +
					padLeft(fmtCompact(r.input), 9) +
					padLeft(fmtCompact(r.output), 9) +
					padLeft(fmtCompact(r.cacheRead), 9) +
					padLeft(fmtCompact(r.cacheWrite), 9) +
					padLeft(theme.fg("success", fmtCost(r.cost)), 10) +
					`  ${bar(r.cost, maxCost, barW, theme)} ${padLeft(theme.fg("dim", `${pct}%`), 4)}`,
			);
		}
		const sum = rows.reduce(
			(acc, r) => ({
				req: acc.req + r.requests,
				input: acc.input + r.input,
				output: acc.output + r.output,
				cr: acc.cr + r.cacheRead,
				cw: acc.cw + r.cacheWrite,
				cost: acc.cost + r.cost,
			}),
			{ req: 0, input: 0, output: 0, cr: 0, cw: 0, cost: 0 },
		);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 200))));
		lines.push(
			padRight(theme.bold(theme.fg("text", "TOTAL")), modelW) +
				padLeft(theme.bold(fmtInt(sum.req)), 7) +
				padLeft(theme.bold(fmtCompact(sum.input)), 9) +
				padLeft(theme.bold(fmtCompact(sum.output)), 9) +
				padLeft(theme.bold(fmtCompact(sum.cr)), 9) +
				padLeft(theme.bold(fmtCompact(sum.cw)), 9) +
				padLeft(theme.bold(theme.fg("success", fmtCost(sum.cost))), 10),
		);
		return lines;
	}

	private activity(width: number): string[] {
		const theme = this.theme;
		let days: DayRow[] = this.report.days;
		if (!days.length) return [theme.fg("dim", "  No activity in range.")];
		const maxRows = 60;
		const truncated = days.length > maxRows;
		days = days.slice(-maxRows).reverse();
		const maxCost = Math.max(...days.map((d) => d.cost), 0.000001);
		const barW = Math.max(8, Math.min(24, width - 50));

		const peak = this.report.days.reduce((best, d) => (d.cost > best.cost ? d : best), this.report.days[0]!);
		const lines: string[] = [];
		lines.push(
			theme.fg(
				"dim",
				`  ${fmtInt(this.report.totals.activeDays)} active days · peak ${peak.date} ${fmtCost(peak.cost)} · total ${fmtCost(
					this.report.totals.cost,
				)}`,
			),
		);
		lines.push("");
		lines.push(
			this.tableHeader(
				[
					padRight("DATE", 12),
					padLeft("SESS", 6),
					padLeft("MSGS", 8),
					padLeft("TOKENS", 10),
					padLeft("COST", 11),
					`  ${padRight("", barW)}`,
				],
				theme,
			),
		);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 200))));
		for (const d of days) {
			lines.push(
				padRight(theme.fg("text", d.date), 12) +
					padLeft(theme.fg("dim", d.sessions ? String(d.sessions) : "·"), 6) +
					padLeft(fmtInt(d.messages), 8) +
					padLeft(fmtCompact(d.tokens), 10) +
					padLeft(theme.fg("success", fmtCost(d.cost)), 11) +
					`  ${bar(d.cost, maxCost, barW, theme)}`,
			);
		}
		if (truncated) lines.push(theme.fg("dim", `  … ${this.report.days.length - maxRows} older days hidden`));
		return lines;
	}

	private projects(width: number): string[] {
		const theme = this.theme;
		const rows = this.report.projects;
		if (!rows.length) return [theme.fg("dim", "  No projects in range.")];
		const fixed = 8 + 9 + 10 + 12;
		const pathW = Math.max(16, Math.min(50, width - fixed - 4));
		const lines: string[] = [];
		lines.push(
			this.tableHeader(
				[
					padRight("PROJECT", pathW),
					padLeft("SESS", 8),
					padLeft("MSGS", 9),
					padLeft("TOKENS", 10),
					padLeft("COST", 12),
				],
				theme,
			),
		);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 200))));
		for (const r of rows.slice(0, 40)) {
			lines.push(
				padRight(theme.fg("text", truncateToWidth(r.cwd, pathW)), pathW) +
					padLeft(fmtInt(r.sessions), 8) +
					padLeft(fmtInt(r.messages), 9) +
					padLeft(fmtCompact(r.tokens), 10) +
					padLeft(theme.fg("success", fmtCost(r.cost)), 12),
			);
		}
		const sum = rows.reduce(
			(acc, r) => ({
				sessions: acc.sessions + r.sessions,
				messages: acc.messages + r.messages,
				tokens: acc.tokens + r.tokens,
				cost: acc.cost + r.cost,
			}),
			{ sessions: 0, messages: 0, tokens: 0, cost: 0 },
		);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 200))));
		lines.push(
			padRight(theme.bold(theme.fg("text", "TOTAL")), pathW) +
				padLeft(theme.bold(fmtInt(sum.sessions)), 8) +
				padLeft(theme.bold(fmtInt(sum.messages)), 9) +
				padLeft(theme.bold(fmtCompact(sum.tokens)), 10) +
				padLeft(theme.bold(theme.fg("success", fmtCost(sum.cost))), 12),
		);
		return lines;
	}

	private tools(width: number): string[] {
		const theme = this.theme;
		const rows = this.report.tools;
		if (!rows.length) return [theme.fg("dim", "  No tool calls in range.")];
		const total = rows.reduce((sum, r) => sum + r.count, 0);
		const max = Math.max(...rows.map((r) => r.count), 1);
		const barW = Math.max(10, Math.min(30, width - 36));
		const lines: string[] = [];
		lines.push(this.tableHeader([padRight("TOOL", 26), padLeft("CALLS", 10), `  ${padRight("SHARE", barW + 6)}`], theme));
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 200))));
		for (const r of rows.slice(0, 40)) {
			const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
			lines.push(
				padRight(theme.fg("text", truncateToWidth(r.name, 26)), 26) +
					padLeft(fmtInt(r.count), 10) +
					`  ${bar(r.count, max, barW, theme)} ${padLeft(theme.fg("dim", `${pct}%`), 4)}`,
			);
		}
		return lines;
	}

	private sessions(width: number): string[] {
		const theme = this.theme;
		const rows = this.report.sessionsList;
		if (!rows.length) return [theme.fg("dim", "  No sessions in range.")];
		const fixed = 17 + 26 + 8 + 10 + 11;
		const projW = Math.max(14, Math.min(34, width - fixed - 6));
		const lines: string[] = [];
		lines.push(
			this.tableHeader(
				[
					padRight("LAST USED", 17),
					padRight("SESSION", 26),
					padRight("PROJECT", projW),
					padLeft("MSGS", 8),
					padLeft("TOKENS", 10),
					padLeft("COST", 11),
				],
				theme,
			),
		);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 220))));
		for (const s of rows.slice(0, 60)) {
			const label = s.name ? s.name : s.id.slice(0, 13);
			lines.push(
				padRight(theme.fg("dim", fmtDateTime(s.lastTs)), 17) +
					padRight(theme.fg("text", truncateToWidth(label, 26)), 26) +
					padRight(theme.fg("dim", truncateToWidth(s.cwd, projW)), projW) +
					padLeft(fmtInt(s.messages), 8) +
					padLeft(fmtCompact(s.tokens), 10) +
					padLeft(theme.fg("success", fmtCost(s.cost)), 11),
			);
		}
		return lines;
	}
}

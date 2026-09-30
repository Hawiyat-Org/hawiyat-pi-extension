/**
 * pi-stats — usage reporting for pi.
 *
 * Registers:
 *   /stats [today|7d|30d|90d|all]  interactive usage report (TUI)
 *   usage_stats                    LLM tool returning a usage summary
 *
 * Aggregates every session under the pi sessions root: tokens (input/output/
 * cache/reasoning), cost, messages, tool calls, models, projects and daily
 * activity. Per-file results are cached by mtime+size so repeat runs are fast.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanSessions } from "./scan.ts";
import { buildReport, fmtCompact, fmtCost, fmtDate, fmtInt, type Report } from "./report.ts";
import { StatsView } from "./ui.ts";

interface RangeDef {
	label: string;
	arg: string;
	sinceMs: number | null;
}

function startOfToday(): number {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function daysAgo(n: number): number {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - (n - 1));
	return d.getTime();
}

function rangeDefs(): RangeDef[] {
	return [
		{ label: "today", arg: "today", sinceMs: startOfToday() },
		{ label: "7 days", arg: "7d", sinceMs: daysAgo(7) },
		{ label: "30 days", arg: "30d", sinceMs: daysAgo(30) },
		{ label: "90 days", arg: "90d", sinceMs: daysAgo(90) },
		{ label: "all time", arg: "all", sinceMs: null },
	];
}

const DEFAULT_RANGE = 4;

function parseRangeIndex(arg: string, defs: RangeDef[]): number {
	const a = (arg ?? "").trim().toLowerCase();
	if (!a) return DEFAULT_RANGE;
	if (a === "today") return 0;
	if (a === "7d" || a === "7" || a === "week" || a === "w") return 1;
	if (a === "30d" || a === "30" || a === "month" || a === "m") return 2;
	if (a === "90d" || a === "90" || a === "quarter" || a === "q") return 3;
	if (a === "all" || a === "*") return 4;
	return DEFAULT_RANGE;
}

async function loadReport(defs: RangeDef[], index: number): Promise<Report> {
	const started = Date.now();
	const scan = await scanSessions();
	const def = defs[index]!;
	return buildReport(scan.files, def.sinceMs, def.label, {
		scanned: scan.scanned,
		cached: scan.cached,
		total: scan.total,
		ms: Date.now() - started,
	});
}

export function renderText(report: Report): string {
	const t = report.totals;
	const toolCalls = report.tools.reduce((sum, row) => sum + row.count, 0);
	const lines: string[] = [];
	lines.push(`π usage · ${report.label} · ${fmtDate(t.first)} → ${fmtDate(t.last)}`);
	lines.push(
		`${fmtInt(t.sessions)} sessions · ${fmtInt(t.messages)} messages (user ${fmtInt(t.userMessages)} · assistant ${fmtInt(
			t.assistantMessages,
		)} · tools ${fmtInt(toolCalls)})`,
	);
	lines.push(
		`tokens ${fmtCompact(t.tokens)} (in ${fmtCompact(t.input)} · out ${fmtCompact(t.output)} · cache-r ${fmtCompact(
			t.cacheRead,
		)} · cache-w ${fmtCompact(t.cacheWrite)} · reasoning ${fmtCompact(t.reasoning)})`,
	);
	lines.push(
		`cost ${fmtCost(t.cost)} · avg/session ${fmtCost(t.sessions ? t.cost / t.sessions : 0)} · ${fmtInt(
			t.activeDays,
		)} active days`,
	);
	if (report.models.length) {
		lines.push("top models:");
		for (const m of report.models.slice(0, 8)) {
			const pct = t.cost > 0 ? ` (${Math.round((m.cost / t.cost) * 100)}%)` : "";
			lines.push(`  ${m.key}  ${fmtCost(m.cost)}${pct}  ${fmtInt(m.requests)} req`);
		}
	}
	if (report.scan.scanned > 0) lines.push(`[scanned ${report.scan.scanned}/${report.scan.total} files]`);
	return lines.join("\n");
}

function reportJson(report: Report): string {
	return JSON.stringify(
		{
			range: report.label,
			period: { from: fmtDate(report.totals.first), to: fmtDate(report.totals.last) },
			totals: report.totals,
			models: report.models,
			projects: report.projects.slice(0, 30),
			tools: report.tools.slice(0, 30),
			days: report.days.slice(-30),
			sessions: report.sessionsList.slice(0, 30).map((s) => ({
				id: s.id,
				name: s.name,
				cwd: s.cwd,
				lastUsed: fmtDate(s.lastTs),
				messages: s.messages,
				tokens: s.tokens,
				cost: s.cost,
			})),
		},
		null,
		2,
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stats", {
		description: "Usage report across all pi sessions (tokens, cost, models, projects)",
		getArgumentCompletions: (prefix: string) => {
			const items = rangeDefs().map((d) => ({ value: d.arg, label: d.arg, description: d.label }));
			const filtered = items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const defs = rangeDefs();
			let index = parseRangeIndex(args, defs);
			const useTui = ctx.mode === "tui" && ctx.hasUI;

			const raw = (args ?? "").trim();
			if (raw && parseRangeIndex(raw, defs) === DEFAULT_RANGE && !["all", "*"].includes(raw.toLowerCase())) {
				ctx.ui.notify(`Unknown range "${raw}" — showing all time. Try today, 7d, 30d, 90d, all.`, "warning");
			}

			const run = (i: number) => loadReport(defs, i);

			if (useTui) ctx.ui.notify(`Scanning usage (${defs[index]!.label})…`, "info");
			let report = await run(index);

			if (!useTui) {
				ctx.ui.notify(renderText(report), "info");
				return;
			}

			try {
				await ctx.ui.custom((tui, theme, _keybindings, done) => {
					return new StatsView({
						report,
						theme,
						tui,
						rangeLabels: defs.map((d) => d.label),
						rangeIndex: index,
						onCycleRange: async (direction) => {
							index = (index + direction + defs.length) % defs.length;
							report = await run(index);
							return report;
						},
						onRescan: async () => {
							report = await run(index);
							return report;
						},
						done: () => done(undefined),
					});
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Stats view failed: ${message}`, "error");
				ctx.ui.notify(renderText(report), "info");
			}
		},
	});

	pi.registerTool({
		name: "usage_stats",
		label: "Usage Stats",
		description:
			"Report the user's pi usage: sessions, messages, tokens, cost, models, projects and daily activity. " +
			"Use when the user asks about their usage, spend, token consumption, or which models they use.",
		parameters: Type.Object({
			range: Type.Optional(
				Type.String({ description: "today, 7d, 30d, 90d, or all. Default: all." }),
			),
			format: Type.Optional(
				Type.String({ description: "'text' (default) or 'json' for structured data." }),
			),
		}),
		async execute(_toolCallId, params) {
			const defs = rangeDefs();
			const index = parseRangeIndex((params as any)?.range ?? "", defs);
			const report = await loadReport(defs, index);
			const json = String((params as any)?.format ?? "").toLowerCase() === "json";
			return {
				content: [{ type: "text" as const, text: json ? reportJson(report) : renderText(report) }],
				details: {
					range: report.label,
					cost: report.totals.cost,
					tokens: report.totals.tokens,
					sessions: report.totals.sessions,
				},
			};
		},
	});
}

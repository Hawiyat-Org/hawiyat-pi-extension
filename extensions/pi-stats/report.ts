/**
 * Aggregation + formatting for pi-stats.
 *
 * buildReport() is a single pass over every file's per-day aggregates. All
 * rollups (sessions, projects, models, tools) are derived from the same
 * range-filtered day data, so every view agrees with the overview.
 */

import { dayKey, type FileAgg, type ModelAgg } from "./scan.ts";

export interface ModelRow {
	key: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	tokens: number;
	cost: number;
}

export interface DayRow {
	date: string;
	cost: number;
	tokens: number;
	messages: number;
	user: number;
	assistant: number;
	sessions: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export interface ProjectRow {
	cwd: string;
	sessions: number;
	cost: number;
	tokens: number;
	messages: number;
}

export interface ToolRow {
	name: string;
	count: number;
}

/** A session with its stats restricted to the selected range. */
export interface SessionRow {
	id: string;
	name?: string;
	cwd: string;
	created: number;
	modified: number;
	lastTs: number;
	cost: number;
	tokens: number;
	messages: number;
	user: number;
	assistant: number;
	models: string[];
}

export interface Report {
	sinceMs: number | null;
	label: string;
	generatedAt: number;
	totals: {
		sessions: number;
		activeDays: number;
		first: number;
		last: number;
		messages: number;
		userMessages: number;
		assistantMessages: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
		tokens: number;
		cost: number;
	};
	models: ModelRow[];
	days: DayRow[];
	projects: ProjectRow[];
	tools: ToolRow[];
	sessionsList: SessionRow[];
	scan: { scanned: number; cached: number; total: number; ms: number };
}

/** Local accumulator for the report pass (adds the derived sessions counter). */
interface DayAcc {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	tokens: number;
	messages: number;
	user: number;
	assistant: number;
	sessions: number;
}

function newAcc(): DayAcc {
	return {
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		tokens: 0,
		messages: 0,
		user: 0,
		assistant: 0,
		sessions: 0,
	};
}

function addModel(into: ModelAgg, from: ModelAgg): void {
	into.requests += from.requests;
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
	into.reasoning += from.reasoning;
	into.cost += from.cost;
}

function localMidnight(key: string): number {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

export function cutoffKey(sinceMs: number | null): string | null {
	return sinceMs === null ? null : dayKey(sinceMs);
}

export function buildReport(
	files: FileAgg[],
	sinceMs: number | null,
	label: string,
	scan: { scanned: number; cached: number; total: number; ms: number },
): Report {
	const cutoff = cutoffKey(sinceMs);
	const dayMap = new Map<string, DayAcc>();
	const models = new Map<string, ModelAgg>();
	const tools = new Map<string, number>();
	const sessionsList: SessionRow[] = [];
	const totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		tokens: 0,
		cost: 0,
		messages: 0,
		user: 0,
		assistant: 0,
	};

	for (const file of files) {
		let sCost = 0;
		let sTokens = 0;
		let sMessages = 0;
		let sUser = 0;
		let sAssistant = 0;
		let hasRangeDay = false;
		const sModels = new Set<string>();

		for (const [date, day] of Object.entries(file.days)) {
			if (cutoff && date < cutoff) continue;
			hasRangeDay = true;

			totals.input += day.input;
			totals.output += day.output;
			totals.cacheRead += day.cacheRead;
			totals.cacheWrite += day.cacheWrite;
			totals.reasoning += day.reasoning;
			totals.tokens += day.tokens;
			totals.cost += day.cost;
			totals.messages += day.messages;
			totals.user += day.user;
			totals.assistant += day.assistant;

			for (const [key, m] of Object.entries(day.models)) {
				const existing = models.get(key);
				if (existing) addModel(existing, m);
				else models.set(key, { ...m });
			}
			for (const [name, count] of Object.entries(day.tools)) {
				tools.set(name, (tools.get(name) ?? 0) + count);
			}

			let acc = dayMap.get(date);
			if (!acc) {
				acc = newAcc();
				dayMap.set(date, acc);
			}
			acc.cost += day.cost;
			acc.input += day.input;
			acc.output += day.output;
			acc.cacheRead += day.cacheRead;
			acc.cacheWrite += day.cacheWrite;
			acc.reasoning += day.reasoning;
			acc.tokens += day.tokens;
			acc.messages += day.messages;
			acc.user += day.user;
			acc.assistant += day.assistant;
			// A file-day means this session was active on that day.
			if (file.session.hasHeader) acc.sessions += 1;

			sCost += day.cost;
			sTokens += day.tokens;
			sMessages += day.messages;
			sUser += day.user;
			sAssistant += day.assistant;
			for (const key of Object.keys(day.models)) sModels.add(key);
		}

		if (file.session.hasHeader && hasRangeDay) {
			sessionsList.push({
				id: file.session.id,
				name: file.session.name,
				cwd: file.session.cwd,
				created: file.session.created,
				modified: file.session.modified,
				lastTs: file.session.lastTs,
				cost: sCost,
				tokens: sTokens,
				messages: sMessages,
				user: sUser,
				assistant: sAssistant,
				models: Array.from(sModels),
			});
		}
	}

	sessionsList.sort((a, b) => b.cost - a.cost || b.lastTs - a.lastTs);

	const projectMap = new Map<string, ProjectRow>();
	for (const s of sessionsList) {
		const key = s.cwd || "(unknown)";
		const row = projectMap.get(key) ?? { cwd: key, sessions: 0, cost: 0, tokens: 0, messages: 0 };
		row.sessions += 1;
		row.cost += s.cost;
		row.tokens += s.tokens;
		row.messages += s.messages;
		projectMap.set(key, row);
	}

	const dayKeys = Array.from(dayMap.keys()).sort();
	const days: DayRow[] = dayKeys.map((date) => {
		const a = dayMap.get(date)!;
		return {
			date,
			cost: a.cost,
			tokens: a.tokens,
			messages: a.messages,
			user: a.user,
			assistant: a.assistant,
			sessions: a.sessions,
			input: a.input,
			output: a.output,
			cacheRead: a.cacheRead,
			cacheWrite: a.cacheWrite,
			reasoning: a.reasoning,
		};
	});

	const modelRows: ModelRow[] = Array.from(models, ([key, m]) => ({
		key,
		requests: m.requests,
		input: m.input,
		output: m.output,
		cacheRead: m.cacheRead,
		cacheWrite: m.cacheWrite,
		reasoning: m.reasoning,
		tokens: m.input + m.output + m.cacheRead + m.cacheWrite,
		cost: m.cost,
	})).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

	const toolRows: ToolRow[] = Array.from(tools, ([name, count]) => ({ name, count })).sort(
		(a, b) => b.count - a.count,
	);

	return {
		sinceMs,
		label,
		generatedAt: Date.now(),
		totals: {
			sessions: sessionsList.length,
			activeDays: dayKeys.length,
			first: dayKeys.length ? localMidnight(dayKeys[0]!) : 0,
			last: dayKeys.length ? localMidnight(dayKeys[dayKeys.length - 1]!) : 0,
			messages: totals.messages,
			userMessages: totals.user,
			assistantMessages: totals.assistant,
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			reasoning: totals.reasoning,
			tokens: totals.tokens,
			cost: totals.cost,
		},
		models: modelRows,
		days,
		projects: Array.from(projectMap.values()).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
		tools: toolRows,
		sessionsList,
		scan,
	};
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function fmtCompact(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
	if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
	if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

export function fmtCost(n: number): string {
	if (!n || !Number.isFinite(n)) return "$0.00";
	if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
	if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function fmtDate(ms: number): string {
	if (!ms) return "—";
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ms: number): string {
	if (!ms) return "—";
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = Math.floor(s / 60);
	const rs = Math.round(s % 60);
	return `${m}m${rs}s`;
}

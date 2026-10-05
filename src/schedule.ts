/**
 * PeekSeek schedule — DeepSeek 峰谷计费时段判定
 *
 * 这个模块是**纯逻辑**（无 fs / pi 依赖），方便单测。
 *
 * 计费规则（北京时间 UTC+8）：
 *  - 高峰时段：周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00
 *  - 其余时段（工作日非高峰、周末、中国法定节假日全天）均为空闲时段
 *  - 调休上班的周六/周日仍按周末处理 → 全天空闲
 *
 * 依据：DeepSeek API 定价页脚注 + 2026-09-19 「调休上班的周末、中国法定节假日
 * 全天均按空闲时段计费」说明。
 */

export type Currency = "cny" | "usd";

export interface Price {
	cny: number;
	usd: number;
}
export interface PeriodPrice {
	offpeak: Price;
	peak: Price;
}
export interface ModelPricing {
	id: string;
	displayName: string;
	cacheHit: PeriodPrice;
	cacheMiss: PeriodPrice;
	output: PeriodPrice;
}
export interface TimePoint {
	hour: number;
	min: number;
}
export interface PeakWindow {
	start: TimePoint;
	end: TimePoint;
}
export interface AppConfig {
	currency: Currency;
	refreshMs: number;
	enableStatus: boolean;
	enableWidget: boolean;
	/** 高峰星期（0=周日 … 6=周六）。 */
	peakDays: number[];
	/** 高峰时段（北京时间）。 */
	peakWindows: PeakWindow[];
	/** 中国法定节假日（北京时间日期 YYYY-MM-DD），全天按空闲时段计费。 */
	holidays: string[];
	models: ModelPricing[];
}

export interface PeakState {
	isPeak: boolean;
	period: "峰时" | "谷时";
	next: "峰时" | "谷时";
	countdownMs: number;
}

/** 首次运行写入 ~/.pi/peakseek.json 的默认配置。 */
export const DEFAULT_CONFIG: AppConfig = {
	currency: "cny",
	refreshMs: 30_000,
	enableStatus: true,
	enableWidget: false,
	peakDays: [1, 2, 3, 4, 5],
	peakWindows: [
		{ start: { hour: 9, min: 0 }, end: { hour: 12, min: 0 } },
		{ start: { hour: 14, min: 0 }, end: { hour: 18, min: 0 } },
	],
	// 2026 年放假安排（国办发明电〔2025〕7 号）。只列非周末的「放假日」
	holidays: [
		"2026-01-01", "2026-01-02", "2026-01-03", // 元旦
		"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
		"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23", // 春节
		"2026-04-04", "2026-04-05", "2026-04-06", // 清明
		"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", // 劳动节
		"2026-06-19", "2026-06-20", "2026-06-21", // 端午
		"2026-09-25", "2026-09-26", "2026-09-27", // 中秋
		"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
		"2026-10-05", "2026-10-06", "2026-10-07", // 国庆
	],
	models: [
		{
			id: "deepseek-flash",
			displayName: "DeepSeek-V4.1-Flash",
			cacheHit: { offpeak: { cny: 0.02, usd: 0.003 }, peak: { cny: 0.04, usd: 0.006 } },
			cacheMiss: { offpeak: { cny: 1, usd: 0.15 }, peak: { cny: 2, usd: 0.3 } },
			output: { offpeak: { cny: 4, usd: 0.6 }, peak: { cny: 8, usd: 1.2 } },
		},
		{
			id: "deepseek-v4-pro",
			displayName: "DeepSeek-V4-Pro",
			cacheHit: { offpeak: { cny: 0.15, usd: 0.022 }, peak: { cny: 0.3, usd: 0.044 } },
			cacheMiss: { offpeak: { cny: 4.5, usd: 0.66 }, peak: { cny: 9.0, usd: 1.32 } },
			output: { offpeak: { cny: 13.5, usd: 1.98 }, peak: { cny: 27.0, usd: 3.96 } },
		},
	],
};

const BJ_OFFSET_MS = 8 * 3600 * 1000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK = "日一二三四五六";

const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (t: TimePoint) => `${pad2(t.hour)}:${pad2(t.min)}`;

/** 取北京时间的星期/时分秒。 */
export function beijingParts(now: Date): { dow: number; hour: number; minute: number; second: number } {
	const d = new Date(now.getTime() + BJ_OFFSET_MS);
	return {
		dow: d.getUTCDay(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
	};
}

/** 北京时间的日期键 YYYY-MM-DD。 */
export function beijingDateKey(now: Date): string {
	const d = new Date(now.getTime() + BJ_OFFSET_MS);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export interface Schedule {
	isPeakAt(now: Date): boolean;
	isHoliday(now: Date): boolean;
	isWeekend(now: Date): boolean;
	isOffpeakAllDay(now: Date): boolean;
	offpeakReason(now: Date): string;
	nextTransition(now: Date): Date;
	state(now: Date): PeakState;
}

/**
 * 基于配置构造一个时段判定器。`holidays` 在这里固化为 Set；
 * 配置变更（/peakseek update）后重新 createSchedule 即可。
 */
export function createSchedule(cfg: AppConfig): Schedule {
	const holidays = new Set(cfg.holidays ?? []);
	const peakDays = new Set(cfg.peakDays ?? []);
	const windows = (cfg.peakWindows ?? [])
		.map((w) => ({ start: w.start.hour * 60 + w.start.min, end: w.end.hour * 60 + w.end.min }))
		.filter((w) => w.end > w.start)
		.sort((a, b) => a.start - b.start);

	const isWeekend = (now: Date) => {
		const dow = beijingParts(now).dow;
		return dow === 0 || dow === 6;
	};
	const isHoliday = (now: Date) => holidays.has(beijingDateKey(now));
	/** 周末（含调休上班的周末）或中国法定节假日 → 全天谷时。 */
	const isOffpeakAllDay = (now: Date) => isWeekend(now) || isHoliday(now);

	function isPeakAt(now: Date): boolean {
		if (isOffpeakAllDay(now)) return false;
		const p = beijingParts(now);
		if (!peakDays.has(p.dow)) return false;
		const cur = p.hour * 60 + p.minute;
		return windows.some((w) => cur >= w.start && cur < w.end);
	}

	function offpeakReason(now: Date): string {
		if (isHoliday(now)) return "节假日";
		if (isWeekend(now)) return "周末";
		return "工作日休息时间";
	}

	/**
	 * 下一次峰谷切换的真实时刻。只在「北京日界 + 窗口起止」这些候选点上
	 * 判定，避免逐分钟扫描，且能跨越任意长假期。
	 */
	function nextTransition(now: Date): Date {
		const nowMs = now.getTime();
		const isPeakNow = isPeakAt(now);
		let dayStart = Math.floor((nowMs + BJ_OFFSET_MS) / DAY_MS) * DAY_MS - BJ_OFFSET_MS;
		for (let i = 0; i < 60; i++, dayStart += DAY_MS) {
			const candidates = [
				dayStart,
				...windows.flatMap((w) => [dayStart + w.start * MIN_MS, dayStart + w.end * MIN_MS]),
			]
				.filter((t) => t > nowMs)
				.sort((a, b) => a - b);
			for (const t of candidates) {
				if (isPeakAt(new Date(t)) !== isPeakNow) return new Date(t);
			}
		}
		return new Date(nowMs + DAY_MS);
	}

	function state(now: Date): PeakState {
		const isPeak = isPeakAt(now);
		return {
			isPeak,
			period: isPeak ? "峰时" : "谷时",
			next: isPeak ? "谷时" : "峰时",
			countdownMs: nextTransition(now).getTime() - now.getTime(),
		};
	}

	return { isPeakAt, isHoliday, isWeekend, isOffpeakAllDay, offpeakReason, nextTransition, state };
}

/* ----------------------------- 展示格式化 ----------------------------- */

export function fmtPrice(p: Price, currency: Currency): string {
	const v = currency === "usd" ? p.usd : p.cny;
	const digits = currency === "usd" ? (v < 0.01 ? 4 : v < 1 ? 3 : 2) : 2;
	return (currency === "usd" ? "$" : "¥") + v.toFixed(digits);
}

/** 倒计时（分钟粒度；与默认 30s 刷新周期一致）。 */
export function fmtCountdown(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(total / 86_400);
	const h = Math.floor((total % 86_400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const hms = `${pad2(h)}:${pad2(m)}`;
	return days > 0 ? `${days}d ${hms}` : hms;
}

/** 由配置生成时段说明（控制在单行宽度内），避免把峰谷窗口写死在渲染代码里。 */
export function describeSchedule(cfg: AppConfig): string {
	const days = [...new Set(cfg.peakDays)].sort((a, b) => a - b);
	const dayLabel =
		days.join(",") === "1,2,3,4,5" ? "一~五" : days.map((d) => WEEK[d] ?? "?").join("、");
	const windowLabel = cfg.peakWindows.map((w) => `${hhmm(w.start)}-${hhmm(w.end)}`).join(" & ");
	return `峰时：正常工作日 ${windowLabel}   ·  谷时：周末及法定节假日全天`;
}

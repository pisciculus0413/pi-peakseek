/**
 * PeekSeek — DeepSeek peak/off-peak pricing panel for Pi
 *
 * Shows the live peak / off-peak billing status for DeepSeek
 * model series directly in the Pi TUI.
 *
 * Features:
 *  - Footer status line: current peak/off-peak period, colored by state.
 *  - Widget above the editor: real-time pricing table + countdown to the next
 *    billing period change (auto-refreshes).
 *  - `/peakseek` command: toggles the widget panel.
 *  - `/peakseek update`: spawns a sub-agent that refreshes pricing + holidays.
 *
 * This is the extension entry point. Supporting modules:
 *  - ./schedule.ts      峰谷时段判定 + 展示格式化（纯逻辑）
 *  - ./config.ts        ~/.pi/peakseek.json 的读写与容错
 *  - ./update-prompt.md /peakseek update 交给子代理的提示词
 */

import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { createSchedule, describeSchedule, fmtCountdown, fmtPrice } from "./schedule.ts";

/** prompt used by command "/peakseek update" */
const UPDATE_PROMPT_URL = new URL("./update-prompt.md", import.meta.url);

function readUpdatePrompt(): string | undefined {
	try {
		return readFileSync(UPDATE_PROMPT_URL, "utf-8").trim();
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ */
/* Extension entry point                                               */
/* ------------------------------------------------------------------ */

export default async function peakseekExtension(pi: ExtensionAPI) {
	let cfg = loadConfig();
	let schedule = createSchedule(cfg);
	/** latest reply from /peakseek update */
	let lastUpdateReply = "";
	/** 本次会话内面板开关状态。 */
	let widgetOn = cfg.enableWidget;
	let activeTui: TUI | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** 非 TUI 模式下 widget 字符串数组使用的截断宽度。 */
	const RPC_WIDGET_WIDTH = 100;
	/** 上一次推送的 widget 内容，避免重复 setWidget。 */
	let lastWidgetPush = "";

	function rebuild(ctx?: ExtensionContext) {
		cfg = loadConfig((msg) => ctx?.ui.notify(msg, "warning"));
		schedule = createSchedule(cfg);
	}

	/* -------- Widget: 定价表 -------- */

	/** 面板文本。TUI 传入真实宽度；非 TUI 模式用固定宽度。 */
	function widgetLines(theme: Theme, width: number, now: Date): string[] {
		const st = schedule.state(now);
		const reason = st.isPeak ? "" : `（${schedule.offpeakReason(now)}）`;
		const periodColor = st.isPeak ? "warning" : "success";
		const oppositeColor = st.isPeak ? "success" : "warning";
		const c = cfg.currency;

		const lines: string[] = [];
		lines.push(
			theme.fg(periodColor, `⏱ DeepSeek 当前${st.period}${reason}`) +
				theme.fg("dim", ` · 距${st.next} ${fmtCountdown(st.countdownMs)}`) +
				(st.isPeak ? "" : theme.fg("success", "  (半价)")) +
				(lastUpdateReply ? theme.fg("muted", `  [${lastUpdateReply}]`) : "")
		);
		lines.push(theme.fg("dim", "计价单位：每百万 tokens  ·  谷价 = 峰价 ÷ 2  ·  北京时间"));
		describeSchedule(cfg).forEach((item) => {
			lines.push(theme.fg("dim", item))
		});

		for (const m of cfg.models) {
			const cur = st.isPeak
				? { hit: m.cacheHit.peak, miss: m.cacheMiss.peak, out: m.output.peak }
				: { hit: m.cacheHit.offpeak, miss: m.cacheMiss.offpeak, out: m.output.offpeak };
			const opp = st.isPeak
				? { hit: m.cacheHit.offpeak, miss: m.cacheMiss.offpeak, out: m.output.offpeak }
				: { hit: m.cacheHit.peak, miss: m.cacheMiss.peak, out: m.output.peak };
			const label =
				m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.displayName || m.id;

			lines.push(theme.fg("muted", label));
			lines.push(
				theme.fg(
					periodColor,
					`  ${st.period} 命中 ${fmtPrice(cur.hit, c)} · 输入 ${fmtPrice(cur.miss, c)} · 输出 ${fmtPrice(cur.out, c)}`
				)
			);
			lines.push(
				theme.fg(
					oppositeColor,
					`  ${st.next} 命中 ${fmtPrice(opp.hit, c)} · 输入 ${fmtPrice(opp.miss, c)} · 输出 ${fmtPrice(opp.out, c)}`
				)
			);
		}
		return lines.map((l) => truncateToWidth(l, width));
	}

	/** 非 TUI 模式（RPC 等）只能接收字符串数组形式的 widget。 */
	function pushWidget(ctx: ExtensionContext, now: Date) {
		if (!widgetOn || ctx.mode === "tui") return;
		const lines = widgetLines(ctx.ui.theme, RPC_WIDGET_WIDTH, now);
		const snapshot = lines.join("\n");
		if (snapshot === lastWidgetPush) return;
		lastWidgetPush = snapshot;
		ctx.ui.setWidget("peakseek", lines);
	}

	/** 开/关面板。关闭时释放对 tui 的引用（定时器由 refreshUi 统一管理）。 */
	function setWidget(ctx: ExtensionContext, on: boolean) {
		widgetOn = on;
		lastWidgetPush = "";
		if (!on) {
			activeTui = undefined;
			ctx.ui.setWidget("peakseek", undefined);
			return;
		}
		if (ctx.mode !== "tui") {
			pushWidget(ctx, new Date());
			return;
		}
		ctx.ui.setWidget("peakseek", (tui, theme) => {
			activeTui = tui;
			return {
				render: (width) => widgetLines(theme, width, new Date()),
				invalidate: () => {},
			};
		});
	}

	/**
	 * 单一刷新调度：同时驱动 status 与 widget，并在下次峰谷切换点精确唤醒。
	 */
	function refreshUi(ctx: ExtensionContext) {
		clearTimeout(timer);
		if (!cfg.enableStatus && !widgetOn) return; // 没有任何 UI 需要刷新
		const now = new Date();

		if (cfg.enableStatus) {
			const isPeak = schedule.isPeakAt(now);
			const label = isPeak ? "↑ Peak" : "↓ Off-Peak";
			ctx.ui.setStatus("peakseek", ctx.ui.theme.fg(isPeak ? "warning" : "success", `PeekSeek: ${label}`));
		} else {
			ctx.ui.setStatus("peakseek", undefined);
		}

		if (widgetOn) pushWidget(ctx, now);
		activeTui?.requestRender();

		const until = schedule.nextTransition(now).getTime() - now.getTime();
		const delay = Math.max(1000, Math.min(cfg.refreshMs || 30_000, until));
		timer = setTimeout(() => refreshUi(ctx), delay);
	}

	/* -------- Setup -------- */

	pi.on("session_start", async (_event, ctx) => {
		if (widgetOn) setWidget(ctx, true);
		refreshUi(ctx);
	});

	pi.on("session_shutdown", () => {
		clearTimeout(timer);
		activeTui = undefined;
	});

	/* ---------------- Command: /peakseek ---------------- */
	pi.registerCommand("peakseek", {
		description: "Toggle PeekSeek panel; add `update` to refresh pricing",
		getArgumentCompletions: (prefix) => {
			const options = ["update"].filter((o) => o.startsWith(prefix));
			return options.length ? options.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			if (args.trim() === "update") {
				await runUpdate(ctx);
				return;
			}
			setWidget(ctx, !widgetOn);
			refreshUi(ctx);
		},
	});

	/** 运行子代理检索并更新配置文件，保存其回复，完成后自动开启面板。 */
	async function runUpdate(ctx: ExtensionCommandContext) {
		const template = readUpdatePrompt();
		if (!template) {
			ctx.ui.notify(`PeekSeek：找不到提示词文件 ${UPDATE_PROMPT_URL.pathname}`, "error");
			return;
		}
		ctx.ui.notify("正在更新 DeepSeek 定价...", "info");
		const prompt = template.replaceAll("{{CONFIG_PATH}}", CONFIG_PATH);
		let reply: string;
		try {
			const res = await pi.exec("pi", ["--no-session", "--no-context-files", "-p", prompt], {
				timeout: 10 * 60_000,
			});
			const lastLine =
				res.stdout
					.split(/\r?\n/)
					.map((s) => s.trim())
					.filter(Boolean)
					.pop() ?? "";
			reply =
				lastLine === "已更新" ? "已更新" : lastLine === "未更新" ? "未更新" : lastLine.slice(0, 30) || "无回复";
		} catch (e) {
			reply = "更新失败";
			ctx.ui.notify(`DeepSeek 定价更新失败：${(e as Error).message}`, "error");
		}

		lastUpdateReply = reply;
		if (reply === "已更新") rebuild(ctx);

		setWidget(ctx, true);
		refreshUi(ctx);
		ctx.ui.notify(`DeepSeek 定价更新结果：${reply}`, "info");
	}
}

/**
 * PeekSeek config I/O — 读写 ~/.pi/peakseek.json。
 *
 * 只负责持久化与容错；数据结构和默认值来自 ./schedule.ts。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AppConfig, DEFAULT_CONFIG } from "./schedule.ts";

/** 配置文件固定路径：~/.pi/peakseek.json。 */
export const CONFIG_PATH = join(homedir(), ".pi", "peakseek.json");

/** 校验并补全用户配置，坏字段回退默认值。 */
export function normalizeConfig(parsed: Partial<AppConfig>): AppConfig {
	const cfg: AppConfig = { ...DEFAULT_CONFIG, ...parsed };
	if (!Array.isArray(cfg.peakDays) || !cfg.peakDays.length) cfg.peakDays = DEFAULT_CONFIG.peakDays;
	if (!Array.isArray(cfg.peakWindows) || !cfg.peakWindows.length) cfg.peakWindows = DEFAULT_CONFIG.peakWindows;
	cfg.holidays = Array.isArray(cfg.holidays)
		? cfg.holidays.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
		: DEFAULT_CONFIG.holidays;
	if (!Array.isArray(cfg.models) || !cfg.models.length) cfg.models = DEFAULT_CONFIG.models;
	return cfg;
}

/**
 * 读取配置。文件不存在时写入默认配置；JSON 损坏时回退默认值并通过
 * onError 上报，而不是让扩展加载失败。
 */
export function loadConfig(onError?: (msg: string) => void): AppConfig {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		try {
			mkdirSync(dirname(CONFIG_PATH), { recursive: true });
			writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
		} catch {
			/* 写入失败不阻塞：本次运行用内存里的默认值 */
		}
		return DEFAULT_CONFIG;
	}
	try {
		return normalizeConfig(JSON.parse(raw) as Partial<AppConfig>);
	} catch (e) {
		onError?.(`PeekSeek：配置解析失败，已回退默认值（${(e as Error).message}）`);
		return DEFAULT_CONFIG;
	}
}

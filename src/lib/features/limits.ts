/**
 * Fetches Claude API usage limits (5-hour session + 7-day weekly).
 *
 * Strategy:
 *   1. Try OAuth API (api.anthropic.com/api/oauth/usage)
 *   2. Fallback: use ccusage CLI to get block/weekly data from local transcripts
 *
 * Fails silently — returns nulls so the statusline never crashes.
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";

interface UsageLimitResponse {
	five_hour?: { utilization: number; resets_at: string } | null;
	seven_day?: { utilization: number; resets_at: string } | null;
	seven_day_sonnet?: { utilization: number; resets_at: string } | null;
}

interface UsageLimits {
	five_hour: { utilization: number; resets_at: string } | null;
	seven_day: { utilization: number; resets_at: string } | null;
}

function extractTokenFromRaw(raw: string): string | null {
	// Try plain JSON first (legacy format)
	try {
		const parsed = JSON.parse(raw);
		return parsed?.claudeAiOauth?.accessToken ?? null;
	} catch {
		// Not plain JSON
	}

	// Claude Code now stores credentials as hex-encoded binary
	if (/^[0-9a-f]+$/i.test(raw) && raw.length > 20) {
		const decoded = Buffer.from(raw, "hex").toString("utf-8");
		// Extract token directly via regex (binary format has control chars)
		const match = decoded.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
		if (match) return match[0];
	}

	return null;
}

function getOAuthToken(): string | null {
	try {
		if (platform() === "darwin") {
			const raw = execSync(
				'security find-generic-password -s "Claude Code-credentials" -w',
				{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
			).trim();
			return extractTokenFromRaw(raw);
		}

		const { readFileSync } = require("node:fs");
		const { join } = require("node:path");
		const { homedir } = require("node:os");
		const credPath = join(homedir(), ".claude", ".credentials.json");
		const creds = JSON.parse(readFileSync(credPath, "utf-8"));
		return creds?.claudeAiOauth?.accessToken ?? null;
	} catch {
		return null;
	}
}

async function fetchFromApi(): Promise<UsageLimits | null> {
	try {
		const token = getOAuthToken();
		if (!token) return null;

		const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "claude-code/2.1.42",
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(5000),
		});

		if (!resp.ok) return null;

		const data: UsageLimitResponse = await resp.json();

		return {
			five_hour: data.five_hour
				? {
						utilization: Math.round(data.five_hour.utilization),
						resets_at: data.five_hour.resets_at,
					}
				: null,
			seven_day: data.seven_day
				? {
						utilization: Math.round(data.seven_day.utilization),
						resets_at: data.seven_day.resets_at,
					}
				: null,
		};
	} catch {
		return null;
	}
}

// ─── ccusage fallback ────────────────────────────────────────

interface CcusageBlock {
	startTime: string;
	endTime: string;
	isActive: boolean;
	isGap: boolean;
	costUSD: number;
	projection?: { remainingMinutes: number };
}

interface CcusageWeek {
	week: string;
	totalCost: number;
}

function fetchFromCcusage(): UsageLimits {
	const empty: UsageLimits = { five_hour: null, seven_day: null };

	try {
		const now = new Date();
		const todayStr = now.toISOString().slice(0, 10).replace(/-/g, "");

		// Get active block (5-hour window)
		const blocksRaw = execSync(`ccusage blocks --json --since ${todayStr}`, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
		});
		const blocksData = JSON.parse(blocksRaw);
		const blocks: CcusageBlock[] = blocksData.blocks ?? blocksData;
		const activeBlock = blocks.find((b) => b.isActive && !b.isGap);

		let fiveHour: UsageLimits["five_hour"] = null;
		if (activeBlock) {
			fiveHour = {
				utilization: Math.round(activeBlock.costUSD),
				resets_at: activeBlock.endTime,
			};
		}

		// Get weekly data (7-day window)
		const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
		const sinceStr = weekAgo.toISOString().slice(0, 10).replace(/-/g, "");
		const weeklyRaw = execSync(`ccusage weekly --json --since ${sinceStr}`, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
		});
		const weeklyData = JSON.parse(weeklyRaw);
		const weeks: CcusageWeek[] = weeklyData.weekly ?? weeklyData;

		let sevenDay: UsageLimits["seven_day"] = null;
		if (weeks.length > 0) {
			const totalWeeklyCost = weeks.reduce((sum, w) => sum + w.totalCost, 0);
			// Weekly reset: next Monday 00:00 UTC
			const dayOfWeek = now.getUTCDay(); // 0=Sun
			const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
			const nextMonday = new Date(now);
			nextMonday.setUTCDate(now.getUTCDate() + daysUntilMonday);
			nextMonday.setUTCHours(0, 0, 0, 0);

			sevenDay = {
				utilization: Math.round(totalWeeklyCost),
				resets_at: nextMonday.toISOString(),
			};
		}

		return { five_hour: fiveHour, seven_day: sevenDay };
	} catch {
		return empty;
	}
}

export async function getUsageLimits(): Promise<UsageLimits> {
	// Try API first
	const apiResult = await fetchFromApi();
	if (apiResult?.five_hour || apiResult?.seven_day) {
		return apiResult;
	}

	// Fallback to ccusage local data
	return fetchFromCcusage();
}

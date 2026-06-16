/**
 * Zombie process detection — pure logic.
 *
 * Platform-specific /proc scanning lives in adapter/ (zombie_linux.py / equivalent).
 */

export const INFRASTRUCTURE_KEYWORDS: ReadonlySet<string> = new Set([
	"compactor.js",
	"safety-check.js",
	"zombie-detector.js",
	"cognitive-push.js",
	"snapshot-git.js",
	"session-guardian.js",
	"tone-injector.js",
	"clean-session-stats.js",
	"action-gate.js",
	"shellIntegration-bash.sh",
]);

export function isInfrastructureProcess(
	cmdline: string,
	keywords: ReadonlySet<string> = INFRASTRUCTURE_KEYWORDS,
): boolean {
	for (const kw of keywords) {
		if (cmdline.includes(kw)) return true;
	}
	return false;
}

export function isProcessExpired(
	elapsedSeconds: number,
	threshold: number = 300.0,
): boolean {
	return elapsedSeconds > threshold;
}

/**
 * Zombie process detection — pure logic.
 *
 * Platform-specific /proc scanning lives in adapter/ (zombie_linux.py / equivalent).
 */

export const INFRASTRUCTURE_KEYWORDS: ReadonlySet<string> = new Set([
  "compactor.py", "safety-check.py", "zombie-detector.py",
  "cognitive-push.py", "snapshot-git.py", "session-guardian.py",
  "tone-injector.py", "clean-session-stats.py", "action-gate.py",
  "shellIntegration-bash.sh",
]);

export function isInfrastructureProcess(
  cmdline: string,
  keywords: ReadonlySet<string> = INFRASTRUCTURE_KEYWORDS
): boolean {
  for (const kw of keywords) {
    if (cmdline.includes(kw)) return true;
  }
  return false;
}

export function isProcessExpired(
  elapsedSeconds: number,
  threshold: number = 15.0
): boolean {
  return elapsedSeconds > threshold;
}

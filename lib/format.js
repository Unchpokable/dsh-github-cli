/** Small formatting helpers shared by transports and renderers. */

/** Short commit form used in labels. */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO timestamp for an epoch-seconds value, or null. */
export function isoSeconds(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/** ISO timestamp for an epoch-milliseconds value, or null. */
export function isoMillis(milliseconds) {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Compact duration, e.g. `1m 05s`. */
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

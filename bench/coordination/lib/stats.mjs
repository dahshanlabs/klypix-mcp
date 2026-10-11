// Small, dependency-free statistics for the bench report.

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k, n, z = 1.96) {
  if (!n) return { p: null, low: null, high: null };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

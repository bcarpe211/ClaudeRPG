/** Compact number: 999, 1.2K, 12.4K, 124K, 3.2M, 1.1B, 4.5T. Sign-preserving. */
export function formatCompact(n: number): string {
  const sign = n < 0 ? '-' : '';
  let x = Math.abs(n);
  if (x < 1000) return sign + String(Math.round(x));
  const units = ['K', 'M', 'B', 'T'];
  let u = -1;
  while (x >= 1000 && u < units.length - 1) { x /= 1000; u++; }
  const digits = x < 100 ? 1 : 0;
  return sign + x.toFixed(digits) + units[u];
}

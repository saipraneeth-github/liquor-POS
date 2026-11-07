/** ₹ with Indian grouping: ₹1,22,500 */
export const inr = (v: number | string) => `₹${Math.round(Number(v)).toLocaleString('en-IN')}`;
/** ₹ with paise: ₹6,630.00 */
export const inr2 = (v: number | string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** ₹31.40 L for large figures */
/** Lakhs for large sums; a small sum is shown in full, because "₹0.02 L" is harder to read than "₹2,320". */
export const lakh = (v: number | string) => (Math.abs(Number(v)) >= 100000 ? `₹${(Number(v) / 100000).toFixed(2)} L` : inr(v));

/** "45 m", "6 h 20 m", "2 d 3 h" */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} m`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).toUpperCase();

/** 0 → "12a", 9 → "9a", 12 → "12p", 21 → "9p" */
export const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

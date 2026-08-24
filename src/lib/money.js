/** All money in this app is integer cents; these helpers convert at the edges. */
export const toCents = (value) => Math.round(Number(value) * 100);
export const fromCents = (cents) => Number(cents || 0) / 100;

export function formatCents(cents, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(fromCents(cents));
}

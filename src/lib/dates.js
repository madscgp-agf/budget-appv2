/** Returns today's date as YYYY-MM-DD in UTC. */
export const today = () => new Date().toISOString().slice(0, 10);

/** Returns the current period as YYYY-MM in UTC. */
export const currentPeriod = () => today().slice(0, 7);

/** First and last day (inclusive) of a YYYY-MM period. */
export function periodRange(period) {
  const [year, month] = period.split('-').map(Number);
  const start = `${period}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${period}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

/** Shifts a YYYY-MM period by a number of months. */
export function shiftPeriod(period, months) {
  const [year, month] = period.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Advances a YYYY-MM-DD date by one cadence step, clamping to month length. */
export function advanceDate(dateStr, cadence) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  switch (cadence) {
    case 'weekly':
      base.setUTCDate(base.getUTCDate() + 7);
      break;
    case 'biweekly':
      base.setUTCDate(base.getUTCDate() + 14);
      break;
    case 'monthly':
    case 'yearly': {
      const monthsAhead = cadence === 'monthly' ? 1 : 12;
      const target = new Date(Date.UTC(y, m - 1 + monthsAhead, 1));
      const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      target.setUTCDate(Math.min(d, daysInTarget));
      return target.toISOString().slice(0, 10);
    }
    default:
      throw new Error(`Unknown cadence: ${cadence}`);
  }
  return base.toISOString().slice(0, 10);
}

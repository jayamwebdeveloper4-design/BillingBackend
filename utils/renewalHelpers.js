
const parseDateToUTC = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return null;

  const clean = dateStr.trim();
  let day, month, year;

  if (clean.includes('.') || clean.includes('-')) {
    const parts = clean.split(/[.-]/);

    if (parts.length !== 3) return null;

    if (parts[0].length === 4) {
      [year, month, day] = parts.map(Number);
    } else {
      [day, month, year] = parts.map(Number);
    }

    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day)
    ) return null;

    const date = new Date(Date.UTC(year, month - 1, day));

    // Reject invalid calendar dates such as 31-02-2026
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) return null;

    return date;
  }

  const date = new Date(clean);

  return isNaN(date.getTime()) ? null : date;
};

const getTodayUTC = () => {
  const now = new Date();

  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
};

const subtractMonthsUTC = (dateObj, nMonths = 1) => {
  const originalDay = dateObj.getUTCDate();
  const result = new Date(dateObj.getTime());

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - nMonths);

  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0
  )).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDay));

  return result;
};

const isRenewedStatus = (status) => {
  return [
    'renewed',
    'yearly renewed',
    'renewald'
  ].includes((status || '').toLowerCase().trim());
};

const isWithinReminderWindow = (endDate, nMonths = 1) => {
  const endUTC = parseDateToUTC(endDate);

  if (!endUTC) return false;

  const todayUTC = getTodayUTC();
  const windowStart = subtractMonthsUTC(endUTC, nMonths);

  return todayUTC >= windowStart;
};

const getReminderEligibility = (product, nMonths = 1) => {
  const currentStatus = (product.renewalStatus || 'upcoming').toLowerCase();

  const isRenewed = isRenewedStatus(currentStatus);
  const endUTC = parseDateToUTC(product.endDate);

  const isInWindow = endUTC
    ? getTodayUTC() >= subtractMonthsUTC(endUTC, nMonths)
    : false;

  const isExpired = endUTC
    ? getTodayUTC() > endUTC
    : false;

  if (isRenewed) {
    return {
      eligible: false,
      reason: 'Blocked: Product is already RENEWED (PAID). Reminders strictly blocked.',
      isInWindow,
      isExpired,
      currentStatus
    };
  }

  if (!isInWindow) {
    return {
      eligible: false,
      reason: 'Outside reminder window (reminders suppressed).',
      isInWindow,
      isExpired,
      currentStatus
    };
  }

  return {
    eligible: true,
    reason: 'Eligible for reminder dispatch.',
    isInWindow,
    isExpired,
    currentStatus
  };
};

const getReminderMonths = (value) => {
  const months = parseInt(value, 10) || 1;
  return Math.min(Math.max(months, 1), 12);
};

module.exports = {
  parseDateToUTC,
  getTodayUTC,
  subtractMonthsUTC,
  isRenewedStatus,
  isWithinReminderWindow,
  getReminderEligibility,
  getReminderMonths
};

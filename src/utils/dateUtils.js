const addDays = (dateStr, days) => {
  if (!dateStr || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const date = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isIncrementalUpToDate = (lastStoredDate, expectedTradingDay) => {
  if (!lastStoredDate || typeof lastStoredDate !== 'string') return false;
  if (!expectedTradingDay || typeof expectedTradingDay !== 'string') return false;
  return lastStoredDate >= expectedTradingDay;
};

const getLastExpectedTradingDay = () => {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = target.getDay();

  if (dayOfWeek === 6) {
    target.setDate(target.getDate() - 1);
  } else if (dayOfWeek === 0) {
    target.setDate(target.getDate() - 2);
  } else {
    const currentHour = now.getHours();
    if (currentHour < 22 && dayOfWeek === 1) {
      target.setDate(target.getDate() - 3);
    } else if (currentHour < 22) {
      target.setDate(target.getDate() - 1);
    }
  }

  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

module.exports = { getLastExpectedTradingDay, addDays, isIncrementalUpToDate };

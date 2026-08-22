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
  const dayOfWeek = now.getDay(); // 0 = Domingo, 6 = Sábado
  const target = new Date(now);

  if (dayOfWeek === 0) {
    target.setDate(now.getDate() - 2); // Sexta-feira
  } else if (dayOfWeek === 6) {
    target.setDate(now.getDate() - 1); // Sexta-feira
  } else if (dayOfWeek === 1 && now.getHours() < 18) {
    target.setDate(now.getDate() - 3); // Sexta-feira se for Segunda de manhã/tarde
  } else if (now.getHours() < 18) {
    target.setDate(now.getDate() - 1); // Dia útil anterior antes das 18h
  }

  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

module.exports = { getLastExpectedTradingDay, addDays, isIncrementalUpToDate };

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

module.exports = { getLastExpectedTradingDay };

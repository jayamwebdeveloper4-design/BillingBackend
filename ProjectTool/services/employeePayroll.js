const parseMonthlySalaryPaise = (salary) => {
  if (salary === null || salary === undefined) return null;
  const salaryText = String(salary).trim().replace(/[₹,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(salaryText)) return null;

  const salaryPaise = Math.round(Number(salaryText) * 100);
  return Number.isSafeInteger(salaryPaise) ? salaryPaise : null;
};

const calculateProratedSalaryPaise = (monthlySalaryPaise, totalMinutes, standardMonthMinutes) =>
  Math.round((monthlySalaryPaise * totalMinutes) / standardMonthMinutes);

module.exports = { parseMonthlySalaryPaise, calculateProratedSalaryPaise };

// utils/dateFilter.js
function getMonthDateRange(month, year) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Generates a MongoDB date filter for month/year
 * @param {string|number} month - month number (1-12)
 * @param {string|number} year - full year (e.g., 2025)
 * @param {string} fieldName - the field to filter (default: "date")
 * @returns {object} - {$gte: start, $lte: end} or empty object
 */
function getMonthFilter(month, year, fieldName = "date") {
  if (!month || !year) return {};
  const { start, end } = getMonthDateRange(Number(month), Number(year));
  return { [fieldName]: { $gte: start, $lte: end } };
}

// Example for Oracle
function getMonthFilterOracle(month, year) {
  if (!month || !year) return null;
  const startDate = new Date(year, month - 1, 1, 0, 0, 0);       // first day 00:00:00
  const endDate = new Date(year, month, 0, 23, 59, 59);          // last day 23:59:59
  return { startDate, endDate };
}


module.exports = { getMonthDateRange, getMonthFilter,getMonthFilterOracle };

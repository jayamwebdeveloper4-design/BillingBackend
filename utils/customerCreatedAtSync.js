const Customer = require('../models/Customer');

/**
 * Safely parses orderDate into a Date object.
 * Supports YYYY-MM-DD, DD-MM-YYYY, ISO strings, and standard Date strings.
 */
const parseOrderDate = (dateVal) => {
  if (!dateVal) return null;
  if (dateVal instanceof Date && !isNaN(dateVal.getTime())) return dateVal;

  const str = String(dateVal).trim();
  if (!str) return null;

  // Match YYYY-MM-DD or YYYY/MM/DD
  const yyyymmddMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (yyyymmddMatch) {
    const [_, y, m, d] = yyyymmddMatch;
    const dateObj = new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)));
    if (!isNaN(dateObj.getTime())) return dateObj;
  }

  // Match DD-MM-YYYY or DD/MM/YYYY
  const ddmmyyyyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (ddmmyyyyMatch) {
    const [_, d, m, y] = ddmmyyyyMatch;
    const dateObj = new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)));
    if (!isNaN(dateObj.getTime())) return dateObj;
  }

  // Fallback standard JS Date parsing
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;

  return null;
};

/**
 * Updates each customer's `createdAt` field in MongoDB to match their first order's `orderDate`.
 */
const syncCustomerCreatedAtFromFirstOrder = async () => {
  try {
    console.log('🔄 [CustomerCreatedAtSync] Running migration: Updating customer createdAt to first order orderDate...');
    const customers = await Customer.find({ "orders.0": { $exists: true } });
    let updatedCount = 0;

    for (const customer of customers) {
      if (!customer.orders || customer.orders.length === 0) continue;

      let earliestDate = null;
      let earliestTime = Infinity;

      for (const order of customer.orders) {
        const orderDateVal = order.orderDate || order.createdAt;
        const parsed = parseOrderDate(orderDateVal);
        if (parsed && parsed.getTime() < earliestTime) {
          earliestTime = parsed.getTime();
          earliestDate = parsed;
        }
      }

      if (earliestDate) {
        await Customer.collection.updateOne(
          { _id: customer._id },
          { $set: { createdAt: earliestDate } }
        );
        updatedCount++;
      }
    }

    console.log(`✅ [CustomerCreatedAtSync] Migration completed: Updated createdAt for ${updatedCount} customer(s).`);
  } catch (error) {
    console.error('❌ [CustomerCreatedAtSync] Error updating customer createdAt:', error);
  }
};

module.exports = {
  parseOrderDate,
  syncCustomerCreatedAtFromFirstOrder
};

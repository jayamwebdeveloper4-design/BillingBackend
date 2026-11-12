const Customer = require('../models/Customer');
const { logCron, logActivity } = require('./logger');

/**
 * Checks all customer orders:
 * Only for upcoming end dates (todayStr <= order.endDate):
 * If current local date is within 30 days before order.endDate (todayStr >= endDate - 30 days),
 * changes paymentStatus to "Unpaid" and logs the update.
 * Past end dates are ignored.
 */
const syncExpiredPaymentStatuses = async () => {
  try {
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    logCron('START', `Running payment status expiration check (30 days before end date, Current Date: ${todayStr})`);

    const customers = await Customer.find({ "orders.0": { $exists: true } });
    let totalUpdated = 0;

    for (const customer of customers) {
      let isModified = false;

      for (const order of customer.orders) {
        if (!order.endDate) continue;

        const endDateStr = String(order.endDate).trim().slice(0, 10);
        const parts = endDateStr.split('-');
        if (parts.length !== 3) continue;

        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        if (isNaN(y) || isNaN(m) || isNaN(d)) continue;

        const targetDate = new Date(y, m - 1, d);
        targetDate.setDate(targetDate.getDate() - 30);

        const thirtyDaysBeforeStr = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;

        // Only trigger for coming end dates (today <= order.endDate) within 30 days
        if (todayStr >= thirtyDaysBeforeStr && todayStr <= endDateStr && order.paymentStatus !== 'Unpaid') {
          const oldStatus = order.paymentStatus;
          order.paymentStatus = 'Unpaid';
          isModified = true;
          totalUpdated++;

          const activeProducts = (order.products || []).filter(p => p.validationEnabled && !p.deactive);
          const productNames = (activeProducts.length > 0 ? activeProducts : (order.products || []))
            .map(p => p.product)
            .filter(Boolean)
            .join(', ') || 'N/A';
          const domainUrl = order.domainUrl || 'N/A';

          const logMessage = `Order ${order._id} (Domain: ${domainUrl}, Product: ${productNames}) for customer "${customer.name}" reached 30 days before end date ${endDateStr} (Threshold: ${thirtyDaysBeforeStr}, Today: ${todayStr}). Payment status updated from "${oldStatus}" to "Unpaid".`;
          logCron('UPDATE', logMessage);
          logActivity('System Cron', 'PAYMENT_STATUS_EXPIRED', 'SUCCESS', logMessage);
          console.log(`[PaymentStatusSync] 🔄 ${logMessage}`);
        }
      }

      if (isModified) {
        await customer.save();
      }
    }

    logCron('DONE', `Payment status expiration check complete. ${totalUpdated} order(s) updated to Unpaid.`);
    return { success: true, totalUpdated };
  } catch (error) {
    logCron('ERROR', `Payment status expiration check failed: ${error.message}`);
    console.error('❌ Error syncing expired payment statuses:', error);
    return { success: false, error: error.message };
  }
};

module.exports = { syncExpiredPaymentStatuses };

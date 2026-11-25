const CustomerProduct = require('../../models/CustomerProduct');

/**
 * Strict date parsing for both YYYY-MM-DD and DD.MM.YYYY formats
 */
const parseDateToUTC = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? null
      : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value !== 'string') return null;

  const clean = value.trim();
  let year, month, day;
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = clean.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/);

  if (iso) {
    [, year, month, day] = iso;
  } else if (local) {
    [, day, month, year] = local;
  } else {
    return null;
  }

  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return isNaN(d.getTime()) ? null : d;
};

const getTodayUTC = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/**
 * Daily job to transition expired renewals:
 * 1. If an upcoming cycle exists in renewalHistory:
 *    - Archives current expired root cycle into renewalHistory as 'complete'
 *    - Promotes upcoming cycle to root as 'active' with new dates
 * 2. If no upcoming cycle exists:
 *    - Transitions root renewalStatus to 'not renewed'
 */
const syncUpcomingToNotRenewed = async () => {
  try {
    const todayUTC = getTodayUTC();

    // Find active renewal products
    const activeProducts = await CustomerProduct.find({
      productType: 'Renewal',
      deactive: false,
      renewalStatus: { $in: ['active', 'renewed', 'yearly renewed', 'upcoming'] },
    }).lean();

    for (const prod of activeProducts) {
      const endUTC = parseDateToUTC(prod.endDate);
      if (!endUTC || todayUTC <= endUTC) continue;

      // Cycle at root has expired!
      const history = Array.isArray(prod.renewalHistory) ? [...prod.renewalHistory] : [];
      const upcomingIndex = history.findIndex((h) => h.renewalStatus === 'upcoming');

      if (upcomingIndex !== -1) {
        const upcomingCycle = history[upcomingIndex];
        const isUpcomingPaid =
          upcomingCycle.paymentStatus === 'Paid' ||
          (Number(upcomingCycle.paidAmount) > 0 &&
            Number(upcomingCycle.paidAmount) >= Number(upcomingCycle.totalAmount));

        if (isUpcomingPaid) {
          // 1. Upcoming cycle was PAID in advance! Promote C4 to root as 'active'
          const completedCycle = {
            cycleNumber: prod.cycleCount || 1,
            startDate: prod.startDate,
            endDate: prod.endDate,
            totalAmount: Number(prod.sellerPriceRenewal) || Number(prod.price) || 0,
            paidAmount: (prod.paymentHistory || []).reduce((s, p) => s + (Number(p.amount) || 0), 0),
            paymentStatus: 'Paid',
            renewalStatus: 'complete',
            paymentStages: [],
          };

          // Remove the upcoming cycle from history since it now becomes root
          history.splice(upcomingIndex, 1);
          history.push(completedCycle);

          // Sort history by cycleNumber ascending
          history.sort((a, b) => (a.cycleNumber || 0) - (b.cycleNumber || 0));

          // 2. Promote upcoming cycle to root as active
          await CustomerProduct.updateOne(
            { _id: prod._id },
            {
              $set: {
                startDate: upcomingCycle.startDate,
                endDate: upcomingCycle.endDate,
                cycleCount: upcomingCycle.cycleNumber || (prod.cycleCount || 1) + 1,
                renewalStatus: 'active',
                renewalHistory: history,
              },
            }
          );
          console.log(`[RenewalSchedule] Promoted paid renewal cycle ${upcomingCycle.cycleNumber} to active for product ${prod._id}`);
        } else {
          // 2. Case 2: Date has crossed expiry date and upcoming cycle is UNPAID!
          // Do NOT promote to active! Transition root to 'not renewed' (EXPIRED)
          await CustomerProduct.updateOne(
            { _id: prod._id, renewalStatus: { $ne: 'not renewed' } },
            { $set: { renewalStatus: 'not renewed' } }
          );
          console.log(`[RenewalSchedule] Current cycle expired and next cycle is unpaid. Marked product ${prod._id} as 'not renewed'`);
        }
      } else {
        // No upcoming cycle, transition to 'not renewed'
        await CustomerProduct.updateOne(
          { _id: prod._id, renewalStatus: { $ne: 'not renewed' } },
          { $set: { renewalStatus: 'not renewed' } }
        );
        console.log(`[RenewalSchedule] Expired product ${prod._id} transitioned to 'not renewed'`);
      }
    }
  } catch (err) {
    console.error('[RenewalSchedule] Error in syncUpcomingToNotRenewed:', err.message);
  }
};

/**
 * Start schedule: runs immediately on boot, then once every 24 hours
 */
const startDailyRenewalStatusSchedule = () => {
  // 1. Run immediately on server boot
  syncUpcomingToNotRenewed();

  // 2. Schedule recurring every 24 hours (86,400,000 ms)
  const DAY_IN_MS = 24 * 60 * 60 * 1000;
  setInterval(syncUpcomingToNotRenewed, DAY_IN_MS);
  console.log('[RenewalSchedule] Daily renewal transition schedule registered.');
};

module.exports = {
  syncUpcomingToNotRenewed,
  startDailyRenewalStatusSchedule,
};



const mongoose = require('mongoose');
const CustomerProduct = require('../models/CustomerProduct');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const XLSX = require('xlsx');

const MAX_LIMIT = 200;
const MAX_EXPORT_ROWS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ==================================================
// 1. COMMON HELPERS
// ==================================================

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const normalizeStatus = (status) => {
  if (!status) return null;

  const value = String(status).toLowerCase().trim();

  if (['renewed', 'renewald'].includes(value)) return 'renewed';
  if (value === 'yearly renewed') return 'yearly renewed';
  if (value === 'upcoming') return 'upcoming';

  if (
    [
      'not_renewal',
      'not renewaled',
      'not renewed',
      'expired',
    ].includes(value)
  ) {
    return 'not renewed';
  }

  return null;
};

const getCompanyID = (req) =>
  req.companyID ||
  req.user?.companyID ||
  req.user?.companyId ||
  null;

const getTenantFilter = (req) => {
  const companyID = getCompanyID(req);

  // Preserve your existing global-admin behavior.
  // Tenant routes should have companyID supplied by auth middleware.
  return companyID ? { companyID } : {};
};

const getAggregationTenantFilter = (req) => {
  const companyID = getCompanyID(req);

  if (!companyID) return {};

  return {
    companyID: isValidId(companyID)
      ? new mongoose.Types.ObjectId(companyID)
      : companyID,
  };
};

const paging = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || 20, 1),
    MAX_LIMIT
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const parseDateToUTC = (value) => {
  if (!value) return null;

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;

    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate()
      )
    );
  }

  if (typeof value !== 'string') return null;

  const clean = value.trim();

  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = clean.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/);

  let year;
  let month;
  let day;

  if (iso) {
    [, year, month, day] = iso;
  } else if (local) {
    [, day, month, year] = local;
  } else {
    return null;
  }

  year = Number(year);
  month = Number(month);
  day = Number(day);

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
};

const formatToDotDate = (date) => {
  if (!date || isNaN(date.getTime())) return '';

  return [
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    date.getUTCFullYear(),
  ].join('.');
};

const getTodayUTC = () => {
  const now = new Date();

  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    )
  );
};

const addDaysUTC = (date, days) => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

const changeMonthsUTC = (date, months) => {
  const result = new Date(date);
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(
      result.getUTCFullYear(),
      result.getUTCMonth() + 1,
      0
    )
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDay));

  return result;
};

const addBillingCycle = (date, cycle) => {
  if (cycle === 'monthly') {
    return changeMonthsUTC(date, 1);
  }

  if (cycle === 'yearly') {
    return changeMonthsUTC(date, 12);
  }

  throw new Error('Unsupported billing cycle');
};

// Inclusive date convention:
// Current cycle ends on 31 Dec.
// Next cycle starts on 1 Jan.
// Next cycle ends one day before the next billing anniversary.
const getNextCycleDates = (currentEndDate, billingCycle) => {
  const startDate = addDaysUTC(currentEndDate, 1);
  const endDate = addDaysUTC(
    addBillingCycle(startDate, billingCycle),
    -1
  );

  return { startDate, endDate };
};

const getNMonths = (value) => {
  const months = parseInt(value, 10) || 1;
  return Math.min(Math.max(months, 1), 120);
};

const validateAmount = (value, fieldName) => {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return amount;
};

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getCycleAmount = (doc) => {
  const amount =
    doc.sellerPriceRenewal !== undefined &&
    doc.sellerPriceRenewal !== null
      ? Number(doc.sellerPriceRenewal)
      : Number(doc.price);

  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
};

const getPaymentStatus = (paidAmount, totalAmount) => {
  if (totalAmount > 0 && paidAmount >= totalAmount) return 'Paid';
  if (paidAmount > 0) return 'Partially Paid';
  return 'Unpaid';
};

const getCycleStatus = (cycle) => {
  const paidAmount = Number(cycle?.paidAmount) || 0;
  const totalAmount = Number(cycle?.totalAmount) || 0;

  return getPaymentStatus(paidAmount, totalAmount);
};

const getCycleIndex = (history, cycleNumber) => {
  return history.findIndex(
    (item) => Number(item.cycleNumber) === Number(cycleNumber)
  );
};

const getSelectedCycle = (history) => {
  if (!Array.isArray(history) || history.length === 0) return null;

  // Prefer an upcoming cycle if it has received an advance payment.
  const paidUpcoming = history.find(
    (item) =>
      item.renewalStatus === 'upcoming' &&
      Number(item.paidAmount) > 0
  );

  if (paidUpcoming) return paidUpcoming;

  const active = history.find(
    (item) => item.renewalStatus === 'active'
  );

  if (active) return active;

  const upcoming = history.find(
    (item) => item.renewalStatus === 'upcoming'
  );

  if (upcoming) return upcoming;

  return history[history.length - 1];
};

const mongoDateExpression = (field) => ({
  $switch: {
    branches: [
      {
        case: { $eq: [{ $type: field }, 'date'] },
        then: field,
      },
      {
        case: {
          $regexMatch: {
            input: { $ifNull: [field, ''] },
            regex: /^\d{4}-\d{2}-\d{2}$/,
          },
        },
        then: {
          $dateFromString: {
            dateString: field,
            format: '%Y-%m-%d',
            onError: null,
            onNull: null,
          },
        },
      },
      {
        case: {
          $regexMatch: {
            input: { $ifNull: [field, ''] },
            regex: /^\d{2}\.\d{2}\.\d{4}$/,
          },
        },
        then: {
          $dateFromString: {
            dateString: field,
            format: '%d.%m.%Y',
            onError: null,
            onNull: null,
          },
        },
      },
      {
        case: {
          $regexMatch: {
            input: { $ifNull: [field, ''] },
            regex: /^\d{2}-\d{2}-\d{4}$/,
          },
        },
        then: {
          $dateFromString: {
            dateString: field,
            format: '%d-%m-%Y',
            onError: null,
            onNull: null,
          },
        },
      },
    ],
    default: null,
  },
});

const buildCustomerLookup = (req) => ({
  $lookup: {
    from: Customer.collection.name,
    let: { customerId: '$customerId' },
    pipeline: [
      {
        $match: {
          $expr: { $eq: ['$_id', '$$customerId'] },
          ...getAggregationTenantFilter(req),
        },
      },
      {
        $project: {
          name: 1,
          email: 1,
          phone: 1,
          companyName: 1,
          gstin: 1,
        },
      },
    ],
    as: 'customerData',
  },
});

// ==================================================
// 2. GET RENEWALS
// One endpoint for Paid, Unpaid and All
// ==================================================

exports.getRenewals = async (req, res) => {
  try {
    const q = req.query;
    const { page, limit, skip } = paging(q);
    const nMonths = getNMonths(q.nMonths);
    const todayUTC = getTodayUTC();

    const section = ['paid', 'unpaid', 'all'].includes(q.section)
      ? q.section
      : 'unpaid';

    const baseMatch = {
      ...getAggregationTenantFilter(req),
      productType: 'Renewal',
      deactive: q.deactive === 'true',
    };

    if (q.customerId) {
      if (!isValidId(q.customerId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid customer ID',
        });
      }

      baseMatch.customerId = new mongoose.Types.ObjectId(q.customerId);
    }

    const year =
      q.year && q.year !== 'all'
        ? String(q.year).trim()
        : null;

    const month =
      q.month && q.month !== 'all'
        ? String(q.month).padStart(2, '0')
        : null;

    if (
      (year && !/^\d{4}$/.test(year)) ||
      (month && (!/^\d{2}$/.test(month) || Number(month) > 12 || Number(month) < 1))
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid month or year filter',
      });
    }

    const pipeline = [
      { $match: baseMatch },

      buildCustomerLookup(req),

      // Exclude products whose Customer record was deleted.
      { $unwind: '$customerData' },

      {
        $lookup: {
          from: Order.collection.name,
          localField: 'orderId',
          foreignField: '_id',
          pipeline: [
            {
              $project: {
                domainUrl: 1,
                orderDate: 1,
                customerDetails: 1,
              },
            },
          ],
          as: 'orderData',
        },
      },

      {
        $unwind: {
          path: '$orderData',
          preserveNullAndEmptyArrays: true,
        },
      },

      // Resolve selected cycle:
      // If an upcoming renewal cycle exists, evaluate it.
      // Otherwise evaluate the active cycle or the root plan cycle.
      {
        $addFields: {
          _history: { $ifNull: ['$renewalHistory', []] },
          _rootStartUTC: mongoDateExpression('$startDate'),
          _rootEndUTC: mongoDateExpression('$endDate'),
        },
      },

      {
        $addFields: {
          _upcomingCycles: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: { $eq: ['$$cycle.renewalStatus', 'upcoming'] },
            },
          },
          _paidUpcomingCycles: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: {
                $and: [
                  { $eq: ['$$cycle.renewalStatus', 'upcoming'] },
                  { $gt: [{ $ifNull: ['$$cycle.totalAmount', 0] }, 0] },
                  {
                    $gte: [
                      { $ifNull: ['$$cycle.paidAmount', 0] },
                      { $ifNull: ['$$cycle.totalAmount', 0] },
                    ],
                  },
                ],
              },
            },
          },
          _unpaidUpcomingCycles: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: {
                $and: [
                  { $eq: ['$$cycle.renewalStatus', 'upcoming'] },
                  {
                    $or: [
                      { $lte: [{ $ifNull: ['$$cycle.paidAmount', 0] }, 0] },
                      {
                        $lt: [
                          { $ifNull: ['$$cycle.paidAmount', 0] },
                          { $ifNull: ['$$cycle.totalAmount', 0] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          _activeCycles: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: { $eq: ['$$cycle.renewalStatus', 'active'] },
            },
          },
          _completedCycles: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: { $eq: ['$$cycle.renewalStatus', 'complete'] },
            },
          },
        },
      },

      {
        $addFields: {
          _hasPaidUpcoming: {
            $and: [
              { $gt: [{ $size: '$_paidUpcomingCycles' }, 0] },
              {
                $or: [
                  { $eq: ['$_rootEndUTC', null] },
                  { $gte: ['$_rootEndUTC', todayUTC] },
                ],
              },
            ],
          },
        },
      },

      {
        $addFields: {
          _currentCycle: {
            $cond: [
              '$_hasPaidUpcoming',
              { $arrayElemAt: ['$_paidUpcomingCycles', 0] },
              {
                $ifNull: [
                  { $arrayElemAt: ['$_unpaidUpcomingCycles', 0] },
                  {
                    $ifNull: [
                      { $arrayElemAt: ['$_activeCycles', 0] },
                      { $arrayElemAt: ['$_history', -1] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },

      {
        $addFields: {
          _startUTC: {
            $ifNull: [
              mongoDateExpression('$_currentCycle.startDate'),
              '$_rootStartUTC',
            ],
          },
          _endUTC: {
            $ifNull: [
              mongoDateExpression('$_currentCycle.endDate'),
              '$_rootEndUTC',
            ],
          },
          _targetPrice: {
            $ifNull: [
              '$_currentCycle.totalAmount',
              { $ifNull: ['$sellerPriceRenewal', { $ifNull: ['$price', 0] }] },
            ],
          },
          _totalPaidAmount: {
            $cond: [
              { $ne: ['$_currentCycle', null] },
              { $ifNull: ['$_currentCycle.paidAmount', 0] },
              {
                $reduce: {
                  input: { $ifNull: ['$paymentHistory', []] },
                  initialValue: 0,
                  in: {
                    $add: [
                      '$$value',
                      { $ifNull: ['$$this.amount', 0] },
                    ],
                  },
                },
              },
            ],
          },
          _cycleRenewalStatus: {
            $ifNull: [
              '$_currentCycle.renewalStatus',
              '$renewalStatus',
            ],
          },
        },
      },

      {
        $addFields: {
          _balanceDue: {
            $max: [
              0,
              { $subtract: ['$_targetPrice', '$_totalPaidAmount'] },
            ],
          },
          _isExpired: {
            $and: [
              { $ne: ['$_endUTC', null] },
              { $gt: [todayUTC, '$_endUTC'] },
            ],
          },
          _isInReminderWindow: {
            $and: [
              { $ne: ['$_endUTC', null] },
              {
                $gte: [
                  todayUTC,
                  {
                    $dateSubtract: {
                      startDate: '$_endUTC',
                      unit: 'month',
                      amount: nMonths,
                    },
                  },
                ],
              },
              { $lte: [todayUTC, '$_endUTC'] },
            ],
          },
        },
      },

      {
        $addFields: {
          isFullyPaid: {
            $and: [
              { $gt: ['$_targetPrice', 0] },
              { $lte: ['$_balanceDue', 0] },
            ],
          },
          isPartial: {
            $and: [
              { $gt: ['$_totalPaidAmount', 0] },
              { $gt: ['$_balanceDue', 0] },
            ],
          },
          isUnpaid: {
            $lte: ['$_totalPaidAmount', 0],
          },
        },
      },

      {
        $addFields: {
          paymentStatus: {
            $switch: {
              branches: [
                { case: '$isFullyPaid', then: 'Fully Paid' },
                { case: '$isPartial', then: 'Partially Paid' },
              ],
              default: 'Unpaid',
            },
          },

          renewalStatus: {
            $switch: {
              branches: [
                {
                  case: '$isFullyPaid',
                  then: 'renewed',
                },
                {
                  case: '$_isExpired',
                  then: 'not renewed',
                },
                {
                  case: { $gt: [todayUTC, '$_rootEndUTC'] },
                  then: 'not renewed',
                },
              ],
              default: 'upcoming',
            },
          },
        },
      },

      {
        $addFields: {
          qualifiesForPaid: {
            $and: [
              '$_hasPaidUpcoming',
              '$isFullyPaid',
              { $eq: ['$_balanceDue', 0] },
            ],
          },
          qualifiesForUnpaid: {
            $not: {
              $and: [
                '$_hasPaidUpcoming',
                '$isFullyPaid',
                { $eq: ['$_balanceDue', 0] },
              ],
            },
          },
        },
      },
    ];

    // Search
    if (q.search && typeof q.search === 'string') {
      const searchClean = q.search.trim();

      if (searchClean) {
        const safeRegex = new RegExp(escapeRegex(searchClean), 'i');

        pipeline.push({
          $match: {
            $or: [
              { product: safeRegex },
              { variant: safeRegex },
              { domainUrl: safeRegex },
              { 'orderData.domainUrl': safeRegex },
              { 'customerData.name': safeRegex },
              { 'customerData.email': safeRegex },
              { 'customerData.companyName': safeRegex },
            ],
          },
        });
      }
    }

    // Date filter uses the selected cycle's end date.
    if (year || month) {
      const dateConditions = [];

      if (year) {
        dateConditions.push({
          $eq: [{ $year: '$_endUTC' }, Number(year)],
        });
      }

      if (month) {
        dateConditions.push({
          $eq: [{ $month: '$_endUTC' }, Number(month)],
        });
      }

      pipeline.push({
        $match: {
          $expr: { $and: dateConditions },
        },
      });
    }

    const requestedStatus = normalizeStatus(
      q.renewalStatus || q.status
    );

    if (requestedStatus) {
      pipeline.push({
        $match: { renewalStatus: requestedStatus },
      });
    }

    const paidMatch = { qualifiesForPaid: true };
    const unpaidMatch = { qualifiesForUnpaid: true };

    const sectionMatch =
      section === 'paid'
        ? paidMatch
        : section === 'unpaid'
          ? unpaidMatch
          : {};

    const projection = {
      id: '$_id',
      orderId: '$orderData',
      customerId: '$customerData',

      customerName: {
        $ifNull: ['$customerData.name', 'Customer'],
      },
      email: { $ifNull: ['$customerData.email', []] },
      phone: { $ifNull: ['$customerData.phone', []] },

      product: 1,
      variant: 1,
      price: 1,
      costPrice: 1,
      quantity: 1,
      billingCycle: 1,
      cycleCount: 1,
      paymentStage: 1,
      sellerPriceRenewal: 1,
      costPriceRenewal: 1,
      reminder: 1,
      deactive: 1,
      deactiveYear: 1,
      deactiveDate: 1,
      domainUrl: 1,
      renewalHistory: 1,
      paymentHistory: 1,
      createdAt: 1,

      startDate: {
        $ifNull: ['$_currentCycle.startDate', '$startDate'],
      },
      endDate: {
        $ifNull: ['$_currentCycle.endDate', '$endDate'],
      },

      renewalStatus: 1,
      targetPrice: '$_targetPrice',
      totalPaidAmount: '$_totalPaidAmount',
      balanceDue: '$_balanceDue',
      paymentStatus: 1,
      isFullyPaid: 1,
      isPartial: 1,
      isUnpaid: 1,
      isExpired: '$_isExpired',
      isInReminderWindow: '$_isInReminderWindow',

      currentCycle: '$_currentCycle',

      displayDate: '$_startUTC',
      dateLabel: 'Start Date',
      badgeText: {
        $switch: {
          branches: [
            { case: '$isFullyPaid', then: 'RENEWED' },
            {
              case: {
                $and: [
                  '$isUnpaid',
                  { $eq: [{ $size: '$_completedCycles' }, 0] },
                  { $eq: [{ $size: '$_upcomingCycles' }, 0] },
                ],
              },
              then: 'NOT STARTED',
            },
            { case: '$_isExpired', then: 'EXPIRED' },
            { case: { $gt: [todayUTC, '$_rootEndUTC'] }, then: 'EXPIRED' },
          ],
          default: 'UPCOMING',
        },
      },
      renewalPayment: {
        $switch: {
          branches: [
            { case: '$isFullyPaid', then: 'paid' },
            { case: '$isPartial', then: 'partial' },
          ],
          default: 'unpaid',
        },
      },

      // For an advance-paid upcoming cycle, display its start date
      // as the effective renewed-through date.
      displayEndDate: {
        $cond: [
          { $eq: ['$_cycleRenewalStatus', 'upcoming'] },
          '$_currentCycle.startDate',
          { $ifNull: ['$_currentCycle.endDate', '$endDate'] },
        ],
      },
    };

    pipeline.push({
      $facet: {
        data: [
          ...(section === 'all' ? [] : [{ $match: sectionMatch }]),
          {
            $sort:
              section === 'paid'
                ? { _startUTC: -1, _id: 1 }
                : { _endUTC: 1, _id: 1 },
          },
          { $skip: skip },
          { $limit: limit },
          { $project: projection },
        ],

        paidStats: [
          { $match: paidMatch },
          { $count: 'count' },
        ],

        unpaidStats: [
          { $match: unpaidMatch },
          { $count: 'count' },
        ],

        allStats: [{ $count: 'count' }],

        statusStats: [
          {
            $group: {
              _id: '$renewalStatus',
              count: { $sum: 1 },
              totalValue: { $sum: '$_targetPrice' },
            },
          },
        ],
      },
    });

    const [result] = await CustomerProduct.aggregate(pipeline)
      .allowDiskUse(true);

    const data = result?.data || [];
    const paidCount = result?.paidStats?.[0]?.count || 0;
    const unpaidCount = result?.unpaidStats?.[0]?.count || 0;
    const allCount = result?.allStats?.[0]?.count || 0;

    const currentTotal =
      section === 'paid'
        ? paidCount
        : section === 'unpaid'
          ? unpaidCount
          : allCount;

    const totalPages = Math.ceil(currentTotal / limit) || 1;

    const plan = {
      renewed: { count: 0, totalValue: 0 },
      upcoming: { count: 0, totalValue: 0 },
      'yearly renewed': { count: 0, totalValue: 0 },
      'not renewed': { count: 0, totalValue: 0 },
    };

    (result?.statusStats || []).forEach((item) => {
      if (plan[item._id]) {
        plan[item._id].count = item.count;
        plan[item._id].totalValue = item.totalValue;
      }
    });

    const paidData =
      section === 'paid'
        ? data.filter((item) => item.isFullyPaid)
        : section === 'all'
          ? data.filter((item) => item.isFullyPaid)
          : [];

    const unpaidData =
      section === 'unpaid'
        ? data.filter((item) => !item.isFullyPaid)
        : section === 'all'
          ? data.filter((item) => !item.isFullyPaid)
          : [];

    return res.json({
      success: true,

      summary: {
        total: allCount,
        paidCount,
        unpaidCount,
        evaluatedInPage: data.length,
        upcomingCount: plan.upcoming.count,
        notRenewalCount: plan['not renewed'].count,
      },

      plan,
      paid: paidData,
      unpaid: unpaidData,
      data,

      pagination: {
        page,
        limit,
        total: currentTotal,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    console.error('[RenewalController] getRenewals:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch renewals',
    });
  }
};

// ==================================================
// 3. GET RENEWAL PLAN
// ==================================================

exports.getRenewalPlan = async (req, res) => {
  try {
    const match = {
      ...getAggregationTenantFilter(req),
      productType: 'Renewal',
      deactive: false,
    };

    const stats = await CustomerProduct.aggregate([
      { $match: match },

      {
        $addFields: {
          _history: { $ifNull: ['$renewalHistory', []] },
        },
      },

      {
        $addFields: {
          _active: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: { $eq: ['$$cycle.renewalStatus', 'active'] },
            },
          },
          _upcoming: {
            $filter: {
              input: '$_history',
              as: 'cycle',
              cond: { $eq: ['$$cycle.renewalStatus', 'upcoming'] },
            },
          },
        },
      },

      {
        $addFields: {
          _cycle: {
            $ifNull: [
              { $arrayElemAt: ['$_upcoming', 0] },
              {
                $ifNull: [
                  { $arrayElemAt: ['$_active', 0] },
                  { $arrayElemAt: ['$_history', -1] },
                ],
              },
            ],
          },
        },
      },

      {
        $addFields: {
          _status: {
            $ifNull: ['$_cycle.renewalStatus', '$renewalStatus'],
          },
          _amount: {
            $ifNull: [
              '$_cycle.totalAmount',
              { $ifNull: ['$sellerPriceRenewal', { $ifNull: ['$price', 0] }] },
            ],
          },
        },
      },

      {
        $group: {
          _id: '$_status',
          count: { $sum: 1 },
          totalValue: { $sum: '$_amount' },
        },
      },
    ]);

    const plan = {
      renewed: { count: 0, totalValue: 0 },
      upcoming: { count: 0, totalValue: 0 },
      'yearly renewed': { count: 0, totalValue: 0 },
      'not renewed': { count: 0, totalValue: 0 },
      not_renewal: { count: 0, totalValue: 0 },
      active: { count: 0, totalValue: 0 },
      complete: { count: 0, totalValue: 0 },
    };

    stats.forEach((item) => {
      if (plan[item._id]) {
        plan[item._id].count += item.count;
        plan[item._id].totalValue += item.totalValue;
      } else {
        const normalized = normalizeStatus(item._id);

        if (normalized && plan[normalized]) {
          plan[normalized].count += item.count;
          plan[normalized].totalValue += item.totalValue;
        }
      }
    });

    return res.json({ success: true, plan });
  } catch (err) {
    console.error('[RenewalController] getRenewalPlan:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch renewal statistics',
    });
  }
};

// ==================================================
// 4. UPDATE RENEWAL STATUS
// Legacy/manual root status endpoint
// ==================================================

exports.updateRenewalStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID',
      });
    }

    const newStatus = normalizeStatus(
      req.body.renewalStatus || req.body.status
    );

    if (!newStatus) {
      return res.status(400).json({
        success: false,
        message:
          'Allowed statuses: upcoming, yearly renewed, renewed, not renewed',
      });
    }

    const updated = await CustomerProduct.findOneAndUpdate(
      {
        _id: id,
        ...getTenantFilter(req),
        productType: 'Renewal',
      },
      {
        $set: { renewalStatus: newStatus },
      },
      {
        new: true,
        runValidators: true,
      }
    )
      .select('product variant renewalStatus reminder startDate endDate productType')
      .lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Renewal product not found',
      });
    }

    return res.json({
      success: true,
      message: `Renewal status updated to ${newStatus}`,
      data: updated,
    });
  } catch (err) {
    console.error('[RenewalController] updateRenewalStatus:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to update renewal status',
    });
  }
};

// ==================================================
// 5. EXECUTE RENEWAL / RECORD CYCLE PAYMENT
// ==================================================

exports.executeRenewal = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID',
      });
    }

    const filter = {
      _id: id,
      ...getTenantFilter(req),
      productType: 'Renewal',
    };

    const doc = await CustomerProduct.findOne(filter)
      .select(
        '_id customerId orderId startDate endDate billingCycle renewalHistory paymentHistory price sellerPriceRenewal renewalStatus __v'
      )
      .lean();

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Customer product not found',
      });
    }

    const todayUTC = getTodayUTC();

    const cycle = String(
      req.body.billingCycle || doc.billingCycle || 'yearly'
    ).toLowerCase();

    if (!['monthly', 'yearly'].includes(cycle)) {
      return res.status(400).json({
        success: false,
        message: 'Unsupported billing cycle',
      });
    }

    const history = Array.isArray(doc.renewalHistory)
      ? doc.renewalHistory.map((item) => ({
          ...item,
          paymentStages: Array.isArray(item.paymentStages)
            ? [...item.paymentStages]
            : [],
        }))
      : [];

    let cycleIndex = -1;
    let targetCycle = null;

    // If the caller specifies a cycle number, use that exact cycle.
    if (req.body.cycleNumber !== undefined) {
      cycleIndex = getCycleIndex(history, req.body.cycleNumber);

      if (cycleIndex === -1) {
        return res.status(404).json({
          success: false,
          message: 'Requested renewal cycle not found',
        });
      }

      targetCycle = history[cycleIndex];
    } else {
      // Prefer an existing upcoming cycle, then active cycle.
      cycleIndex = history.findIndex(
        (item) => item.renewalStatus === 'upcoming'
      );

      if (cycleIndex === -1) {
        cycleIndex = history.findIndex(
          (item) => item.renewalStatus === 'active'
        );
      }

      if (cycleIndex !== -1) {
        targetCycle = history[cycleIndex];
      }
    }

    // Create a cycle only if there is no reusable cycle.
    if (!targetCycle) {
      const rootEndUTC = parseDateToUTC(doc.endDate);

      if (!rootEndUTC) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or missing current renewal end date',
        });
      }

      const { startDate, endDate } = getNextCycleDates(
        rootEndUTC,
        cycle
      );

      const cycleTotalAmount =
        req.body.price !== undefined
          ? validateAmount(req.body.price, 'price')
          : getCycleAmount(doc);

      targetCycle = {
        cycleNumber: history.length + 1,
        startDate: formatToDotDate(startDate),
        endDate: formatToDotDate(endDate),
        totalAmount: cycleTotalAmount,
        paidAmount: 0,
        paymentStatus: 'Unpaid',
        renewalStatus: 'upcoming',
        paymentStages: [],
      };

      history.push(targetCycle);
      cycleIndex = history.length - 1;
    }

    if (targetCycle.renewalStatus === 'complete') {
      return res.status(409).json({
        success: false,
        message: 'Cannot add payment to a completed renewal cycle',
      });
    }

    const cycleStartUTC = parseDateToUTC(targetCycle.startDate);
    const cycleEndUTC = parseDateToUTC(targetCycle.endDate);

    if (!cycleStartUTC || !cycleEndUTC || cycleEndUTC < cycleStartUTC) {
      return res.status(400).json({
        success: false,
        message: 'Renewal cycle has invalid dates',
      });
    }

    const totalAmount = validateAmount(
      targetCycle.totalAmount,
      'cycle total amount'
    );

    const alreadyPaid = validateAmount(
      targetCycle.paidAmount || 0,
      'existing paid amount'
    );

    const paidAmountValue =
      req.body.paidAmount !== undefined
        ? req.body.paidAmount
        : req.body.amount;

    const paidAmount =
      paidAmountValue !== undefined
        ? validateAmount(paidAmountValue, 'paid amount')
        : 0;

    const remainingAmount = Math.max(0, totalAmount - alreadyPaid);

    if (paidAmount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Payment exceeds pending balance. Pending amount: ${remainingAmount}`,
      });
    }

    const paymentStage = req.body.paymentStage || 'full';

    if (!['advance', 'mid', 'final', 'full'].includes(paymentStage)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment stage',
      });
    }

    let paymentDate = null;

    if (paidAmount > 0) {
      paymentDate =
        req.body.paymentDate || req.body.date
          ? parseDateToUTC(req.body.paymentDate || req.body.date)
          : todayUTC;

      if (!paymentDate) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment date',
        });
      }

      const stageItem = {
        payDate: formatToDotDate(paymentDate),
        stage: paymentStage,
        stageNumber: Number(req.body.stageNumber) || 1,
        amount: paidAmount,
        withGst: Boolean(req.body.withGst),
        gstvalue: Number(req.body.gstvalue) || 0,
        description:
          req.body.description || 'Renewal payment received',
      };

      targetCycle.paymentStages.push(stageItem);
      targetCycle.paidAmount = alreadyPaid + paidAmount;
    } else {
      targetCycle.paidAmount = alreadyPaid;
    }

    targetCycle.totalAmount = totalAmount;
    targetCycle.paymentStatus = getCycleStatus(targetCycle);

    history[cycleIndex] = targetCycle;

    // IMPORTANT:
    // Do not update root startDate/endDate here.
    // Upcoming cycle payment must not change the currently active cycle.
    const update = {
      $set: {
        renewalHistory: history,
        billingCycle: cycle,
      },
    };

    // Maintain old paymentHistory only for backward compatibility.
    // It is not used for cycle-level calculations when renewalHistory exists.
    if (paidAmount > 0) {
      update.$push = {
        paymentHistory: {
          date: formatToDotDate(paymentDate),
          amount: paidAmount,
          withGst: Boolean(req.body.withGst),
          gstvalue: Number(req.body.gstvalue) || 0,
          paymentStage,
          stageNumber: Number(req.body.stageNumber) || 1,
          description:
            req.body.description || 'Renewal payment received',
        },
      };
    }

    const atomicFilter = {
      ...filter,
      endDate: doc.endDate,
    };

    if (typeof doc.__v === 'number') {
      atomicFilter.__v = doc.__v;
      update.$inc = { __v: 1 };
    }

    const updated = await CustomerProduct.findOneAndUpdate(
      atomicFilter,
      update,
      {
        new: true,
        runValidators: true,
      }
    ).lean();

    if (!updated) {
      return res.status(409).json({
        success: false,
        message:
          'Renewal already processed or record changed. Refresh and retry.',
      });
    }

    return res.json({
      success: true,
      message:
        targetCycle.paymentStatus === 'Paid'
          ? 'Renewal cycle fully paid'
          : paidAmount > 0
            ? 'Renewal payment recorded successfully'
            : 'Renewal cycle created successfully',
      data: updated,
      cycle: targetCycle,
      payment: {
        totalAmount,
        paidAmount: targetCycle.paidAmount,
        balanceDue: Math.max(
          0,
          totalAmount - targetCycle.paidAmount
        ),
        paymentStatus: targetCycle.paymentStatus,
      },
    });
  } catch (err) {
    console.error('[RenewalController] executeRenewal:', err);

    const isClientError =
      err.message.startsWith('Invalid ') ||
      err.message === 'Unsupported billing cycle';

    return res.status(isClientError ? 400 : 500).json({
      success: false,
      message: isClientError
        ? err.message
        : 'Failed to execute renewal',
    });
  }
};

// ==================================================
// 6. AUTOMATIC RENEWAL CYCLE PROCESSOR
// Run this from a daily scheduled job.
// ==================================================

exports.processRenewalCycles = async () => {
  const todayUTC = getTodayUTC();

  const cursor = CustomerProduct.find({
    productType: 'Renewal',
    deactive: false,
  })
    .select(
      '_id companyID startDate endDate billingCycle renewalHistory sellerPriceRenewal price renewalStatus __v'
    )
    .lean()
    .cursor({ batchSize: 200 });

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for await (const doc of cursor) {
      try {
        const history = Array.isArray(doc.renewalHistory)
          ? doc.renewalHistory.map((item) => ({
              ...item,
              paymentStages: Array.isArray(item.paymentStages)
                ? [...item.paymentStages]
                : [],
            }))
          : [];

        const rootStart = parseDateToUTC(doc.startDate);
        const rootEnd = parseDateToUTC(doc.endDate);

        if (!rootStart || !rootEnd || rootEnd < rootStart) {
          skipped++;
          continue;
        }

        const billingCycle = ['monthly', 'yearly'].includes(doc.billingCycle)
          ? doc.billingCycle
          : 'yearly';

        let changed = false;

        // Initialize legacy products with an active current cycle.
        if (history.length === 0) {
          history.push({
            cycleNumber: 1,
            startDate: formatToDotDate(rootStart),
            endDate: formatToDotDate(rootEnd),
            totalAmount: getCycleAmount(doc),
            paidAmount: 0,
            paymentStatus: 'Unpaid',
            renewalStatus: 'active',
            paymentStages: [],
          });

          changed = true;
        }

        let activeIndex = history.findIndex(
          (item) => item.renewalStatus === 'active'
        );

        // If the active cycle's end date has passed, activate the
        // next upcoming cycle only when its start date has arrived.
        const upcomingIndex = history.findIndex(
          (item) => item.renewalStatus === 'upcoming'
        );

        if (upcomingIndex !== -1) {
          const upcomingStart = parseDateToUTC(
            history[upcomingIndex].startDate
          );

          if (upcomingStart && upcomingStart <= todayUTC) {
            if (activeIndex !== -1) {
              history[activeIndex].renewalStatus = 'complete';
            }

            history[upcomingIndex].renewalStatus = 'active';

            const activatedStart = parseDateToUTC(
              history[upcomingIndex].startDate
            );
            const activatedEnd = parseDateToUTC(
              history[upcomingIndex].endDate
            );

            if (activatedStart && activatedEnd) {
              // Root dates change only when the new cycle becomes active.
              doc.startDate = formatToDotDate(activatedStart);
              doc.endDate = formatToDotDate(activatedEnd);
              activeIndex = upcomingIndex;
              changed = true;
            }
          }
        }

        if (activeIndex === -1) {
          activeIndex = history.findIndex(
            (item) => item.renewalStatus === 'active'
          );
        }

        if (activeIndex === -1) {
          skipped++;
          continue;
        }

        const activeEnd = parseDateToUTC(
          history[activeIndex].endDate
        );

        if (!activeEnd) {
          skipped++;
          continue;
        }

        // Create the next cycle 30 days before current expiry.
        const creationDate = addDaysUTC(activeEnd, -30);

        const existingNextCycle = history.some((item) => {
          const itemStart = parseDateToUTC(item.startDate);

          return (
            itemStart &&
            itemStart.getTime() === addDaysUTC(activeEnd, 1).getTime()
          );
        });

        if (
          todayUTC >= creationDate &&
          todayUTC <= activeEnd &&
          !existingNextCycle
        ) {
          const { startDate, endDate } = getNextCycleDates(
            activeEnd,
            billingCycle
          );

          history.push({
            cycleNumber:
              Math.max(
                0,
                ...history.map((item) => Number(item.cycleNumber) || 0)
              ) + 1,
            startDate: formatToDotDate(startDate),
            endDate: formatToDotDate(endDate),
            totalAmount: getCycleAmount(doc),
            paidAmount: 0,
            paymentStatus: 'Unpaid',
            renewalStatus: 'upcoming',
            paymentStages: [],
          });

          changed = true;
        }

        if (!changed) {
          skipped++;
          continue;
        }

        const update = {
          $set: {
            renewalHistory: history,
          },
          $inc: { __v: 1 },
        };

        if (doc.startDate !== undefined) {
          update.$set.startDate = doc.startDate;
        }

        if (doc.endDate !== undefined) {
          update.$set.endDate = doc.endDate;
        }

        const atomicFilter = { _id: doc._id };

        if (typeof doc.__v === 'number') {
          atomicFilter.__v = doc.__v;
        }

        const result = await CustomerProduct.updateOne(
          atomicFilter,
          update,
          { runValidators: true }
        );

        if (result.modifiedCount === 1) {
          processed++;
        } else {
          skipped++;
        }
      } catch (itemError) {
        failed++;

        console.error(
          '[RenewalController] Cycle processing error:',
          doc._id,
          itemError.message
        );
      }
    }
  } finally {
    await cursor.close();
  }

  return {
    success: true,
    processed,
    skipped,
    failed,
    date: formatToDotDate(todayUTC),
  };
};

// ==================================================
// 7. EXPORT RENEWALS TO EXCEL
// ==================================================

exports.exportRenewals = async (req, res) => {
  try {
    const filter = {
      ...getTenantFilter(req),
      productType: 'Renewal',
      deactive: false,
    };

    const items = await CustomerProduct.find(filter)
      .select(
        'customerId orderId domainUrl product variant price sellerPriceRenewal startDate endDate renewalStatus reminder renewalHistory'
      )
      .populate({
        path: 'customerId',
        select: 'name email phone companyName',
        match: getTenantFilter(req),
      })
      .populate({
        path: 'orderId',
        select: 'domainUrl customerDetails',
      })
      .sort({ endDate: 1, _id: 1 })
      .limit(MAX_EXPORT_ROWS + 1)
      .lean();

    if (items.length > MAX_EXPORT_ROWS) {
      return res.status(413).json({
        success: false,
        message: `Export is limited to ${MAX_EXPORT_ROWS} records. Use paginated exports for larger datasets.`,
      });
    }

    // Exclude deleted or non-matching tenant customers.
    const validItems = items.filter((item) => item.customerId);

    const rows = validItems.map((item, index) => {
      const cycle = getSelectedCycle(item.renewalHistory || []);
      const customer = item.customerId;

      return {
        'S.No': index + 1,
        Customer: customer?.name || '—',
        Domain:
          item.domainUrl ||
          item.orderId?.domainUrl ||
          '—',
        Product: item.product || '—',
        Variant: item.variant || '—',
        Price:
          cycle?.totalAmount ??
          item.sellerPriceRenewal ??
          item.price ??
          0,
        'Paid Amount': cycle?.paidAmount ?? 0,
        'Payment Status':
          cycle?.paymentStatus || 'Unpaid',
        'Start Date': cycle?.startDate || item.startDate || '—',
        'End Date': cycle?.endDate || item.endDate || '—',
        'Renewal Status':
          cycle?.renewalStatus ||
          normalizeStatus(item.renewalStatus) ||
          'upcoming',
        Reminder: item.reminder || 'None',
      };
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);

    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      'Renewals'
    );

    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    });

    res.setHeader(
      'Content-Disposition',
      `attachment; filename=Renewals_${Date.now()}.xlsx`
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader('Content-Length', buffer.length);

    return res.send(buffer);
  } catch (err) {
    console.error('[RenewalController] exportRenewals:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to export renewals',
    });
  }
};

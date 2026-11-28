const Customer = require('../../models/Customer');
const CustomerProduct = require('../../models/CustomerProduct');
const Order = require('../../models/Order');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^(0[1-9]|1[0-2])$/;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AGG_OPTS = { allowDiskUse: true };

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// empty string / missing -> null
const nonEmptyStr = (f) => ({
  $cond: [{ $gt: [{ $strLenCP: { $ifNull: [f, ''] } }, 0] }, f, null],
});

const buildRange = (s, e) => {
  const r = {};
  if (s) r.$gte = s;
  if (e) r.$lte = e;
  return Object.keys(r).length ? r : null;
};

// createdAt / updatedAt are Date objects -> convert IST day boundaries
const buildDateObjRange = (s, e) => {
  const r = {};
  if (s) r.$gte = new Date(`${s}T00:00:00+05:30`);
  if (e) r.$lte = new Date(`${e}T23:59:59.999+05:30`);
  return Object.keys(r).length ? r : null;
};

const getDaysInMonth = (year, month) => {
  const y = Number(year);
  const m = Number(month);
  return new Date(y, m, 0).getDate();
};

const formatBucketLabel = (key, granularity) => {
  if (granularity === 'day') return key.slice(8, 10); // DD
  if (granularity === 'month') {
    const idx = parseInt(key.slice(5, 7), 10) - 1;
    return MONTH_LABELS[idx] || key;
  }
  // 'year-month' -> "Jan 2026"
  const yr = key.slice(0, 4);
  const idx = parseInt(key.slice(5, 7), 10) - 1;
  return `${MONTH_LABELS[idx] || key.slice(5, 7)} ${yr}`;
};

// Resolve startDate, endDate, and chart bucket granularity from query params
const resolveTimeWindow = (query) => {
  const { startDate, endDate, filterMode, year, month } = query;

  if ((startDate && !DATE_RE.test(startDate)) || (endDate && !DATE_RE.test(endDate))) {
    return { error: 'Dates must be YYYY-MM-DD' };
  }

  if (startDate || endDate) {
    const sameMonth =
      startDate &&
      endDate &&
      startDate.slice(0, 7) === endDate.slice(0, 7);
    const sameYear =
      startDate &&
      endDate &&
      startDate.slice(0, 4) === endDate.slice(0, 4);

    return {
      startDate: startDate || null,
      endDate: endDate || null,
      granularity: sameMonth ? 'day' : sameYear ? 'month' : 'year-month',
      seedYear: sameYear ? startDate.slice(0, 4) : null,
      seedMonth: sameMonth ? startDate.slice(5, 7) : null,
    };
  }

  if (filterMode === 'month') {
    const yr = YEAR_RE.test(year || '') ? year : String(new Date().getFullYear());
    const mo = MONTH_RE.test(month || '') ? month : String(new Date().getMonth() + 1).padStart(2, '0');
    const lastDay = String(getDaysInMonth(yr, mo)).padStart(2, '0');
    return {
      startDate: `${yr}-${mo}-01`,
      endDate: `${yr}-${mo}-${lastDay}`,
      granularity: 'day',
      seedYear: yr,
      seedMonth: mo,
    };
  }

  if (filterMode === 'year') {
    const yr = YEAR_RE.test(year || '') ? year : String(new Date().getFullYear());
    return {
      startDate: `${yr}-01-01`,
      endDate: `${yr}-12-31`,
      granularity: 'month',
      seedYear: yr,
      seedMonth: null,
    };
  }

  // 'all' or no time filter
  return {
    startDate: null,
    endDate: null,
    granularity: 'year-month',
    seedYear: null,
    seedMonth: null,
  };
};

// GET /reports
const getReportData = async (req, res) => {
  try {
    const windowCfg = resolveTimeWindow(req.query);
    if (windowCfg.error) {
      return res.status(400).json({ message: windowCfg.error });
    }

    const { startDate, endDate, granularity, seedYear, seedMonth } = windowCfg;
    const range = buildRange(startDate, endDate);
    const rangeCond = range || { $ne: null };
    const dateObjRange = buildDateObjRange(startDate, endDate);

    // Pre-filter Order IDs using indexed orderDate when a time range is active
    let cpBaseMatch = [];
    if (range) {
      const orderIdsInRange = await Order.find({ orderDate: range }).distinct('_id');
      cpBaseMatch = [
        {
          $match: {
            $or: [
              { orderId: { $in: orderIdsInRange } },
              { startDate: range },
              { createdAt: dateObjRange },
            ],
          },
        },
      ];
    }

    // ── 1. Customers Query (uses createdAt index, minimal projection) ───────
    const customerPipeline = [
      ...(dateObjRange ? [{ $match: { createdAt: dateObjRange } }] : []),
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $project: {
          name: 1,
          email: { $ifNull: [{ $arrayElemAt: ['$email', 0] }, ''] },
          phone: { $ifNull: [{ $arrayElemAt: ['$phone', 0] }, ''] },
          createdAtStr: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' },
          },
        },
      },
    ];

    // ── 2. Orders Query (separate pipeline, no paymentHistory/renewalHistory) ─
    const orderPipeline = [
      ...cpBaseMatch,
      {
        $lookup: {
          from: Order.collection.name,
          let: { oid: '$orderId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$oid'] } } },
            { $project: { orderDate: 1, 'customerDetails.name': 1 } },
          ],
          as: 'order',
        },
      },
      { $addFields: { order: { $arrayElemAt: ['$order', 0] } } },
      {
        $addFields: {
          orderDate: {
            $ifNull: [
              nonEmptyStr('$order.orderDate'),
              {
                $ifNull: [
                  nonEmptyStr('$startDate'),
                  { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
                ],
              },
            ],
          },
        },
      },
      { $match: { orderDate: rangeCond } },
      { $sort: { orderDate: -1, _id: -1 } },
      {
        $project: {
          orderId: 1,
          customerId: 1,
          fallbackName: {
            $ifNull: [nonEmptyStr('$customerDetails.name'), nonEmptyStr('$order.customerDetails.name')],
          },
          orderDate: 1,
          product: 1,
          variant: 1,
          domainUrl: { $ifNull: ['$domainUrl', ''] },
          totalPrice: {
            $multiply: [
              { $ifNull: ['$price', 0] },
              { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 1] },
            ],
          },
        },
      },
    ];

    // ── 3. Active Domains Query (separate pipeline, early deactive + domain filter) ─
    const activeDomainPipeline = [
      {
        $match: {
          deactive: { $ne: true },
          domainUrl: { $type: 'string', $gt: '' },
          ...(range
            ? {
                $or: [
                  { startDate: range },
                  { createdAt: dateObjRange },
                ],
              }
            : {}),
        },
      },
      {
        $addFields: {
          effectiveStartDate: {
            $ifNull: [
              nonEmptyStr('$startDate'),
              { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
            ],
          },
        },
      },
      { $match: { effectiveStartDate: rangeCond } },
      { $sort: { effectiveStartDate: -1, _id: -1 } },
      {
        $project: {
          customerId: 1,
          fallbackName: nonEmptyStr('$customerDetails.name'),
          domainUrl: 1,
          orderDate: '$effectiveStartDate',
          endDate: { $ifNull: ['$endDate', ''] },
        },
      },
    ];

    // ── 4. Deactive Domains Query (separate pipeline, early deactive: true filter) ─
    const deactiveDomainPipeline = [
      {
        $match: {
          deactive: true,
          domainUrl: { $type: 'string', $gt: '' },
          ...(range
            ? {
                $or: [
                  { deactiveDate: range },
                  { deactiveDate: { $in: ['', null] }, updatedAt: dateObjRange },
                ],
              }
            : {}),
        },
      },
      {
        $addFields: {
          effectiveDeactiveDate: {
            $ifNull: [
              nonEmptyStr('$deactiveDate'),
              { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt', timezone: 'Asia/Kolkata' } },
            ],
          },
          effectiveOrderDate: {
            $ifNull: [
              nonEmptyStr('$startDate'),
              { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
            ],
          },
        },
      },
      { $match: { effectiveDeactiveDate: rangeCond } },
      { $sort: { effectiveDeactiveDate: -1, _id: -1 } },
      {
        $project: {
          customerId: 1,
          fallbackName: nonEmptyStr('$customerDetails.name'),
          domainUrl: 1,
          orderDate: '$effectiveOrderDate',
          deactiveDate: '$effectiveDeactiveDate',
        },
      },
    ];

    // ── 5. Available Years Query (lightweight min-year lookup) ──────────────
    const minYearPipeline = [
      {
        $project: {
          y: {
            $substrCP: [
              {
                $ifNull: [
                  nonEmptyStr('$startDate'),
                  { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
                ],
              },
              0,
              4,
            ],
          },
        },
      },
      { $match: { y: { $gte: '2000' } } },
      { $group: { _id: null, minYear: { $min: '$y' } } },
    ];

    const [customerDocs, orderDocs, activeDomainDocs, deactiveDomainDocs, minYearAgg] =
      await Promise.all([
        Customer.aggregate(customerPipeline, AGG_OPTS),
        CustomerProduct.aggregate(orderPipeline, AGG_OPTS),
        CustomerProduct.aggregate(activeDomainPipeline, AGG_OPTS),
        CustomerProduct.aggregate(deactiveDomainPipeline, AGG_OPTS),
        CustomerProduct.aggregate(minYearPipeline, AGG_OPTS),
      ]);

    // ── Resolve Customer Names only for referenced IDs (lean + select) ──────
    const idSet = new Set();
    for (const d of [...orderDocs, ...activeDomainDocs, ...deactiveDomainDocs]) {
      if (d.customerId) idSet.add(String(d.customerId));
    }
    const refCustomers = idSet.size
      ? await Customer.find({ _id: { $in: [...idSet] } }).select('name').lean()
      : [];
    const nameMap = new Map(refCustomers.map((c) => [String(c._id), c.name]));
    const nameOf = (d) =>
      (d.customerId && nameMap.get(String(d.customerId))) || d.fallbackName || 'Unknown Customer';

    // ── Time-Bucket Builder (O(N) in-memory Map) ────────────────────────────
    const bucketMap = new Map();
    const getBucketKey = (dateStr) => {
      if (!dateStr || typeof dateStr !== 'string') return null;
      return granularity === 'day' ? dateStr.slice(0, 10) : dateStr.slice(0, 7);
    };
    const ensureBucket = (key) => {
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          key,
          label: formatBucketLabel(key, granularity),
          customers: 0,
          orders: 0,
          activeDomains: 0,
          deactiveDomains: 0,
        });
      }
      return bucketMap.get(key);
    };

    // Pre-seed continuous timeline for year / month views
    if (granularity === 'month' && seedYear) {
      for (let m = 1; m <= 12; m += 1) {
        ensureBucket(`${seedYear}-${String(m).padStart(2, '0')}`);
      }
    } else if (granularity === 'day' && seedYear && seedMonth) {
      const days = getDaysInMonth(seedYear, seedMonth);
      for (let d = 1; d <= days; d += 1) {
        ensureBucket(`${seedYear}-${seedMonth}-${String(d).padStart(2, '0')}`);
      }
    }

    // ── Shape Response Lists & Populate Buckets ─────────────────────────────
    const customers = customerDocs.map((c) => {
      const bKey = getBucketKey(c.createdAtStr);
      if (bKey) ensureBucket(bKey).customers += 1;
      return {
        id: String(c._id),
        createdAt: c.createdAtStr || '',
        name: c.name || 'Unknown Customer',
        email: c.email || '-',
        phone: c.phone || '-',
      };
    });

    const orders = orderDocs.map((o) => {
      const bKey = getBucketKey(o.orderDate);
      if (bKey) ensureBucket(bKey).orders += 1;
      const productName = [o.product, o.variant].filter(Boolean).join(' - ') || 'Service';
      return {
        id: String(o._id),
        orderId: o.orderId ? String(o.orderId) : String(o._id),
        orderDate: o.orderDate || '',
        customerName: nameOf(o),
        productName,
        domainUrl: o.domainUrl || '-',
        totalPrice: r2(o.totalPrice),
      };
    });

    const activeDomains = activeDomainDocs.map((d) => {
      const bKey = getBucketKey(d.orderDate);
      if (bKey) ensureBucket(bKey).activeDomains += 1;
      return {
        id: String(d._id),
        orderDate: d.orderDate || '',
        domainUrl: d.domainUrl || '-',
        customerName: nameOf(d),
        endDate: d.endDate || '-',
      };
    });

    const deactiveDomains = deactiveDomainDocs.map((d) => {
      const bKey = getBucketKey(d.deactiveDate);
      if (bKey) ensureBucket(bKey).deactiveDomains += 1;
      return {
        id: String(d._id),
        orderDate: d.orderDate || '',
        domainUrl: d.domainUrl || '-',
        customerName: nameOf(d),
        deactiveDate: d.deactiveDate || '-',
      };
    });

    const buckets = [...bucketMap.values()].sort((a, b) => a.key.localeCompare(b.key));

    const currentYear = new Date().getFullYear();
    const parsedMinYear = parseInt(minYearAgg[0]?.minYear, 10);
    const startYear = !isNaN(parsedMinYear) ? Math.min(parsedMinYear, currentYear) : currentYear;
    const availableYears = [];
    for (let y = currentYear; y >= startYear; y -= 1) {
      availableYears.push(String(y));
    }

    return res.json({
      buckets,
      customers,
      orders,
      activeDomains,
      deactiveDomains,
      counts: {
        customers: customers.length,
        orders: orders.length,
        activeDomains: activeDomains.length,
        deactiveDomains: deactiveDomains.length,
      },
      startYear,
      availableYears,
    });
  } catch (err) {
    console.error('[ReportController] getReportData error:', err);
    return res.status(500).json({ message: 'Failed to fetch report data' });
  }
};

module.exports = { getReportData };


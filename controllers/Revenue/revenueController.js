const CustomerProduct = require('../../models/CustomerProduct');
const Customer = require('../../models/Customer');
const Order = require('../../models/Order');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const STAGES = ['full', 'advance', 'mid', 'final'];

const statusOf = (billed, paid) =>
  paid <= 0 ? 'Unpaid' : paid >= billed ? 'Fully Paid' : 'Partially Paid';

const normStage = (s) => {
  const v = s === 'partial' ? 'mid' : s;
  return STAGES.includes(v) ? v : 'full';
};

// ── Aggregation expression helpers ──────────────────────────────────────────
// empty string / missing -> null
const nonEmptyStr = (f) => ({
  $cond: [{ $gt: [{ $strLenCP: { $ifNull: [f, ''] } }, 0] }, f, null],
});

// total paid (excl. GST) of ONE paymentHistory item (sub-payments if present, else its own amount)
const paidOfPh = (ph) => ({
  $cond: [
    { $gt: [{ $size: { $ifNull: [`${ph}.paymentHistory`, []] } }, 0] },
    { $sum: `${ph}.paymentHistory.amount` },
    { $ifNull: [`${ph}.amount`, 0] },
  ],
});

const buildRange = (s, e) => {
  const r = {};
  if (s) r.$gte = s;
  if (e) r.$lte = e;
  return Object.keys(r).length ? r : null;
};

// createdAt is a Date, so convert the IST day boundaries
const buildCreatedAtRange = (s, e) => {
  const r = {};
  if (s) r.$gte = new Date(`${s}T00:00:00+05:30`);
  if (e) r.$lte = new Date(`${e}T23:59:59.999+05:30`);
  return r;
};

const AGG_OPTS = { allowDiskUse: true };

// GET /revenue/orders
const getRevenueOrders = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if ((startDate && !DATE_RE.test(startDate)) || (endDate && !DATE_RE.test(endDate))) {
      return res.status(400).json({ message: 'Dates must be YYYY-MM-DD' });
    }

    const range = buildRange(startDate, endDate);
    const rangeCond = range || { $ne: null };

    // Orders in range (uses orderDate index) -> pre-filter for base sales
    let baseMatchStage = [];
    if (range) {
      const orderIdsInRange = await Order.find({ orderDate: range }).distinct('_id');
      baseMatchStage = [
        {
          $match: {
            $or: [
              { orderId: { $in: orderIdsInRange } },
              { startDate: range },
              { createdAt: buildCreatedAtRange(startDate, endDate) },
            ],
          },
        },
      ];
    }

    // ── 1. Base / one-time sales ────────────────────────────────────────────
    const basePipeline = [
      ...baseMatchStage,
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
          baseDate: {
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
      { $match: { baseDate: rangeCond } },
      {
        $project: {
          orderId: 1,
          customerId: 1,
          fallbackName: {
            $ifNull: [nonEmptyStr('$customerDetails.name'), nonEmptyStr('$order.customerDetails.name')],
          },
          baseDate: 1,
          product: 1,
          variant: 1,
          domainUrl: 1,
          productType: 1,
          oneTimePayment: 1,
          paymentStage: 1,
          quantity: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 1] },
          baseSelling: {
            $multiply: [
              { $ifNull: ['$price', 0] },
              { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 1] },
            ],
          },
          paidAll: {
            $sum: {
              $map: { input: { $ifNull: ['$paymentHistory', []] }, as: 'ph', in: paidOfPh('$$ph') },
            },
          },
        },
      },
    ];

    // ── 2. Renewal sales (one row per renewal billing) ──────────────────────
    const renewalPipeline = [
      {
        $match: {
          paymentHistory: {
            $elemMatch: { renewalSellingPrice: { $ne: null }, ...(range ? { date: range } : {}) },
          },
        },
      },
      { $unwind: '$paymentHistory' },
      { $match: { 'paymentHistory.renewalSellingPrice': { $ne: null }, 'paymentHistory.date': rangeCond } },
      {
        $project: {
          orderId: 1,
          customerId: 1,
          fallbackName: nonEmptyStr('$customerDetails.name'),
          product: 1,
          variant: 1,
          domainUrl: 1,
          date: '$paymentHistory.date',
          description: { $ifNull: ['$paymentHistory.description', ''] },
          stage: '$paymentHistory.paymentStage',
          renewalSelling: '$paymentHistory.renewalSellingPrice',
          paid: paidOfPh('$paymentHistory'),
        },
      },
    ];

    // ── 3. Payment receipts (sub-payments flattened in DB) ──────────────────
    const paymentPipeline = [
      ...(range
        ? [{ $match: { $or: [{ 'paymentHistory.date': range }, { 'paymentHistory.paymentHistory.payDate': range }] } }]
        : []),
      { $unwind: '$paymentHistory' },
      {
        $addFields: {
          isRenewal: { $ne: [{ $ifNull: ['$paymentHistory.renewalSellingPrice', null] }, null] },
          pays: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$paymentHistory.paymentHistory', []] } }, 0] },
              {
                $map: {
                  input: '$paymentHistory.paymentHistory',
                  as: 's',
                  in: {
                    id: '$$s._id',
                    date: { $ifNull: ['$$s.payDate', '$paymentHistory.date'] },
                    amount: { $ifNull: ['$$s.amount', 0] },
                    withGst: { $eq: ['$$s.withGst', true] },
                    gst: { $cond: [{ $eq: ['$$s.withGst', true] }, { $ifNull: ['$$s.gstvalue', 0] }, 0] },
                    stage: { $ifNull: ['$$s.stage', '$paymentHistory.paymentStage'] },
                    description: {
                      $ifNull: [nonEmptyStr('$$s.description'), { $ifNull: ['$paymentHistory.description', ''] }],
                    },
                  },
                },
              },
              [
                {
                  id: '$paymentHistory._id',
                  date: '$paymentHistory.date',
                  amount: { $ifNull: ['$paymentHistory.amount', 0] },
                  withGst: { $eq: ['$paymentHistory.withGst', true] },
                  gst: {
                    $cond: [{ $eq: ['$paymentHistory.withGst', true] }, { $ifNull: ['$paymentHistory.gstvalue', 0] }, 0],
                  },
                  stage: '$paymentHistory.paymentStage',
                  description: { $ifNull: ['$paymentHistory.description', ''] },
                },
              ],
            ],
          },
        },
      },
      { $unwind: '$pays' },
      { $match: { 'pays.date': rangeCond } },
      {
        $project: {
          orderId: 1,
          customerId: 1,
          fallbackName: nonEmptyStr('$customerDetails.name'),
          product: 1,
          variant: 1,
          domainUrl: 1,
          productType: 1,
          oneTimePayment: 1,
          isRenewal: 1,
          invoiceNo: { $ifNull: ['$paymentHistory.invoiceNo', ''] },
          pay: '$pays',
        },
      },
    ];

    // ── 4. TDS + unique invoices (parent level, counted once) ───────────────
    const parentStatsPipeline = [
      ...(range ? [{ $match: { 'paymentHistory.date': range } }] : []),
      { $unwind: '$paymentHistory' },
      { $match: { 'paymentHistory.date': rangeCond } },
      {
        $facet: {
          tds: [{ $group: { _id: null, total: { $sum: { $ifNull: ['$paymentHistory.tdsAmount', 0] } } } }],
          invoices: [
            { $match: { 'paymentHistory.invoiceNo': { $type: 'string', $gt: '' } } },
            { $group: { _id: '$paymentHistory.invoiceNo', date: { $min: '$paymentHistory.date' } } },
            { $group: { _id: { $substrCP: ['$date', 0, 7] }, count: { $sum: 1 } } },
          ],
        },
      },
    ];

    // ── 5. Pending (all-time) + earliest year ───────────────────────────────
    const pendingPipeline = [
      {
        $project: {
          billed: {
            $add: [
              {
                $multiply: [
                  { $ifNull: ['$price', 0] },
                  { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 1] },
                ],
              },
              {
                $sum: {
                  $map: {
                    input: { $ifNull: ['$paymentHistory', []] },
                    as: 'ph',
                    in: { $ifNull: ['$$ph.renewalSellingPrice', 0] },
                  },
                },
              },
            ],
          },
          paid: {
            $sum: {
              $map: { input: { $ifNull: ['$paymentHistory', []] }, as: 'ph', in: paidOfPh('$$ph') },
            },
          },
          years: {
            $filter: {
              input: {
                $concatArrays: [
                  {
                    $map: {
                      input: { $ifNull: ['$paymentHistory', []] },
                      as: 'ph',
                      in: { $substrCP: [{ $ifNull: ['$$ph.date', ''] }, 0, 4] },
                    },
                  },
                  [{ $substrCP: [{ $ifNull: ['$startDate', ''] }, 0, 4] }],
                ],
              },
              as: 'y',
              cond: { $gte: ['$$y', '2000'] },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          pending: { $sum: { $max: [0, { $subtract: ['$billed', '$paid'] }] } },
          minYear: { $min: { $min: '$years' } },
        },
      },
    ];

    const [baseDocs, renewalDocs, paymentDocs, parentStats, pendingAgg] = await Promise.all([
      CustomerProduct.aggregate(basePipeline, AGG_OPTS),
      CustomerProduct.aggregate(renewalPipeline, AGG_OPTS),
      CustomerProduct.aggregate(paymentPipeline, AGG_OPTS),
      CustomerProduct.aggregate(parentStatsPipeline, AGG_OPTS),
      CustomerProduct.aggregate(pendingPipeline, AGG_OPTS),
    ]);

    // ── Customer names (only the ones we need) ──────────────────────────────
    const idSet = new Set();
    for (const d of [...baseDocs, ...renewalDocs, ...paymentDocs]) {
      if (d.customerId) idSet.add(String(d.customerId));
    }
    const customers = idSet.size
      ? await Customer.find({ _id: { $in: [...idSet] } }).select('name').lean()
      : [];
    const nameMap = new Map(customers.map((c) => [String(c._id), c.name]));
    const nameOf = (d) =>
      (d.customerId && nameMap.get(String(d.customerId))) || d.fallbackName || 'Unknown Customer';

    const labelOf = (d) => {
      const l = [d.product, d.variant].filter(Boolean).join(' - ') || 'Service';
      return d.domainUrl ? `${l} (${d.domainUrl})` : l;
    };

    // ── Build rows + totals + monthly (small, in-memory) ────────────────────
    const monthly = new Map();
    const bucket = (dateStr) => {
      const m = dateStr.slice(0, 7);
      if (!monthly.has(m)) {
        monthly.set(m, { month: m, totalSales: 0, totalReceived: 0, totalReceivedNoGst: 0, invoiceCount: 0, orderCount: 0 });
      }
      return monthly.get(m);
    };

    const orderRows = [];
    const paymentRows = [];
    const paymentBreakdown = { full: 0, advance: 0, mid: 0, final: 0 };
    const customerAgg = new Map();
    const productAgg = new Map();
    let totalSelling = 0;
    let totalCustomerPaid = 0;
    let totalCustomerPaidNoGst = 0;
    let totalGstCollected = 0;

    const getCustomerEntry = (d) => {
      const key = d.customerId ? String(d.customerId) : `name:${nameOf(d)}`;
      if (!customerAgg.has(key)) {
        customerAgg.set(key, {
          customerId: d.customerId || null,
          customerName: nameOf(d),
          orderCount: 0,
          totalQuantity: 0,
          totalSales: 0,
          receivedAmount: 0,
          receivedNoGst: 0,
          pendingAmount: 0,
          productsMap: new Map(),
        });
      }
      return customerAgg.get(key);
    };

    const getProductKeyAndLabel = (d) => {
      const p = d.product || 'Service';
      const v = d.variant || '';
      const label = [p, v].filter(Boolean).join(' - ');
      return { key: label.toLowerCase(), label, product: p, variant: v };
    };

    const getProductEntry = (d) => {
      const { key, label, product, variant } = getProductKeyAndLabel(d);
      if (!productAgg.has(key)) {
        productAgg.set(key, {
          productName: label,
          product,
          variant,
          quantitySold: 0,
          salesCount: 0,
          customerKeys: new Set(),
          totalSales: 0,
          receivedAmount: 0,
          receivedNoGst: 0,
          pendingAmount: 0,
        });
      }
      return productAgg.get(key);
    };

    const getCustomerProductEntry = (custEntry, d) => {
      const { key, label } = getProductKeyAndLabel(d);
      if (!custEntry.productsMap.has(key)) {
        custEntry.productsMap.set(key, {
          productName: label,
          quantity: 0,
          salesCount: 0,
          totalSales: 0,
          receivedAmount: 0,
          pendingAmount: 0,
        });
      }
      return custEntry.productsMap.get(key);
    };

    for (const d of baseDocs) {
      const isOneTime = Boolean(d.oneTimePayment) || d.productType === 'OneTime';
      const qty = Number(d.quantity) || 1;
      const paid = Math.min(d.baseSelling, d.paidAll);
      const pending = Math.max(0, d.baseSelling - paid);
      orderRows.push({
        orderId: d.orderId || d._id,
        customerProductId: d._id,
        orderDate: d.baseDate,
        customerName: nameOf(d),
        productName: labelOf(d),
        paymentType: isOneTime ? 'oneTimePayment' : 'base',
        paymentStage: d.paymentStage || 'advance',
        paymentStatus: statusOf(d.baseSelling, paid),
        quantity: qty,
        totalPrice: r2(d.baseSelling),
        paidAmount: r2(paid),
        pendingAmount: r2(pending),
      });
      totalSelling += d.baseSelling;
      const b = bucket(d.baseDate);
      b.totalSales += d.baseSelling;
      b.orderCount += 1;

      // Customer & product summaries
      const custEntry = getCustomerEntry(d);
      custEntry.orderCount += 1;
      custEntry.totalQuantity += qty;
      custEntry.totalSales += d.baseSelling;
      custEntry.pendingAmount += pending;

      const cpEntry = getCustomerProductEntry(custEntry, d);
      cpEntry.quantity += qty;
      cpEntry.salesCount += 1;
      cpEntry.totalSales += d.baseSelling;
      cpEntry.pendingAmount += pending;

      const prodEntry = getProductEntry(d);
      prodEntry.quantitySold += qty;
      prodEntry.salesCount += 1;
      prodEntry.customerKeys.add(d.customerId ? String(d.customerId) : `name:${nameOf(d)}`);
      prodEntry.totalSales += d.baseSelling;
      prodEntry.pendingAmount += pending;
    }

    for (const d of renewalDocs) {
      const sell = Number(d.renewalSelling) || 0;
      const paid = Math.min(sell, d.paid);
      const pending = Math.max(0, sell - d.paid);
      orderRows.push({
        orderId: d.orderId || d._id,
        customerProductId: d._id,
        orderDate: d.date,
        customerName: nameOf(d),
        productName: d.description ? `${labelOf(d)} - ${d.description}` : labelOf(d),
        paymentType: 'renewal',
        paymentStage: d.stage || 'full',
        paymentStatus: statusOf(sell, d.paid),
        quantity: 1,
        totalPrice: r2(sell),
        paidAmount: r2(paid),
        pendingAmount: r2(pending),
      });
      totalSelling += sell;
      bucket(d.date).totalSales += sell;

      const custEntry = getCustomerEntry(d);
      custEntry.orderCount += 1;
      custEntry.totalQuantity += 1;
      custEntry.totalSales += sell;
      custEntry.pendingAmount += pending;

      const cpEntry = getCustomerProductEntry(custEntry, d);
      cpEntry.quantity += 1;
      cpEntry.salesCount += 1;
      cpEntry.totalSales += sell;
      cpEntry.pendingAmount += pending;

      const prodEntry = getProductEntry(d);
      prodEntry.quantitySold += 1;
      prodEntry.salesCount += 1;
      prodEntry.customerKeys.add(d.customerId ? String(d.customerId) : `name:${nameOf(d)}`);
      prodEntry.totalSales += sell;
      prodEntry.pendingAmount += pending;
    }

    for (const d of paymentDocs) {
      const p = d.pay;
      const stage = normStage(p.stage);
      const gross = p.amount + p.gst;
      const label = labelOf(d);

      totalCustomerPaid += gross;
      totalCustomerPaidNoGst += p.amount;
      totalGstCollected += p.gst;
      paymentBreakdown[stage] += gross;

      const custEntry = getCustomerEntry(d);
      custEntry.receivedAmount += gross;
      custEntry.receivedNoGst += p.amount;

      const cpEntry = getCustomerProductEntry(custEntry, d);
      cpEntry.receivedAmount += gross;

      const prodEntry = getProductEntry(d);
      prodEntry.receivedAmount += gross;
      prodEntry.receivedNoGst += p.amount;
      prodEntry.customerKeys.add(d.customerId ? String(d.customerId) : `name:${nameOf(d)}`);

      const b = bucket(p.date);
      b.totalReceived += gross;
      b.totalReceivedNoGst += p.amount;

      const isOneTime = Boolean(d.oneTimePayment) || d.productType === 'OneTime';
      paymentRows.push({
        paymentId: p.id || `${d._id}_pay_${p.date}`,
        orderId: d.orderId || d._id,
        customerProductId: d._id,
        date: p.date,
        customerName: nameOf(d),
        productName: p.description ? `${label} - ${p.description}` : label,
        amount: r2(p.amount),
        withGst: p.withGst,
        gstvalue: r2(p.gst),
        paymentType: d.isRenewal ? 'renewal' : isOneTime ? 'oneTimePayment' : 'base',
        stage,
        invoiceNo: d.invoiceNo || '',
      });
    }

    // TDS + invoices
    const ps = parentStats[0] || { tds: [], invoices: [] };
    const totalTdsDeducted = ps.tds[0]?.total || 0;
    let totalInvoices = 0;
    for (const inv of ps.invoices) {
      totalInvoices += inv.count;
      if (inv._id) bucket(`${inv._id}-01`).invoiceCount += inv.count;
    }

    const pa = pendingAgg[0] || {};
    const minYear = parseInt(pa.minYear, 10);
    const startYear = !isNaN(minYear) ? minYear : new Date().getFullYear();

    const monthlySummary = [...monthly.values()]
      .map((m) => ({
        ...m,
        totalSales: r2(m.totalSales),
        totalReceived: r2(m.totalReceived),
        totalReceivedNoGst: r2(m.totalReceivedNoGst),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const customerSummary = [...customerAgg.values()]
      .map((c) => ({
        customerId: c.customerId,
        customerName: c.customerName,
        orderCount: c.orderCount,
        totalQuantity: c.totalQuantity,
        totalSales: r2(c.totalSales),
        receivedAmount: r2(c.receivedAmount),
        receivedNoGst: r2(c.receivedNoGst),
        pendingAmount: r2(c.pendingAmount),
        paymentStatus: statusOf(c.totalSales, c.receivedNoGst),
        products: [...c.productsMap.values()]
          .map((p) => ({
            ...p,
            totalSales: r2(p.totalSales),
            receivedAmount: r2(p.receivedAmount),
            pendingAmount: r2(p.pendingAmount),
          }))
          .sort((a, b) => b.totalSales - a.totalSales),
      }))
      .sort((a, b) => b.totalSales - a.totalSales);

    const productSummary = [...productAgg.values()]
      .map((p) => ({
        productName: p.productName,
        product: p.product,
        variant: p.variant,
        quantitySold: p.quantitySold,
        salesCount: p.salesCount,
        customerCount: p.customerKeys.size,
        totalSales: r2(p.totalSales),
        receivedAmount: r2(p.receivedAmount),
        receivedNoGst: r2(p.receivedNoGst),
        pendingAmount: r2(p.pendingAmount),
      }))
      .sort((a, b) => b.totalSales - a.totalSales);

    res.json({
      orders: orderRows,
      payments: paymentRows,
      customerSummary,
      productSummary,
      totalCustomerPaid: r2(totalCustomerPaid),
      totalCustomerPaidNoGst: r2(totalCustomerPaidNoGst),
      totalGstCollected: r2(totalGstCollected),
      totalTdsDeducted: r2(totalTdsDeducted),
      totalSelling: r2(totalSelling),
      pendingAmount: r2(pa.pending || 0),
      totalInvoices,
      paymentBreakdown: {
        full: r2(paymentBreakdown.full),
        advance: r2(paymentBreakdown.advance),
        mid: r2(paymentBreakdown.mid),
        final: r2(paymentBreakdown.final),
      },
      monthlySummary,
      startYear,
    });
  } catch (err) {
    console.error('[RevenueController] getRevenueOrders error:', err);
    res.status(500).json({ message: 'Failed to fetch revenue orders' });
  }
};

module.exports = { getRevenueOrders };
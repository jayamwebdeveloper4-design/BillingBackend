const Customer = require('../models/Customer');
const Product = require('../models/Product');
const xlsx = require('xlsx');

const syncProjectClient = require("../ProjectTool/services/projectClientSync");

const formatDateToDDMMYYYY = (dateVal) => {
  if (!dateVal) return '';
  const dateStr = String(dateVal).trim();
  const yyyymmddMatch = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]|$)/);
  if (yyyymmddMatch) {
    const [_, y, m, d] = yyyymmddMatch;
    return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
  }
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  } catch (e) {
    return dateStr;
  }
};

const getCatalogPrices = (p) => {
  return {
    selling: p.price || 0,
    cost: p.costPrice || 0
  };
};

// @desc    Get all customers
// @route   GET /api/customers
// @access  Private
const getCustomers = async (req, res) => {
  try {
    const customers = await Customer.find({}).sort({ createdAt: -1 });
    // Sort each customer's orders by orderDate descending (latest first)
    const sorted = customers.map(c => {
      const obj = c.toObject();
      if (obj.orders && obj.orders.length > 1) {
        obj.orders.sort((a, b) => new Date(b.orderDate || b.createdAt || 0) - new Date(a.orderDate || a.createdAt || 0));
      }
      return obj;
    });
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single customer
// @route   GET /api/customers/:id
// @access  Private
const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create new customer
// @route   POST /api/customers
// @access  Private
const createCustomer = async (req, res) => {
  try {
    const customer = new Customer(req.body);
    const createdCustomer = await customer.save();

    try {
      await syncProjectClient(createdCustomer);
    } catch (syncError) {
      console.error("ProjectDB customer sync failed:", syncError.message);
      return res.status(502).json({
        message:
          "Billing customer was created, but copying it to ProjectDB failed. Retry the sync.",
        billingCustomerId: createdCustomer._id,
      });
    }

    res.status(201).json(createdCustomer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Update customer
// @route   PUT /api/customers/:id
// @access  Private
const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const cleanArray = (val, isEmail = false) => {
      if (!val) return [];
      let rawList = [];
      if (typeof val === 'string') {
        rawList = val.split(',');
      } else if (Array.isArray(val)) {
        rawList = val.flatMap(item => typeof item === 'string' ? item.split(',') : [item]);
      } else {
        rawList = [String(val)];
      }
      return Array.from(new Set(rawList
        .map(item => String(item).trim())
        .map(item => isEmail ? item.toLowerCase() : item)
        .filter(Boolean)
      ));
    };

    if (req.body.phone !== undefined) {
      req.body.phone = cleanArray(req.body.phone, false);
    }
    if (req.body.email !== undefined) {
      req.body.email = cleanArray(req.body.email, true);
    }

    delete req.body.__v;
    delete req.body._id;

    // Keep track of newly added payments to send confirmation emails later
    const newPaymentsToSend = [];
    if (Array.isArray(req.body.orders)) {
      req.body.orders.forEach(incomingOrder => {
        const existingOrder = customer.orders.id(incomingOrder._id || incomingOrder.id);
        if (existingOrder) {
          const existingPaymentsCount = Array.isArray(existingOrder.payments) ? existingOrder.payments.length : 0;
          const incomingPayments = Array.isArray(incomingOrder.payments) ? incomingOrder.payments : [];
          if (incomingPayments.length > existingPaymentsCount) {
            const newPayments = incomingPayments.slice(existingPaymentsCount);
            newPayments.forEach(p => {
              newPaymentsToSend.push({
                orderId: existingOrder._id.toString(),
                payment: p
              });
            });
          }
        } else {
          const incomingPayments = Array.isArray(incomingOrder.payments) ? incomingOrder.payments : [];
          incomingPayments.forEach(p => {
            newPaymentsToSend.push({
              orderId: incomingOrder._id ? incomingOrder._id.toString() : null,
              payment: p,
              isNewOrder: true,
              incomingOrderIndex: req.body.orders.indexOf(incomingOrder)
            });
          });
        }
      });
    }

    Object.assign(customer, req.body);
    customer.markModified('orders');
    const updatedCustomer = await customer.save();

    try {
      await syncProjectClient(updatedCustomer);
    } catch (syncError) {
      console.error("ProjectDB customer sync failed:", syncError.message);
      return res.status(502).json({
        message:
          "Billing customer was updated, but copying the changes to ProjectDB failed. Retry the sync.",
        billingCustomerId: updatedCustomer._id,
      });
    }

    // Automatic email trigger for new payments added during update
    if (newPaymentsToSend.length > 0) {
      try {
        const PaymentConfirmationSetting = require('../models/PaymentConfirmationSetting');
        const settings = await PaymentConfirmationSetting.findOne();
        if (!settings || settings.sendPaymentConfirmationEmail !== false) {
          const { sendPaymentEmailHelper } = require('./paymentConfirmationController');
          for (const item of newPaymentsToSend) {
            let orderId = item.orderId;
            if (item.isNewOrder && item.incomingOrderIndex !== undefined) {
              const savedOrder = updatedCustomer.orders[item.incomingOrderIndex];
              if (savedOrder) orderId = savedOrder._id.toString();
            }
            if (orderId) {
              const orderObj = updatedCustomer.orders.id(orderId);
              if (orderObj) {
                const paymentObj = orderObj.payments.find(p => p.amount === item.payment.amount && String(p.date) === String(item.payment.date)) || orderObj.payments[orderObj.payments.length - 1];
                await sendPaymentEmailHelper(updatedCustomer, orderObj, paymentObj);
              }
            }
          }
        }
      } catch (emailErr) {
        console.error("Failed to send auto payment confirmation email on updateCustomer:", emailErr.message);
      }
    }

    res.json(updatedCustomer);
  } catch (error) {
    console.error("Error updating customer:", error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete customer
// @route   DELETE /api/customers/:id
// @access  Private
const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const customerId = customer._id;
    await customer.deleteOne();

    res.json({ message: 'Customer removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper to convert number to words in English
const numberToWords = (num) => {
  if (num === null || num === undefined || isNaN(num)) return '';
  num = Math.round(Number(num));
  if (num === 0) return 'Zero Only';
  if (num < 0) return 'Negative ' + numberToWords(Math.abs(num));

  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ',
    'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ',
    'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const numStr = num.toString();
  if (numStr.length > 9) return 'Overflow';
  const n = ('000000000' + numStr).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
  if (!n) return '';

  const parts = [];
  if (Number(n[1]) !== 0) {
    const val = Number(n[1]);
    parts.push(((a[val] || (b[n[1][0]] + ' ' + a[n[1][1]])).trim()) + ' Crore');
  }
  if (Number(n[2]) !== 0) {
    const val = Number(n[2]);
    parts.push(((a[val] || (b[n[2][0]] + ' ' + a[n[2][1]])).trim()) + ' Lakh');
  }
  if (Number(n[3]) !== 0) {
    const val = Number(n[3]);
    parts.push(((a[val] || (b[n[3][0]] + ' ' + a[n[3][1]])).trim()) + ' Thousand');
  }
  if (Number(n[4]) !== 0) {
    const val = Number(n[4]);
    parts.push(((a[val] || (b[n[4][0]] + ' ' + a[n[4][1]])).trim()) + ' Hundred');
  }
  if (Number(n[5]) !== 0) {
    const val = Number(n[5]);
    parts.push((a[val] || (b[n[5][0]] + ' ' + a[n[5][1]])).trim());
  }

  if (parts.length === 0) return 'Only';
  if (parts.length === 1) return parts[0] + ' Only';

  const lastPart = parts.pop();
  return parts.join(' ') + ' and ' + lastPart + ' Only';
};

// Helper to format YYYY-MM-DD -> DD.MM.YYYY
const formatDateDot = (dateStr) => {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return dateStr;
};

const formatDateToYYYYMMDD = (dateVal) => {
  if (!dateVal) return '';
  const dateStr = String(dateVal).trim();
  const yyyymmddMatch = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]|$)/);
  if (yyyymmddMatch) {
    const [_, y, m, d] = yyyymmddMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const ddmmyyyyMatch = dateStr.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (ddmmyyyyMatch) {
    const [_, d, m, y] = ddmmyyyyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const yearVal = d.getFullYear();
    const monthVal = String(d.getMonth() + 1).padStart(2, '0');
    const dayVal = String(d.getDate()).padStart(2, '0');
    return `${yearVal}-${monthVal}-${dayVal}`;
  } catch (e) {
    return dateStr;
  }
};

const getOrderLastPaymentDate = (order) => {
  if (Array.isArray(order.payments) && order.payments.length > 0) {
    const validDates = order.payments
      .map(p => p.date)
      .filter(Boolean)
      .map(d => formatDateToYYYYMMDD(d))
      .filter(Boolean);
    if (validDates.length > 0) {
      validDates.sort((a, b) => b.localeCompare(a));
      return validDates[0];
    }
  }
  return "";
};

// @desc    Get upcoming renewal reminders
// @route   GET /api/customers/reminders
// @access  Private
const getReminders = async (req, res) => {
  try {
    const { days, month, year, deactive, paymentStatus } = req.query;
    let customers = [];
    let futureStr = "";
    let todayStr = "";

    const hasMonthFilter = month && month !== 'all';
    const hasYearFilter = year && year !== 'all';

    const daysCount = parseInt(days) || 7;
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + daysCount);

    const getLocalYYYYMMDD = (d) => {
      const yearVal = d.getFullYear();
      const monthVal = String(d.getMonth() + 1).padStart(2, '0');
      const dayVal = String(d.getDate()).padStart(2, '0');
      return `${yearVal}-${monthVal}-${dayVal}`;
    };

    todayStr = getLocalYYYYMMDD(today);
    futureStr = getLocalYYYYMMDD(futureDate);

    customers = await Customer.find({ 'orders.0': { $exists: true } });

    const reminders = [];
    customers.forEach(customer => {
      customer.orders.forEach(order => {
        const prods = order.products || [];
        if (prods.length === 0) return;

        const hasDeactiveProds = order.deactive || prods.some(p => p.deactive);
        const hasActiveProds = !order.deactive && prods.some(p => !p.deactive && p.validationEnabled !== false);

        if (deactive === 'deactive' && !hasDeactiveProds) return;
        if (deactive === 'active' && !hasActiveProds) return;

        const isPaidOrder = (order.paymentStatus === 'Fully Paid' || order.paymentStatus === 'Paid');

        // Filter by payment status (paid vs unpaid) - only for active list, ignore for deactive list
        if (deactive !== 'deactive') {
          if (paymentStatus === 'paid' && !isPaidOrder) return;
          if (paymentStatus === 'unpaid' && isPaidOrder) return;
        }

        const lastPayDateYYYYMMDD = getOrderLastPaymentDate(order);

        // Determine filter date string:
        // For Paid filter (paymentStatus === 'paid'), filter by order.startDate (fallback to order.endDate)
        // For Unpaid or default, filter by order.endDate
        let filterDateStr = "";
        if (paymentStatus === 'paid' || isPaidOrder) {
          filterDateStr = formatDateToYYYYMMDD(order.startDate) || "";
        } else {
          filterDateStr = order.endDate || "";
        }

        let isMatch = false;
        if (deactive === 'deactive') {
          isMatch = true;
        } else if (hasMonthFilter || hasYearFilter || month === 'all' || year === 'all') {
          if (filterDateStr) {
            const parts = filterDateStr.split('-'); // YYYY-MM-DD
            if (parts.length === 3) {
              const orderYear = parts[0];
              const orderMonth = parts[1];

              const matchMonth = !hasMonthFilter || orderMonth === month.padStart(2, '0');
              const matchYear = !hasYearFilter || orderYear === String(year);

              if (matchMonth && matchYear) {
                isMatch = true;
              }
            }
          }
          if (!isMatch && hasDeactiveProds && !deactive) {
            isMatch = true;
          }
        } else {
          if (filterDateStr && filterDateStr >= todayStr && filterDateStr <= futureStr) {
            isMatch = true;
          } else if (hasDeactiveProds && !deactive) {
            isMatch = true;
          }
        }

        if (isMatch) {
          const targetProds = deactive === 'deactive'
            ? prods.filter(p => p.deactive)
            : prods.filter(p => !p.deactive && p.validationEnabled !== false);

          if (targetProds.length === 0) return;

          const productNames = targetProds.map(p => p.product).join(', ');

          let renewalPrice = 0;
          let renewalCost = 0;

          const productsList = targetProds.map(p => {
            const resolvedPrices = getCatalogPrices(p);

            if (p.validationEnabled !== false && !p.deactive) {
              renewalPrice += (resolvedPrices.selling);
              renewalCost += (resolvedPrices.cost );
            }

            return {
              productName: p.product,
              variant: p.variant,
              productcost: p.costPrice || 0,
              renewalSelling: resolvedPrices.selling,
              renewalCost: resolvedPrices.cost,
              price: p.price || 0,
              quantity: p.quantity || 1,
              validationEnabled: p.validationEnabled !== false,
              deactive: p.deactive || false,
              deactiveYear: p.deactiveYear || "",
              startDate: p.startDate,
              endDate: p.endDate,
              _id: p._id
            };
          });

          reminders.push({
            id: `${customer._id}-${order._id}`,
            customerId: customer._id,
            customerName: customer.name,
            email: customer.email,
            phone: customer.phone,
            customerAddress: customer.address || "",
            customerNotes: customer.notes || "",
            customerState: customer.state || "",
            customerGstin: customer.gstin || "",
            orderDate: order.orderDate,
            productName: productNames,
            dueDate: order.endDate,
            domainUrl: order.domainUrl || "",
            startDate: order.startDate || "",
            endDate: order.endDate || "",
            lastPaymentDate: lastPayDateYYYYMMDD ? formatDateDot(lastPayDateYYYYMMDD) : "",
            lastPaymentDateRaw: lastPayDateYYYYMMDD || "",
            price: renewalPrice,
            priceWords: numberToWords(Math.round(renewalPrice)),
            startDateDot: formatDateDot(order.startDate),
            endDateDot: formatDateDot(order.endDate),
            billingCycle: order.billingCycle || 'yearly',
            orderDateDot: formatDateDot(order.orderDate),
            paymentStatus: order.paymentStatus || 'Unpaid',
            payments: order.payments || [],
            emailSend: order.emailSend || false,
            expiredEmailSend: order.expiredEmailSend || false,
            deletionEmailSend: order.deletionEmailSend || false,
            products: productsList
          });
        }
      });
    });

    reminders.sort((a, b) => {
      const dateA = (paymentStatus === 'paid' ? (formatDateToYYYYMMDD(a.startDate) || a.endDate || "") : (a.endDate || ""));
      const dateB = (paymentStatus === 'paid' ? (formatDateToYYYYMMDD(b.startDate) || b.endDate || "") : (b.endDate || ""));
      return dateA.localeCompare(dateB);
    });

    res.json(reminders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Import customers from excel
// @route   POST /api/customers/import
// @access  Private
const importCustomers = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Please upload an excel file' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { defval: null });

    // ── Helpers ──────────────────────────────────────────────────────────────

    const str = v => (v != null ? String(v).trim() : '');

    // Normalize any date format → YYYY-MM-DD
    const toISODate = (val) => {
      if (val === null || val === undefined || val === '') return null;

      if (val instanceof Date) {
        if (!isNaN(val.getTime())) {
          const year = val.getFullYear();
          const month = String(val.getMonth() + 1).padStart(2, '0');
          const day = String(val.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        }
        return null;
      }

      const numVal = Number(val);
      if (!isNaN(numVal) && numVal > 25000 && numVal < 60000) {
        const d = new Date((numVal - 25569) * 86400 * 1000);
        if (!isNaN(d.getTime())) {
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        }
      }

      const s = String(val).trim();
      if (!s) return null;

      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

      const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (dmy) {
        const d = dmy[1].padStart(2, '0');
        const m = dmy[2].padStart(2, '0');
        const y = dmy[3];
        return `${y}-${m}-${d}`;
      }

      const iso = s.match(/^(\d{4}-\d{2}-\d{2})T/);
      if (iso) return iso[1];

      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
      return null;
    };
    const num = v => (v != null && v !== '' ? Number(v) : 0);
    const bool = v => String(v ?? '').toLowerCase() === 'true';

    const sanitizeOrders = (orders) => {
      if (!Array.isArray(orders)) return [];
      return orders.map(order => {
        const normalizedOrderDate = toISODate(order.orderDate) || new Date().toISOString().split('T')[0];
        return {
          orderDate: normalizedOrderDate,
          domainUrl: order.domainUrl || '',
          totalPrice: order.totalPrice || 0,
          paymentStatus: order.paymentStatus || 'Unpaid',
          products: Array.isArray(order.products) ? order.products.map(p => {
            const clean = {
              product: p.product,
              variant: p.variant,
              costPrice: p.costPrice || 0,
              price: p.price || 0,
              quantity: p.quantity || 1,
              validationEnabled: p.validationEnabled !== undefined ? p.validationEnabled : false,
              startDate: toISODate(p.startDate) || null,
              endDate: toISODate(p.endDate) || null,
            };
            if (Array.isArray(p.Varinet)) {
              clean.Varinet = p.Varinet.map(v => ({
                name: v.name || '',
                value: v.value || '',
                option: v.option || '',
                sellerPrice: v.sellerPrice || 0,
                sellerEnable: v.sellerEnable ?? v.sellerEnbale ?? false,
                costPrice: v.costPrice || 0,
                costEnable: v.costEnable ?? false,
                valueEnable: v.valueEnable ?? true
              }));
            }
            return clean;
          }) : [],
          payments: Array.isArray(order.payments) ? order.payments.map(py => ({
            date: py.date || new Date().toISOString().split('T')[0],
            amount: py.amount || 0,
            note: py.note || '',
            gstvalue: py.gstvalue || 0,
            paymentType: py.paymentType || 'base',
            withGst: py.withGst || false
          })) : []
        };
      });
    };

    const orderKey = (o) =>
      `${o.orderDate}|${o.totalPrice}|${(o.products || []).map(p => `${p.product}::${p.variant}`).sort().join(',')}`;

    // ── Group rows by customer identity ──────────────────────────────────────
    const groupedCustomers = {};

    data.forEach((item, rowIndex) => {
      const name = str(item.Name || item.name);
      const phone = str(item.Phone || item.phone || item.Mobile || item.mobile);
      const email = str(item.Email || item.email).toLowerCase();

      if (!name) return;

      const key = email || phone || name.toLowerCase().replace(/\s+/g, ' ');

      if (!groupedCustomers[key]) {
        groupedCustomers[key] = {
          name,
          phone: phone || 'N/A',
          email: email || 'no-email@example.com',
          contactPerson: str(item['Contact Person'] || item.contactPerson || item['contact_person'] || item['ContactPerson'] || name),
          address: str(item.Address || item.address),
          state: str(item.State || item.state),
          gstin: str(item.GSTIN || item.gstin),
          notes: str(item.Notes || item.notes),
          rawRows: [],
          sourceRowNumbers: []
        };
      } else {
        const g = groupedCustomers[key];
        if ((!g.phone || g.phone === 'N/A') && phone) g.phone = phone;
        if ((!g.email || g.email === 'no-email@example.com') && email) g.email = email;
        if ((!g.contactPerson || g.contactPerson === name) && (item['Contact Person'] || item.contactPerson || item['contact_person'] || item['ContactPerson'])) {
          g.contactPerson = str(item['Contact Person'] || item.contactPerson || item['contact_person'] || item['ContactPerson']);
        }
        if (!g.address && item.Address) g.address = str(item.Address || item.address);
        if (!g.state && (item.State || item.state)) g.state = str(item.State || item.state);
        if (!g.gstin && (item.GSTIN || item.gstin)) g.gstin = str(item.GSTIN || item.gstin);
        if (item.Notes || item.notes) {
          const newNote = str(item.Notes || item.notes);
          if (newNote && !g.notes.includes(newNote)) {
            g.notes = g.notes ? `${g.notes}\n${newNote}` : newNote;
          }
        }
      }

      groupedCustomers[key].rawRows.push(item);
      groupedCustomers[key].sourceRowNumbers.push(rowIndex + 2); // +2: header row + 1-index
    });

    // ── Build orders per customer ─────────────────────────────────────────────
    const customersToUpsert = [];

    for (const key of Object.keys(groupedCustomers)) {
      const group = groupedCustomers[key];
      const seenOrderKeys = new Set();
      let finalOrders = [];

      for (const item of group.rawRows) {
        const ordersJsonStr = str(item['Orders Data (JSON)'] || item['ordersData'] || '');
        if (ordersJsonStr) {
          try {
            const parsed = JSON.parse(ordersJsonStr);
            if (Array.isArray(parsed)) {
              for (const o of sanitizeOrders(parsed)) {
                const k = orderKey(o);
                if (!seenOrderKeys.has(k)) {
                  seenOrderKeys.add(k);
                  finalOrders.push(o);
                }
              }
              continue;
            }
          } catch (e) {
            // fall through to flat column parsing
          }
        }

        const productName = str(
          item.Product || item.product ||
          item['Product Name'] || item['productName']
        );

        const productsStr = str(item.Products || item.products || '');
        const rowOrderDate = toISODate(item['Order Date'] || item.orderDate) || new Date().toISOString().split('T')[0];

        let rowProducts = [];

        if (productName) {
          const productsArr = productName.split(' + ').map(s => s.trim());
          const variantsArr = str(item.Variant || item.variant || '').split(' + ').map(s => s.trim());
          const pricesArr = str(item.Price || item.price || '').split(' + ').map(s => s.trim());
          const quantitiesArr = str(item.Quantity || item.quantity || item.Qty || item.qty || '').split(' + ').map(s => s.trim());
          const costPricesArr = str(item['Cost Price'] || item.costPrice || item.Cost || item.cost || '').split(' + ').map(s => s.trim());
          const validationsArr = str(item['Validation Enabled'] || item.validationEnabled || item.Validation || '').split(' + ').map(s => s.trim());
          const startDatesArr = str(item['Start Date'] || item.startDate || item['Created Date'] || '').split(' + ').map(s => s.trim());
          const endDatesArr = str(item['End Date'] || item.endDate || item['Renew Date'] || '').split(' + ').map(s => s.trim());

          for (let i = 0; i < productsArr.length; i++) {
            const prod = productsArr[i] || 'Standard';
            const variant = variantsArr[i] !== undefined ? variantsArr[i] : (variantsArr[0] || 'Standard');
            const price = num(pricesArr[i] !== undefined && pricesArr[i] !== '' ? pricesArr[i] : (pricesArr[0] || 0));
            const qty = num(quantitiesArr[i] !== undefined && quantitiesArr[i] !== '' ? quantitiesArr[i] : (quantitiesArr[0] || 1));
            const costPrice = num(costPricesArr[i] !== undefined && costPricesArr[i] !== '' ? costPricesArr[i] : (costPricesArr[0] || 0));
            const valEnabled = bool(validationsArr[i] !== undefined && validationsArr[i] !== '' ? validationsArr[i] : (validationsArr[0] || 'false'));

            const rawStartDate = startDatesArr[i] !== undefined ? startDatesArr[i] : (startDatesArr[0] || '');
            const rawEndDate = endDatesArr[i] !== undefined ? endDatesArr[i] : (endDatesArr[0] || '');

            let startDate = toISODate(rawStartDate);
            if (!startDate && valEnabled) {
              startDate = new Date().toISOString().split('T')[0];
            }
            const endDate = toISODate(rawEndDate) || null;

            rowProducts.push({
              product: prod,
              variant: variant,
              costPrice: costPrice,
              price: price,
              quantity: qty,
              validationEnabled: valEnabled,
              startDate: startDate,
              endDate: endDate,
              Varinet: [{
                name: variant,
                value: variant,
                option: '',
                sellerPrice: price,
                sellerEnable: true,
                costPrice: costPrice,
                costEnable: true,
                valueEnable: true
              }]
            });
          }
        } else if (productsStr) {
          rowProducts = productsStr.split(';').map(p => {
            const t = p.trim();
            if (!t) return null;
            const fullMatch = t.match(/(.*)\s\((.*)\)\s-\s(\d+)/);
            if (fullMatch) return { product: fullMatch[1].trim(), variant: fullMatch[2].trim(), price: Number(fullMatch[3]), startDate: rowOrderDate };
            const variantMatch = t.match(/(.*)\s\((.*)\)/);
            if (variantMatch) return { product: variantMatch[1].trim(), variant: variantMatch[2].trim(), price: 0, startDate: rowOrderDate };
            return { product: t, variant: 'Standard', price: 0, startDate: rowOrderDate };
          }).filter(Boolean);
        }

        if (rowProducts.length === 0) continue;

        const paymentDates = str(item['Payment Date'] || item.paymentDate || '').split(';').map(s => toISODate(s.trim()) || s.trim()).filter(Boolean);
        const paymentAmounts = str(item['Payment Amount'] || item.paymentAmount || '').split(';').map(s => num(s.trim()));
        const paymentNotes = str(item['Payment Note'] || item.paymentNote || '').split(';').map(s => s.trim());

        const payments = paymentDates.map((date, i) => ({
          date,
          amount: paymentAmounts[i] || 0,
          note: paymentNotes[i] || ''
        })).filter(p => p.amount > 0 || p.date);

        const rowTotalPrice = num(item['Order Total Price'] || item['Total Spent'] || item.totalPrice || item.price ||
          rowProducts.reduce((sum, p) => sum + (p.price || 0), 0));
        const rowStatus = str(item['Payment Status'] || item.paymentStatus || 'Unpaid');
        const rowDomainUrl = str(item['Domain URL'] || item.domainUrl || item.Domain || item.domain || '');

        const rawOrder = {
          orderDate: rowOrderDate,
          domainUrl: rowDomainUrl,
          products: rowProducts,
          totalPrice: rowTotalPrice,
          paymentStatus: rowStatus,
          payments
        };

        const [sanitizedOrder] = sanitizeOrders([rawOrder]);

        const k = orderKey(sanitizedOrder);
        if (!seenOrderKeys.has(k)) {
          seenOrderKeys.add(k);
          finalOrders.push(sanitizedOrder);
        }
      }

      customersToUpsert.push({
        identity: { email: group.email, phone: group.phone, name: group.name },
        sourceRowNumbers: group.sourceRowNumbers,
        data: {
          name: group.name,
          phone: group.phone,
          email: group.email,
          contactPerson: group.contactPerson || group.name,
          address: group.address,
          state: group.state,
          gstin: group.gstin,
          notes: group.notes,
          orders: finalOrders
        }
      });
    }

    if (customersToUpsert.length === 0) {
      return res.status(400).json({ message: 'No valid customer data found. Make sure you have a Name column.' });
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let skippedOrderCount = 0;
    const failed = [];

    for (const entry of customersToUpsert) {
      const { identity, data, sourceRowNumbers } = entry;

      try {
        let existing = null;

        const parsedEmails = identity.email ? identity.email.split(',').map(e => e.trim().toLowerCase()).filter(Boolean) : [];
        const parsedPhones = identity.phone ? identity.phone.split(',').map(p => p.trim()).filter(Boolean) : [];

        if (parsedEmails.length > 0) {
          existing = await Customer.findOne({ email: { $in: parsedEmails } });
        }

        if (!existing && parsedPhones.length > 0) {
          existing = await Customer.findOne({ phone: { $in: parsedPhones } });
        }

        if (!existing && identity.name) {
          const potentialMatches = await Customer.find({
            name: { $regex: new RegExp(`^${identity.name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') }
          });

          for (const candidate of potentialMatches) {
            const candidatePhones = (Array.isArray(candidate.phone) ? candidate.phone : [candidate.phone]).filter(p => p && p !== 'N/A');
            const hasPhones = candidatePhones.length > 0 && parsedPhones.length > 0;
            const phoneOverlap = candidatePhones.some(p => parsedPhones.includes(p));
            const phoneConflict = hasPhones && !phoneOverlap;

            const candidateEmails = (Array.isArray(candidate.email) ? candidate.email : [candidate.email]).filter(e => e && e !== 'no-email@example.com');
            const hasEmails = candidateEmails.length > 0 && parsedEmails.length > 0;
            const emailOverlap = candidateEmails.some(e => parsedEmails.includes(e));
            const emailConflict = hasEmails && !emailOverlap;

            if (!phoneConflict && !emailConflict) {
              existing = candidate;
              break;
            }
          }
        }

        if (existing) {
          const initialOrdersLength = existing.orders ? existing.orders.length : 0;

          const uniqueExistingOrders = [];
          const seenDbKeys = new Set();
          for (const o of existing.orders || []) {
            const k = orderKey(o);
            if (!seenDbKeys.has(k)) {
              seenDbKeys.add(k);
              uniqueExistingOrders.push(o);
            }
          }

          const legacyDuplicatesCount = initialOrdersLength - uniqueExistingOrders.length;
          existing.orders = uniqueExistingOrders;

          const existingKeys = new Set(uniqueExistingOrders.map(orderKey));
          const newOrders = data.orders.filter(o => !existingKeys.has(orderKey(o)));
          skippedOrderCount += (data.orders.length - newOrders.length);

          if (newOrders.length > 0 || legacyDuplicatesCount > 0 || !existing.contactPerson) {
            existing.orders.push(...newOrders);
            if (!existing.contactPerson) {
              existing.contactPerson = data.contactPerson || existing.name;
            } else if (data.contactPerson && data.contactPerson !== existing.name && existing.contactPerson === existing.name) {
              existing.contactPerson = data.contactPerson;
            }
            if (!existing.address && data.address) existing.address = data.address;
            if (!existing.state && data.state) existing.state = data.state;
            if (!existing.gstin && data.gstin) existing.gstin = data.gstin;
            if (!existing.notes && data.notes) existing.notes = data.notes;

            const mergedEmails = Array.from(new Set([
              ...(Array.isArray(existing.email) ? existing.email : [existing.email]),
              ...parsedEmails
            ])).filter(Boolean);
            existing.email = mergedEmails;

            const mergedPhones = Array.from(new Set([
              ...(Array.isArray(existing.phone) ? existing.phone : [existing.phone]),
              ...parsedPhones
            ])).filter(Boolean);
            existing.phone = mergedPhones;

            await existing.save();
            await syncProjectClient(existing);
            updatedCount++;
          } else {
            await syncProjectClient(existing);
            unchangedCount++;
          }
        } else {
          const createdCustomer = await Customer.create(data);
          await syncProjectClient(createdCustomer);
          insertedCount++;
        }
      } catch (err) {
        failed.push({
          name: identity.name,
          email: identity.email,
          phone: identity.phone,
          sourceRows: sourceRowNumbers,
          reason: err.message
        });
      }
    }

    const totalGroups = customersToUpsert.length;
    const accountedFor = insertedCount + updatedCount + unchangedCount + failed.length;

    res.status(failed.length > 0 ? 207 : 201).json({
      message: `Import complete: ${insertedCount} new customer(s) created, ${updatedCount} existing customer(s) updated, ` +
        `${unchangedCount} already up to date, ${failed.length} failed, ${skippedOrderCount} duplicate order(s) skipped ` +
        `(${accountedFor}/${totalGroups} customer group(s) from the sheet accounted for).`,
      totalCustomerGroupsInSheet: totalGroups,
      inserted: insertedCount,
      updated: updatedCount,
      unchanged: unchangedCount,
      failedCount: failed.length,
      failed,
      skippedOrders: skippedOrderCount
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Export customers to excel
// @route   GET /api/customers/export
// @access  Private
const exportCustomers = async (req, res) => {
  try {
    const customers = await Customer.find({});
    const rows = [];

    customers.forEach(c => {
      if (!c.orders || c.orders.length === 0) {
        rows.push({
          'Name': c.name,
          'Phone': Array.isArray(c.phone) ? c.phone.join(', ') : c.phone,
          'Email': Array.isArray(c.email) ? c.email.join(', ') : c.email,
          'Contact Person': c.contactPerson || null,
          'Address': c.address || null,
          'State': c.state || null,
          'GSTIN': c.gstin || null,
          'Notes': c.notes || null,
          'Domain URL': null,
          'Product': null,
          'Variant': null,
          'Quantity': null,
          'Cost Price': null,
          'Price': null,
          'Validation Enabled': null,
          'Start Date': null,
          'End Date': null,
          'Created Date': null,
          'Seller Renewal': null,
          'Cost Renewal': null,
          'Order Date': null,
          'Order Total Price': null,
          'Payment Date': null,
          'Payment Status': null,
          'Payment Amount': null,
          'Orders Data (JSON)': null
        });
        return;
      }

      c.orders.forEach(order => {
        const orderDate = order.orderDate || null;
        const totalPrice = order.totalPrice ?? null;
        const paymentStatus = order.paymentStatus || null;

        const paymentDates = order.payments?.map(p => p.date ? formatDateToDDMMYYYY(p.date) : '').filter(d => d).join('; ') || null;
        const paymentAmounts = order.payments?.map(p => p.amount ?? '').join('; ') || null;
        const paymentNotes = order.payments?.map(p => p.note || '').join('; ') || null;

        if (!order.products || order.products.length === 0) {
          rows.push({
            'Name': c.name,
            'Phone': Array.isArray(c.phone) ? c.phone.join(', ') : c.phone,
            'Email': Array.isArray(c.email) ? c.email.join(', ') : c.email,
            'Contact Person': c.contactPerson || null,
            'Address': c.address || null,
            'State': c.state || null,
            'GSTIN': c.gstin || null,
            'Notes': c.notes || null,
            'Domain URL': order.domainUrl || null,
            'Product': null,
            'Variant': null,
            'Quantity': null,
            'Cost Price': null,
            'Price': null,
            'Validation Enabled': null,
            'Start Date': null,
            'End Date': null,
            'Created Date': null,
            'Seller Renewal': null,
            'Cost Renewal': null,
            'Order Date': orderDate ? formatDateToDDMMYYYY(orderDate) : null,
            'Order Total Price': totalPrice,
            'Payment Date': paymentDates,
            'Payment Status': paymentStatus,
            'Payment Amount': paymentAmounts,
            'Orders Data (JSON)': JSON.stringify(c.orders)
          });
        } else {
          const costPrices = order.products.map(p => {
            let costPrice = p.costPrice ?? null;
            if (costPrice === null && Array.isArray(p.Varinet) && p.Varinet.length > 0) {
              const costVarinet = p.Varinet.find(v => v.costEnable && v.costPrice != null);
              if (costVarinet) costPrice = costVarinet.costPrice;
            }
            return costPrice;
          });

          const productsStr = order.products.map(p => p.product || 'Standard').join(' + ');
          const variantsStr = order.products.map(p => p.variant || 'Standard').join(' + ');
          const quantitiesStr = order.products.map(p => p.quantity || 1).join(' + ');
          const costPricesStr = costPrices.map(cp => cp !== null ? cp : '0').join(' + ');
          const pricesStr = order.products.map(p => p.price ?? 0).join(' + ');
          const validationsStr = order.products.map(p => p.validationEnabled != null ? String(p.validationEnabled) : 'false').join(' + ');
          const sellerRenewalsStr = order.products.map(p => p.price ?? 0).join(' + ');
          const costRenewalsStr = costPrices.map(cp => cp !== null ? cp : '0').join(' + ');

          const cleanJoinedStr = (str) => {
            if (!str) return null;
            const cleaned = str.trim().replace(/^[ +]+$/, '');
            return cleaned === '' ? null : str;
          };

          const startDatesRaw = order.products.map(p => {
            const isValEnabled = p.validationEnabled === true || String(p.validationEnabled).toLowerCase() === 'true';
            if (!isValEnabled) return '';
            return p.startDate ? formatDateToDDMMYYYY(p.startDate) : 'N/A';
          }).join(' + ');

          const endDatesRaw = order.products.map(p => {
            const isValEnabled = p.validationEnabled === true || String(p.validationEnabled).toLowerCase() === 'true';
            if (!isValEnabled) return '';
            return p.endDate ? formatDateToDDMMYYYY(p.endDate) : 'N/A';
          }).join(' + ');

          const startDatesStr = cleanJoinedStr(startDatesRaw);
          const endDatesStr = cleanJoinedStr(endDatesRaw);

          rows.push({
            'Name': c.name,
            'Phone': Array.isArray(c.phone) ? c.phone.join(', ') : c.phone,
            'Email': Array.isArray(c.email) ? c.email.join(', ') : c.email,
            'Contact Person': c.contactPerson || null,
            'Address': c.address || null,
            'State': c.state || null,
            'GSTIN': c.gstin || null,
            'Notes': c.notes || null,
            'Domain URL': order.domainUrl || null,
            'Product': productsStr,
            'Variant': variantsStr,
            'Quantity': quantitiesStr,
            'Cost Price': costPricesStr,
            'Price': pricesStr,
            'Validation Enabled': validationsStr,
            'Start Date': startDatesStr,
            'End Date': endDatesStr,
            'Seller Renewal': sellerRenewalsStr,
            'Cost Renewal': costRenewalsStr,
            'Order Date': orderDate ? formatDateToDDMMYYYY(orderDate) : null,
            'Order Total Price': totalPrice,
            'Payment Date': paymentDates,
            'Payment Status': paymentStatus,
            'Payment Amount': paymentAmounts,
            'Orders Data (JSON)': JSON.stringify(c.orders)
          });
        }
      });
    });

    const worksheet = xlsx.utils.json_to_sheet(rows, { nullAsBlank: true });

    const colWidths = {};
    rows.forEach(row => {
      Object.entries(row).forEach(([key, val]) => {
        const len = val != null ? String(val).length : 0;
        colWidths[key] = Math.max(colWidths[key] || key.length, Math.min(len, 60));
      });
    });
    worksheet['!cols'] = Object.values(colWidths).map(w => ({ wch: w + 2 }));

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Customers');

    const fs = require('fs');
    const path = require('path');
    const tempFilePath = path.join(__dirname, `../temp_export_${Date.now()}.xlsx`);

    xlsx.writeFile(workbook, tempFilePath);

    res.download(tempFilePath, 'customers.xlsx', (err) => {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (unlinkErr) {
        console.error("Error deleting temp file:", unlinkErr);
      }
      if (err) {
        console.error("Download error:", err);
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a specific order from customer order history
// @route   DELETE /api/customers/:customerId/orders/:orderId
// @access  Private
const deleteOrder = async (req, res) => {
  try {
    const { customerId, orderId } = req.params;

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    customer.orders = customer.orders.filter(o => o._id.toString() !== orderId);

    const updatedCustomer = await customer.save();
    res.json(updatedCustomer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Download sample excel file
// @route   GET /api/customers/sample
// @access  Private
const downloadSampleExcel = async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');

    const loc1 = path.join(__dirname, '../public/Sample.xlsx');
    const loc3 = path.join(__dirname, '../Sample.xlsx');

    let finalPath = null;
    if (fs.existsSync(loc1)) {
      finalPath = loc1;
    } else if (fs.existsSync(loc3)) {
      finalPath = loc3;
    }

    if (!finalPath) {
      return res.status(404).json({ message: 'Sample file not found' });
    }

    res.download(finalPath, 'Sample.xlsx');
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get mail history for customer
// @route   GET /api/customers/:id/mail-history
// @access  Private
const getMailHistory = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    const history = (customer.mailHistory || []).sort((a, b) => new Date(b.sentAt || b.createdAt) - new Date(a.sentAt || a.createdAt));
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Send a reminder email
// @route   POST /api/customers/:id/remind
// @access  Private
const sendReminderEmail = async (req, res) => {
  const { subject, fullSubject, content, orderId, orderIds, templateType, bypassEmail, attachProforma, proformaData } = req.body;
  let customer;
  try {
    customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    if (!subject || !content) {
      return res.status(400).json({ message: 'Subject and content are required' });
    }

    let attachments = [];
    if (attachProforma && proformaData) {
      try {
        const puppeteer = require('puppeteer');
        const GstSetting = require('../models/GstSetting');
        const Proforma = require('../models/Proforma');
        const { generateProformaHtml } = require('../templates/proformaTemplate');

        let settings = await GstSetting.findOne();
        if (!settings) {
          settings = {
            companyName: 'Jayam Web Solutions',
            address: '7/1, Thirumazhisai street, Tambaram Sanatorium, Selaiyur, Chennai 600 059.',
            phone: '9677876445 / 9840599789',
            email: 'jayamwebsolutions@gmail.com',
            gstin: '33AAAAA0000A1Z5',
            cgstPercentage: 9,
            sgstPercentage: 9,
            igstPercentage: 18,
            signatureImage: ''
          };
        }

        const htmlContent = generateProformaHtml(proformaData, settings);

        const browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        await page.evaluateHandle('document.fonts.ready');

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: {
            top: '5mm',
            right: '5mm',
            bottom: '5mm',
            left: '5mm'
          }
        });

        await browser.close();

        const cleanCompany = (proformaData.companyName || customer.name || 'Customer').replace(/[\s\/\\]+/g, '');
        const proformaNo = proformaData.proforma_no || 'Proforma';
        const filename = `PROFORMA-Invoice-${cleanCompany}-${proformaNo}.pdf`;
        attachments.push({
          filename: filename,
          content: pdfBuffer
        });

        if (proformaData.proforma_no) {
          try {
            const existingProforma = await Proforma.findOne({ proforma_no: proformaData.proforma_no.trim() });
            if (!existingProforma) {
              await Proforma.create(proformaData);
            }
          } catch (profSaveErr) {
            console.warn('Could not save proforma record to database:', profSaveErr);
          }
        }
      } catch (pdfErr) {
        console.error('Error generating proforma attachment:', pdfErr);
        return res.status(500).json({ message: `Failed to generate Proforma PDF attachment: ${pdfErr.message}` });
      }
    }

    if (!bypassEmail) {
      const { reminderTemplate } = require('../utils/emailTemplates');
      const sendEmail = require('../utils/sendEmail');

      await sendEmail({
        email: customer.email,
        subject: subject,
        message: reminderTemplate(subject, content, templateType, fullSubject),
        attachments: attachments.length > 0 ? attachments : undefined
      });
    }

    const targetOrderIds = Array.isArray(orderIds) && orderIds.length > 0
      ? orderIds
      : (orderId ? [orderId] : []);

    if (!customer.mailHistory) customer.mailHistory = [];
    customer.mailHistory.push({
      templateType: templateType || 'Renewal',
      status: 'Sent',
      mode: bypassEmail ? 'WhatsApp' : 'Email',
      orderId: targetOrderIds.join(', ') || '',
      sentAt: new Date()
    });

    if (targetOrderIds.length > 0) {
      targetOrderIds.forEach(oId => {
        const order = customer.orders.id(oId);
        if (order) {
          if (templateType === 'Expired') {
            order.expiredEmailSend = true;
          } else if (templateType === 'Deletion') {
            order.deletionEmailSend = true;
          } else {
            order.emailSend = true;
          }
        }
      });
      customer.markModified('orders');
    }

    await customer.save();

    res.status(200).json({ message: bypassEmail ? 'Reminder logged successfully' : (attachProforma ? 'Reminder email sent successfully with Proforma Invoice attachment' : 'Reminder email sent successfully') });
  } catch (error) {
    console.error('Error sending reminder email:', error);
    if (customer && subject && content) {
      try {
        const targetOrderIds = Array.isArray(orderIds) && orderIds.length > 0
          ? orderIds
          : (orderId ? [orderId] : []);
        if (!customer.mailHistory) customer.mailHistory = [];
        customer.mailHistory.push({
          templateType: templateType || 'Renewal',
          status: 'Failed',
          mode: bypassEmail ? 'WhatsApp' : 'Email',
          orderId: targetOrderIds.join(', ') || '',
          sentAt: new Date()
        });
        await customer.save();
      } catch (logErr) {
        console.error('Failed to log failed email attempt:', logErr);
      }
    }
    res.status(500).json({
      message: `Failed to send email: ${error.message || 'Unknown error'}. Please try again.`
    });
  }
};

// @desc    Email invoice
// @route   POST /api/customers/:id/email-invoice
// @access  Private
const emailInvoice = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Invoice PDF is required' });
    }

    const { subject, message } = req.body;
    const { reminderTemplate } = require('../utils/emailTemplates');
    const sendEmail = require('../utils/sendEmail');

    const defaultSubject = subject || 'Invoice from Jayam Web Solutions';
    const defaultMessage = message || `Dear Sir/ Ma'am,\n\nPlease find attached the ${defaultSubject}.\n\nThanks & Regards,\nJayam Web Solutions`;

    await sendEmail({
      email: customer.email,
      subject: defaultSubject,
      message: reminderTemplate(defaultSubject, defaultMessage, 'Invoice'),
      attachments: [
        {
          filename: req.file.originalname || 'Invoice.pdf',
          content: req.file.buffer
        }
      ]
    });

    if (!customer.mailHistory) customer.mailHistory = [];
    customer.mailHistory.push({
      templateType: 'Invoice',
      status: 'Sent',
      mode: 'Email',
      sentAt: new Date()
    });
    await customer.save();

    res.status(200).json({ message: 'Invoice emailed successfully' });
  } catch (error) {
    console.error('Error emailing invoice:', error);
    res.status(500).json({ message: 'Failed to email invoice', error: error.message });
  }
};

// @desc    Export reminders / deactive list to excel
// @route   GET /api/customers/reminders/export
// @access  Private
const exportRemindersExcel = async (req, res) => {
  try {
    const { days, month, year, deactive, paymentStatus } = req.query;
    let customers = [];
    let futureStr = "";
    let todayStr = "";

    const hasMonthFilter = month && month !== 'all';
    const hasYearFilter = year && year !== 'all';

    const daysCount = parseInt(days) || 7;
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + daysCount);

    const getLocalYYYYMMDD = (d) => {
      const yearVal = d.getFullYear();
      const monthVal = String(d.getMonth() + 1).padStart(2, '0');
      const dayVal = String(d.getDate()).padStart(2, '0');
      return `${yearVal}-${monthVal}-${dayVal}`;
    };

    todayStr = getLocalYYYYMMDD(today);
    futureStr = getLocalYYYYMMDD(futureDate);

    customers = await Customer.find({ 'orders.0': { $exists: true } });

    const rows = [];
    customers.forEach(customer => {
      customer.orders.forEach(order => {
        const prods = order.products || [];
        if (prods.length === 0) return;

        const hasDeactiveProds = order.deactive || prods.some(p => p.deactive);
        const hasActiveProds = !order.deactive && prods.some(p => !p.deactive && p.validationEnabled !== false);

        if (deactive === 'deactive' && !hasDeactiveProds) return;
        if (deactive === 'active' && !hasActiveProds) return;

        const isPaidOrder = (order.paymentStatus === 'Fully Paid' || order.paymentStatus === 'Paid');

        if (deactive !== 'deactive') {
          if (paymentStatus === 'paid' && !isPaidOrder) return;
          if (paymentStatus === 'unpaid' && isPaidOrder) return;
        }

        const lastPayDateYYYYMMDD = getOrderLastPaymentDate(order);

        let filterDateStr = "";
        if (paymentStatus === 'paid' || isPaidOrder) {
          filterDateStr = formatDateToYYYYMMDD(order.startDate) || order.endDate || "";
        } else {
          filterDateStr = order.endDate || "";
        }

        let isMatch = false;
        if (deactive === 'deactive') {
          isMatch = true;
        } else if (hasMonthFilter || hasYearFilter || month === 'all' || year === 'all') {
          if (filterDateStr) {
            const parts = filterDateStr.split('-');
            if (parts.length === 3) {
              const orderYear = parts[0];
              const orderMonth = parts[1];

              const matchMonth = !hasMonthFilter || orderMonth === month.padStart(2, '0');
              const matchYear = !hasYearFilter || orderYear === String(year);

              if (matchMonth && matchYear) {
                isMatch = true;
              }
            }
          }
          if (!isMatch && hasDeactiveProds && !deactive) {
            isMatch = true;
          }
        } else {
          if (filterDateStr && filterDateStr >= todayStr && filterDateStr <= futureStr) {
            isMatch = true;
          } else if (hasDeactiveProds && !deactive) {
            isMatch = true;
          }
        }

        if (isMatch) {
          const targetProds = deactive === 'deactive'
            ? prods.filter(p => p.deactive)
            : prods.filter(p => !p.deactive && p.validationEnabled !== false);

          targetProds.forEach(p => {
            const resolvedPrices = getCatalogPrices(p);
            const prodPrice = (p.price !== undefined && p.price !== null && p.price > 0)
              ? p.price
              : (resolvedPrices.selling * (p.quantity || 1));

            rows.push({
              'Status': p.deactive ? 'Deactive' : 'Active',
              'Deactive Date / Expiry Date': p.deactive ? formatDateToDDMMYYYY(p.deactiveYear) : formatDateToDDMMYYYY(p.endDate || order.endDate),
              'Customer Name': customer.name || '',
              'Phone': Array.isArray(customer.phone) ? customer.phone.join(', ') : (customer.phone || ''),
              'Email': Array.isArray(customer.email) ? customer.email.join(', ') : (customer.email || ''),
              'Domain URL': order.domainUrl || '',
              'Product Name': p.product || '',
              'Quantity': p.quantity || 1,
              'Price (₹)': prodPrice,
              'Order Date': formatDateToDDMMYYYY(order.orderDate),
              'Start Date': formatDateToDDMMYYYY(p.startDate || order.startDate),
              'End Date': formatDateToDDMMYYYY(p.endDate || order.endDate),
            });
          });
        }
      });
    });

    const worksheet = xlsx.utils.json_to_sheet(rows, { nullAsBlank: true });

    const colWidths = {};
    rows.forEach(row => {
      Object.entries(row).forEach(([key, val]) => {
        const len = val != null ? String(val).length : 0;
        colWidths[key] = Math.max(colWidths[key] || key.length, Math.min(len, 60));
      });
    });
    worksheet['!cols'] = Object.values(colWidths).map(w => ({ wch: w + 2 }));

    const workbook = xlsx.utils.book_new();
    const sheetName = deactive === 'deactive' ? 'Deactive Products' : 'Reminders';
    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);

    const fs = require('fs');
    const path = require('path');
    const filename = deactive === 'deactive' ? `Deactive_Products_${Date.now()}.xlsx` : `Reminders_${Date.now()}.xlsx`;
    const tempFilePath = path.join(__dirname, `../${filename}`);

    xlsx.writeFile(workbook, tempFilePath);

    res.download(tempFilePath, filename, (err) => {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (unlinkErr) {
        console.error("Error deleting temp file:", unlinkErr);
      }
      if (err) {
        console.error("Download error:", err);
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get report analytics (customers, orders, active & deactive domains, chart buckets)
// @route   GET /api/customers/reports
// @access  Private
const getReportAnalytics = async (req, res) => {
  try {
    const { filterMode = 'year', year, month } = req.query;

    const currentDate = new Date();
    const currentYearStr = currentDate.getFullYear().toString();
    const currentMonthStr = String(currentDate.getMonth() + 1).padStart(2, '0');

    const selectedYear = year ? String(year) : currentYearStr;
    const selectedMonth = month ? String(month).padStart(2, '0') : currentMonthStr;

    const customers = await Customer.find({}).lean();

    const monthNames = [
      { value: '01', label: 'January' },
      { value: '02', label: 'February' },
      { value: '03', label: 'March' },
      { value: '04', label: 'April' },
      { value: '05', label: 'May' },
      { value: '06', label: 'June' },
      { value: '07', label: 'July' },
      { value: '08', label: 'August' },
      { value: '09', label: 'September' },
      { value: '10', label: 'October' },
      { value: '11', label: 'November' },
      { value: '12', label: 'December' },
    ];

    const parseDateParts = (dateStr) => {
      if (!dateStr) return null;
      const str = String(dateStr).trim().replace(/\//g, '-');

      if (/^\d{4}$/.test(str)) {
        return { year: str, month: null, day: null };
      }

      const parts = str.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return { year: parts[0], month: parts[1].padStart(2, '0'), day: parseInt(parts[2], 10) || null };
        }
        if (parts[2].length === 4) {
          return { year: parts[2], month: parts[1].padStart(2, '0'), day: parseInt(parts[0], 10) || null };
        }
      } else if (parts.length === 2) {
        if (parts[0].length === 4) {
          return { year: parts[0], month: parts[1].padStart(2, '0'), day: null };
        }
        if (parts[1].length === 4) {
          return { year: parts[1], month: parts[0].padStart(2, '0'), day: null };
        }
      }

      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear().toString();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = d.getDate();
        return { year: y, month: m, day };
      }

      return null;
    };

    const parseDateToMs = (dateStr) => {
      if (!dateStr) return 0;
      const parsed = parseDateParts(dateStr);
      if (parsed) {
        const y = parseInt(parsed.year, 10) || 1970;
        const m = parsed.month ? parseInt(parsed.month, 10) - 1 : 0;
        const d = parsed.day ? parseInt(parsed.day, 10) : 1;
        return new Date(y, m, d).getTime();
      }
      const t = new Date(dateStr).getTime();
      return isNaN(t) ? 0 : t;
    };

    const isDateInFilter = (dateStr) => {
      if (!dateStr) return false;
      const parsed = parseDateParts(dateStr);
      if (!parsed) return false;

      const { year: y, month: m } = parsed;

      if (filterMode === 'all') return true;
      if (filterMode === 'year') return y === selectedYear;
      if (filterMode === 'month') {
        if (m) return y === selectedYear && m === selectedMonth;
        return y === selectedYear;
      }
      return true;
    };

    const getBestDeactiveDate = (p) => {
      return p.deactiveDate || p.deactiveYear || p.endDate || null;
    };

    const isDeactiveDomainInFilter = (p) => {
      const deactiveDateStr = getBestDeactiveDate(p);
      if (!deactiveDateStr) return false;

      const parsed = parseDateParts(deactiveDateStr);
      if (!parsed) return false;

      const { year: y, month: m } = parsed;

      if (filterMode === 'all') return true;

      if (filterMode === 'year') {
        return y === selectedYear || String(p.deactiveYear || '') === selectedYear;
      }

      if (filterMode === 'month') {
        const matchesYear = y === selectedYear || String(p.deactiveYear || '') === selectedYear;
        if (!matchesYear) return false;

        if (m) {
          return m === selectedMonth;
        }
        return true;
      }

      return true;
    };

    const getBestActiveDate = (p, ord) => {
      const candidates = [p.startDate, ord.orderDate, ord.createdAt];
      for (const cand of candidates) {
        if (cand) {
          const parsed = parseDateParts(cand);
          if (parsed && parsed.month) return cand;
        }
      }
      return p.startDate || ord.orderDate || ord.createdAt;
    };

    const yearsSet = new Set([currentYearStr]);
    customers.forEach((c) => {
      if (c.createdAt) {
        const y = new Date(c.createdAt).getFullYear();
        if (!isNaN(y)) yearsSet.add(y.toString());
      }
      if (c.orders && Array.isArray(c.orders)) {
        c.orders.forEach((o) => {
          if (o.orderDate) {
            const y = new Date(o.orderDate).getFullYear();
            if (!isNaN(y)) yearsSet.add(y.toString());
          }
        });
      }
    });
    const availableYears = Array.from(yearsSet).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));

    const numYears = Array.from(yearsSet).map((y) => parseInt(y, 10)).filter((y) => !isNaN(y));
    const minY = numYears.length > 0 ? Math.min(...numYears) : parseInt(currentYearStr, 10);
    const maxY = numYears.length > 0 ? Math.max(...numYears) : parseInt(currentYearStr, 10);
    const allYearsRange = [];
    for (let y = minY; y <= maxY; y++) {
      allYearsRange.push(y.toString());
    }

    let totalCustomersCount = 0;
    let totalOrdersCount = 0;
    let activeDomainsCount = 0;
    let deactiveDomainsCount = 0;

    const filteredCustomerList = [];
    const filteredOrderList = [];
    const filteredActiveDomainList = [];
    const filteredDeactiveDomainList = [];

    const chartBuckets = filterMode === 'month'
      ? Array.from({ length: 31 }, (_, i) => ({
        label: `${i + 1}`,
        customers: 0,
        orders: 0,
        activeDomains: 0,
        deactiveDomains: 0,
      }))
      : filterMode === 'all'
        ? allYearsRange.map((yr) => ({
          label: yr,
          yearVal: yr,
          customers: 0,
          orders: 0,
          activeDomains: 0,
          deactiveDomains: 0,
        }))
        : monthNames.map((m) => ({
          label: m.label.substring(0, 3),
          monthVal: m.value,
          customers: 0,
          orders: 0,
          activeDomains: 0,
          deactiveDomains: 0,
        }));

    const addChartBucketCount = (dateStr, key) => {
      const parsed = parseDateParts(dateStr);
      if (!parsed) return;
      const { year: y, month: m, day: d } = parsed;

      if (filterMode === 'month') {
        if (y === selectedYear) {
          const targetMonth = m || selectedMonth;
          if (targetMonth === selectedMonth) {
            const dayIdx = d ? Math.min(30, Math.max(0, d - 1)) : 0;
            if (chartBuckets[dayIdx]) {
              chartBuckets[dayIdx][key]++;
            }
          }
        }
      } else if (filterMode === 'year') {
        if (y === selectedYear) {
          const mIdx = m ? parseInt(m, 10) - 1 : 0;
          if (mIdx >= 0 && mIdx < 12 && chartBuckets[mIdx]) {
            chartBuckets[mIdx][key]++;
          }
        }
      } else if (filterMode === 'all') {
        const bIdx = chartBuckets.findIndex((b) => b.yearVal === y);
        if (bIdx !== -1) {
          chartBuckets[bIdx][key]++;
        }
      }
    };

    customers.forEach((cust) => {
      const custMatchesFilter = isDateInFilter(cust.createdAt);
      let customerOrdersInFilter = 0;
      let custActiveCount = 0;
      let custDeactiveCount = 0;
      let custTotalSpent = 0;

      const custOrders = cust.orders || [];

      custOrders.forEach((ord) => {
        const orderMatches = isDateInFilter(ord.orderDate || ord.createdAt);

        let orderActiveProds = 0;
        let orderDeactiveProds = 0;
        let totalActiveProdsInOrder = 0;
        let totalDeactiveProdsInOrder = 0;

        (ord.products || []).forEach((p, pIdx) => {
          const isDomain = p.product && String(p.product).toLowerCase().includes('domain');

          if (p.deactive) {
            totalDeactiveProdsInOrder++;
            if (isDomain) orderDeactiveProds++;
          } else {
            totalActiveProdsInOrder++;
            if (isDomain) orderActiveProds++;
          }

          if (isDomain) {
            const domainItem = {
              id: `${ord._id}_${pIdx}`,
              customerId: cust._id,
              customerName: cust.name,
              email: Array.isArray(cust.email) ? cust.email.join(', ') : (cust.email || '—'),
              phone: Array.isArray(cust.phone) ? cust.phone.join(', ') : (cust.phone || '—'),
              domainUrl: ord.domainUrl || '—',
              product: p.product,
              variant: p.variant,
              price: p.price,
              startDate: p.startDate,
              endDate: p.endDate,
              deactiveYear: p.deactiveYear,
              deactiveDate: p.deactiveDate,
              orderDate: ord.orderDate || ord.createdAt,
              isDeactive: Boolean(p.deactive),
            };

            if (p.deactive) {
              const deactiveDateStr = getBestDeactiveDate(p);
              if (isDeactiveDomainInFilter(p)) {
                deactiveDomainsCount++;
                custDeactiveCount++;
                filteredDeactiveDomainList.push(domainItem);
                if (deactiveDateStr) {
                  addChartBucketCount(deactiveDateStr, 'deactiveDomains');
                }
              }
            } else {
              const activeDateStr = getBestActiveDate(p, ord);
              if (isDateInFilter(activeDateStr)) {
                activeDomainsCount++;
                custActiveCount++;
                filteredActiveDomainList.push(domainItem);
                addChartBucketCount(activeDateStr, 'activeDomains');
              }
            }
          }
        });

        if (orderMatches) {
          totalOrdersCount++;
          customerOrdersInFilter++;

          const paidAmt = ord.payments?.reduce((sum, pay) => sum + (pay.amount || 0), 0) || (ord.paymentStatus === 'Fully Paid' ? ord.totalPrice : 0);
          custTotalSpent += paidAmt;

          const hasDomainProds = orderActiveProds > 0 || orderDeactiveProds > 0;
          const orderIsDeactive = hasDomainProds
            ? (orderDeactiveProds > 0 && orderActiveProds === 0)
            : (totalDeactiveProdsInOrder > 0 && totalActiveProdsInOrder === 0);

          filteredOrderList.push({
            orderId: ord._id,
            orderDate: ord.orderDate || ord.createdAt,
            customerName: cust.name,
            customerId: cust._id,
            email: Array.isArray(cust.email) ? cust.email.join(', ') : cust.email,
            phone: Array.isArray(cust.phone) ? cust.phone.join(', ') : cust.phone,
            domainUrl: ord.domainUrl,
            products: ord.products || [],
            totalPrice: ord.totalPrice,
            paidAmount: paidAmt,
            paymentStatus: ord.paymentStatus,
            activeProdsCount: orderActiveProds,
            deactiveProdsCount: orderDeactiveProds,
            isDeactive: orderIsDeactive,
          });

          addChartBucketCount(ord.orderDate || ord.createdAt, 'orders');
        }
      });

      if (custMatchesFilter) {
        totalCustomersCount++;

        filteredCustomerList.push({
          customerId: cust._id,
          name: cust.name,
          email: Array.isArray(cust.email) ? cust.email.join(', ') : (cust.email || '—'),
          phone: Array.isArray(cust.phone) ? cust.phone.join(', ') : (cust.phone || '—'),
          state: cust.state || 'Tamil Nadu',
          gstin: cust.gstin || '—',
          createdAt: cust.createdAt,
          ordersCount: custOrders.length,
          ordersInFilterCount: customerOrdersInFilter,
          activeDomainsCount: custActiveCount,
          deactiveDomainsCount: custDeactiveCount,
          totalSpent: custTotalSpent,
        });

        addChartBucketCount(cust.createdAt, 'customers');
      }
    });

    filteredCustomerList.sort((a, b) => parseDateToMs(a.createdAt) - parseDateToMs(b.createdAt));
    filteredOrderList.sort((a, b) => parseDateToMs(a.orderDate) - parseDateToMs(b.orderDate));
    filteredActiveDomainList.sort((a, b) => parseDateToMs(a.orderDate) - parseDateToMs(b.orderDate));
    filteredDeactiveDomainList.sort((a, b) => {
      const dateA = a.deactiveDate || a.deactiveYear || a.orderDate;
      const dateB = b.deactiveDate || b.deactiveYear || b.orderDate;
      return parseDateToMs(dateA) - parseDateToMs(dateB);
    });

    res.json({
      totalCustomersCount,
      totalOrdersCount,
      activeDomainsCount,
      deactiveDomainsCount,
      filteredCustomerList,
      filteredOrderList,
      filteredActiveDomainList,
      filteredDeactiveDomainList,
      chartBuckets,
      availableYears,
      allYearsRange,
    });
  } catch (error) {
    console.error("Error generating report analytics:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Export report analytics to Excel (.xlsx) based on selected tab & filter
// @route   GET /api/customers/reports/export
// @access  Private
const exportReportExcel = async (req, res) => {
  try {
    const { filterMode = 'year', year, month, activeTab = 'customers' } = req.query;

    const currentDate = new Date();
    const currentYearStr = currentDate.getFullYear().toString();
    const currentMonthStr = String(currentDate.getMonth() + 1).padStart(2, '0');

    const selectedYear = year ? String(year) : currentYearStr;
    const selectedMonth = month ? String(month).padStart(2, '0') : currentMonthStr;

    const customers = await Customer.find({}).lean();

    const parseDateParts = (dateStr) => {
      if (!dateStr) return null;
      const str = String(dateStr).trim().replace(/\//g, '-');
      if (/^\d{4}$/.test(str)) {
        return { year: str, month: null, day: null };
      }
      const parts = str.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return { year: parts[0], month: parts[1].padStart(2, '0'), day: parseInt(parts[2], 10) || null };
        }
        if (parts[2].length === 4) {
          return { year: parts[2], month: parts[1].padStart(2, '0'), day: parseInt(parts[0], 10) || null };
        }
      } else if (parts.length === 2) {
        if (parts[0].length === 4) {
          return { year: parts[0], month: parts[1].padStart(2, '0'), day: null };
        }
        if (parts[1].length === 4) {
          return { year: parts[1], month: parts[0].padStart(2, '0'), day: null };
        }
      }
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear().toString();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = d.getDate();
        return { year: y, month: m, day };
      }
      return null;
    };

    const parseDateToMs = (dateStr) => {
      if (!dateStr) return 0;
      const parsed = parseDateParts(dateStr);
      if (parsed) {
        const y = parseInt(parsed.year, 10) || 1970;
        const m = parsed.month ? parseInt(parsed.month, 10) - 1 : 0;
        const d = parsed.day ? parseInt(parsed.day, 10) : 1;
        return new Date(y, m, d).getTime();
      }
      const t = new Date(dateStr).getTime();
      return isNaN(t) ? 0 : t;
    };

    const formatDateStr = (dateStr) => {
      if (!dateStr) return '—';
      const parsed = parseDateParts(dateStr);
      if (parsed && parsed.year && parsed.month && parsed.day) {
        return `${String(parsed.day).padStart(2, '0')}-${String(parsed.month).padStart(2, '0')}-${parsed.year}`;
      }
      return String(dateStr);
    };

    const isDateInFilter = (dateStr) => {
      if (!dateStr) return false;
      const parsed = parseDateParts(dateStr);
      if (!parsed) return false;
      const { year: y, month: m } = parsed;
      if (filterMode === 'all') return true;
      if (filterMode === 'year') return y === selectedYear;
      if (filterMode === 'month') {
        if (m) return y === selectedYear && m === selectedMonth;
        return y === selectedYear;
      }
      return true;
    };

    const getBestDeactiveDate = (p) => {
      return p.deactiveDate || p.deactiveYear || p.endDate || null;
    };

    const isDeactiveDomainInFilter = (p) => {
      const deactiveDateStr = getBestDeactiveDate(p);
      if (!deactiveDateStr) return false;
      const parsed = parseDateParts(deactiveDateStr);
      if (!parsed) return false;
      const { year: y, month: m } = parsed;
      if (filterMode === 'all') return true;
      if (filterMode === 'year') {
        return y === selectedYear || String(p.deactiveYear || '') === selectedYear;
      }
      if (filterMode === 'month') {
        const matchesYear = y === selectedYear || String(p.deactiveYear || '') === selectedYear;
        if (!matchesYear) return false;
        if (m) return m === selectedMonth;
        return true;
      }
      return true;
    };

    const getBestActiveDate = (p, ord) => {
      const candidates = [p.startDate, ord.orderDate, ord.createdAt];
      for (const cand of candidates) {
        if (cand) {
          const parsed = parseDateParts(cand);
          if (parsed && parsed.month) return cand;
        }
      }
      return p.startDate || ord.orderDate || ord.createdAt;
    };

    const filteredCustomerList = [];
    const filteredOrderList = [];
    const filteredActiveDomainList = [];
    const filteredDeactiveDomainList = [];

    customers.forEach((cust) => {
      const custMatchesFilter = isDateInFilter(cust.createdAt);
      const custOrders = cust.orders || [];

      custOrders.forEach((ord) => {
        const orderMatches = isDateInFilter(ord.orderDate || ord.createdAt);

        (ord.products || []).forEach((p, pIdx) => {
          const isDomain = p.product && String(p.product).toLowerCase().includes('domain');
          if (isDomain) {
            const domainItem = {
              id: `${ord._id}_${pIdx}`,
              customerId: cust._id,
              customerName: cust.name,
              email: Array.isArray(cust.email) ? cust.email.join(', ') : (cust.email || '—'),
              phone: Array.isArray(cust.phone) ? cust.phone.join(', ') : (cust.phone || '—'),
              domainUrl: ord.domainUrl || '—',
              product: p.product,
              startDate: p.startDate,
              endDate: p.endDate,
              deactiveYear: p.deactiveYear,
              deactiveDate: p.deactiveDate,
              orderDate: ord.orderDate || ord.createdAt,
            };

            if (p.deactive) {
              if (isDeactiveDomainInFilter(p)) {
                filteredDeactiveDomainList.push(domainItem);
              }
            } else {
              const activeDateStr = getBestActiveDate(p, ord);
              if (isDateInFilter(activeDateStr)) {
                filteredActiveDomainList.push(domainItem);
              }
            }
          }
        });

        if (orderMatches) {
          filteredOrderList.push({
            orderId: ord._id,
            orderDate: ord.orderDate || ord.createdAt,
            customerName: cust.name,
            email: Array.isArray(cust.email) ? cust.email.join(', ') : cust.email,
            phone: Array.isArray(cust.phone) ? cust.phone.join(', ') : cust.phone,
            domainUrl: ord.domainUrl || '—',
            products: (ord.products || []).map((p) => p.product + (p.deactive ? ' (Deactive)' : '')).join(', '),
            totalPrice: ord.totalPrice || 0,
          });
        }
      });

      if (custMatchesFilter) {
        filteredCustomerList.push({
          customerId: cust._id,
          name: cust.name,
          email: Array.isArray(cust.email) ? cust.email.join(', ') : (cust.email || '—'),
          phone: Array.isArray(cust.phone) ? cust.phone.join(', ') : (cust.phone || '—'),
          state: cust.state || 'Tamil Nadu',
          createdAt: cust.createdAt,
        });
      }
    });

    filteredCustomerList.sort((a, b) => parseDateToMs(a.createdAt) - parseDateToMs(b.createdAt));
    filteredOrderList.sort((a, b) => parseDateToMs(a.orderDate) - parseDateToMs(b.orderDate));
    filteredActiveDomainList.sort((a, b) => parseDateToMs(a.orderDate) - parseDateToMs(b.orderDate));
    filteredDeactiveDomainList.sort((a, b) => {
      const dateA = a.deactiveDate || a.deactiveYear || a.orderDate;
      const dateB = b.deactiveDate || b.deactiveYear || b.orderDate;
      return parseDateToMs(dateA) - parseDateToMs(dateB);
    });

    let exportRows = [];
    let sheetName = 'Report Data';

    if (activeTab === 'customers') {
      sheetName = 'Customer List';
      exportRows = filteredCustomerList.map((c) => ({
        'Created Date': formatDateStr(c.createdAt),
        'Customer Name': c.name,
        'Contact Email': c.email,
        'Phone Number': c.phone,
        'State': c.state,
      }));
    } else if (activeTab === 'orders') {
      sheetName = 'Order List';
      exportRows = filteredOrderList.map((o) => ({
        'Order Date': formatDateStr(o.orderDate),
        'Customer Name': o.customerName,
        'Contact Email': o.email,
        'Phone Number': o.phone,
        'Services / Products': o.products,
        'Domain URL': o.domainUrl,
        'Total Price (INR)': o.totalPrice,
      }));
    } else if (activeTab === 'activeDomains') {
      sheetName = 'Active Domains';
      exportRows = filteredActiveDomainList.map((d) => ({
        'Create Date': formatDateStr(d.orderDate),
        'Domain URL': d.domainUrl,
        'Customer Name': d.customerName,
        'Contact Email': d.email,
        'Phone Number': d.phone,
        'Start Date': formatDateStr(d.startDate),
        'End Date': formatDateStr(d.endDate),
      }));
    } else if (activeTab === 'deactiveDomains') {
      sheetName = 'Deactive Domains';
      exportRows = filteredDeactiveDomainList.map((d) => ({
        'Create Date': formatDateStr(d.orderDate),
        'Domain URL': d.domainUrl,
        'Customer Name': d.customerName,
        'Contact Email': d.email,
        'Phone Number': d.phone,
        'Deactivate Date': formatDateStr(d.deactiveDate || d.deactiveYear),
      }));
    }

    if (exportRows.length === 0) {
      exportRows = [{ 'Status': 'No records found for the selected filter' }];
    }

    const worksheet = xlsx.utils.json_to_sheet(exportRows);

    const colWidths = {};
    exportRows.forEach((row) => {
      Object.entries(row).forEach(([key, val]) => {
        const len = val != null ? String(val).length : 0;
        colWidths[key] = Math.max(colWidths[key] || key.length, Math.min(len, 60));
      });
    });
    worksheet['!cols'] = Object.values(colWidths).map((w) => ({ wch: w + 4 }));

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);

    const fs = require('fs');
    const path = require('path');
    const filename = `Report_${sheetName.replace(/\s+/g, '_')}_${Date.now()}.xlsx`;
    const tempFilePath = path.join(__dirname, `../${filename}`);

    xlsx.writeFile(workbook, tempFilePath);

    res.download(tempFilePath, filename, (err) => {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (unlinkErr) {
        console.error("Error deleting temp file:", unlinkErr);
      }
      if (err) {
        console.error("Report download error:", err);
      }
    });
  } catch (error) {
    console.error("Error exporting report Excel:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Record payment for single or multiple orders (group payment)
// @route   POST /api/customers/:id/record-payment
// @access  Private
const recordPayment = async (req, res) => {
  try {
    const customerId = req.params.id;
    const {
      selectedOrderIds,
      amount,
      paymentDate,
      years = 1,
      startDate,
      endDate,
      paymentNote,
      withGst = false,
      gstvalue = 0,
      state,
      gstin,
      paymentStage = 'full', // 'advance', 'mid', 'final', 'full'
      stageNumber,
      tdsAmount = 0
    } = req.body;

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    if (withGst) {
      if (state) customer.state = state;
      if (gstin) customer.gstin = gstin;
    }

    const targetIds = (Array.isArray(selectedOrderIds) && selectedOrderIds.length > 0)
      ? selectedOrderIds
      : [];

    if (targetIds.length === 0) {
      return res.status(400).json({ message: "No target order IDs provided" });
    }

    let updatedCount = 0;
    const numYears = Number(years) || 1;

    customer.orders.forEach(order => {
      if (targetIds.includes(order._id.toString())) {
        const unitPrice = order.sellerPriceRenewal !== null && order.sellerPriceRenewal !== undefined
          ? order.sellerPriceRenewal
          : (order.totalPrice || 0);

        const itemBaseAmount = targetIds.length === 1 && amount
          ? Number(amount)
          : unitPrice * numYears;

        const itemGst = withGst && gstvalue
          ? Math.round(Number(gstvalue) / targetIds.length)
          : 0;

        const stageVal = ['advance', 'mid', 'final', 'full'].includes(paymentStage) ? paymentStage : 'full';
        let computedStageNumber = stageNumber;
        if (!computedStageNumber) {
          if (stageVal === 'advance') {
            computedStageNumber = 1;
          } else if (stageVal === 'mid') {
            const priorMids = (order.payments || []).filter(p => p.paymentStage === 'mid').length;
            computedStageNumber = priorMids + 1;
          } else if (stageVal === 'final') {
            computedStageNumber = (order.payments || []).length + 1;
          } else {
            computedStageNumber = 1;
          }
        }

        const newPayment = {
          date: paymentDate || new Date().toISOString(),
          amount: itemBaseAmount,
          gstvalue: itemGst,
          paymentType: "renewal",
          paymentStage: stageVal,
          stageNumber: computedStageNumber,
          withGst: !!withGst,
          description: paymentNote || ``,
          renewalSellingPrice: itemBaseAmount,
          renewalCostPrice: order.costPriceRenewal || 0,
          tdsAmount: Number(tdsAmount) || 0
        };

        const pDateStr = paymentDate ? paymentDate.split('T')[0] : new Date().toISOString().split('T')[0];
        let computedStart = startDate;
        let computedEnd = endDate;

        const cycle = order.billingCycle || 'yearly';

        if (!computedStart || !computedEnd) {
          const baseStr = (order.endDate || order.startDate || "").split('T')[0];
          
          if (cycle === 'monthly') {
            const sObj = new Date(baseStr || pDateStr);
            const eObj = new Date(sObj);
            eObj.setMonth(eObj.getMonth() + 1);
            
            computedStart = sObj.toISOString().split('T')[0];
            computedEnd = eObj.toISOString().split('T')[0];
          } else {
            if (baseStr && baseStr.includes('-')) {
              const parts = baseStr.split('-');
              if (parts.length === 3 && parts[0].length === 4) {
                const baseYear = parseInt(parts[0], 10);
                const startYear = order.endDate ? baseYear : baseYear;
                const endYear = startYear + numYears;
                computedStart = `${startYear}-${parts[1]}-${parts[2]}`;
                computedEnd = `${endYear}-${parts[1]}-${parts[2]}`;
              } else {
                computedStart = baseStr;
                const sObj = new Date(computedStart);
                sObj.setFullYear(sObj.getFullYear() + numYears);
                computedEnd = sObj.toISOString().split('T')[0];
              }
            } else {
              const sObj = new Date(pDateStr);
              const eObj = new Date(sObj);
              eObj.setFullYear(eObj.getFullYear() + numYears);
              computedStart = pDateStr;
              computedEnd = eObj.toISOString().split('T')[0];
            }
          }
        }
        order.startDate = computedStart;
        order.endDate = computedEnd;

        newPayment.startDate = computedStart;
        newPayment.endDate = computedEnd;

        if (order.products && Array.isArray(order.products)) {
          order.products.forEach(p => {
            p.startDate = computedStart;
            p.endDate = computedEnd;
          });
        }

        if (!order.payments) order.payments = [];
        order.payments.push(newPayment);

        const totalPaid = order.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        if (stageVal === 'advance' || stageVal === 'mid') {
          order.paymentStatus = totalPaid >= (order.totalPrice || 0) ? "Fully Paid" : "Partially Paid";
        } else if (stageVal === 'final') {
          order.paymentStatus = "Fully Paid";
        } else {
          if (totalPaid >= (order.totalPrice || 0)) {
            order.paymentStatus = "Fully Paid";
          } else {
            order.paymentStatus = "Partially Paid";
          }
        }

        updatedCount++;
      }
    });

    if (updatedCount === 0) {
      return res.status(404).json({ message: "No matching orders found for payment update" });
    }

    await customer.save();

    // Automatic email trigger
    try {
      const PaymentConfirmationSetting = require('../models/PaymentConfirmationSetting');
      const settings = await PaymentConfirmationSetting.findOne();
      if (!settings || settings.sendPaymentConfirmationEmail !== false) {
        const { sendPaymentEmailHelper } = require('./paymentConfirmationController');
        for (const order of customer.orders) {
          if (targetIds.includes(order._id.toString())) {
            const payment = order.payments[order.payments.length - 1];
            await sendPaymentEmailHelper(customer, order, payment);
          }
        }
      }
    } catch (emailErr) {
      console.error("Failed to send auto payment confirmation email on recordPayment:", emailErr.message);
    }

    // Synchronize invoiceDate for any existing Invoice associated with these target orders
    if (paymentDate && targetIds.length > 0) {
      try {
        const Invoice = require('../models/Invoice');
        const existingInvoices = await Invoice.find({
          $or: [
            { orderId: { $in: targetIds } },
            { orderIds: { $in: targetIds } }
          ]
        });

        for (const inv of existingInvoices) {
          const invDateStr = inv.invoiceDate ? inv.invoiceDate.split("T")[0] : "";
          const payDateStr = paymentDate.split("T")[0];
          if (invDateStr !== payDateStr) {
            inv.invoiceDate = paymentDate;
            await inv.save();
          }
        }
      } catch (invErr) {
        console.error("Error syncing invoice date on recordPayment:", invErr);
      }
    }

    const summaryOrders = customer.orders.filter(o => targetIds.includes(o._id.toString())).map(o => {
      const totPaid = (o.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      const latestPay = o.payments && o.payments.length > 0 ? o.payments[o.payments.length - 1] : null;
      return {
        orderId: o._id,
        paymentStatus: o.paymentStatus,
        totalPrice: o.totalPrice,
        totalPaid: totPaid,
        balanceDue: Math.max(0, (o.totalPrice || 0) - totPaid),
        latestPayment: latestPay
      };
    });

    res.status(200).json({
      message: `Payment recorded successfully for ${updatedCount} order(s)`,
      customer,
      paymentSummary: summaryOrders
    });
  } catch (error) {
    console.error("Error recording payment:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getReminders,
  exportRemindersExcel,
  importCustomers,
  exportCustomers,
  deleteOrder,
  downloadSampleExcel,
  sendReminderEmail,
  emailInvoice,
  getMailHistory,
  getReportAnalytics,
  exportReportExcel,
  recordPayment
};

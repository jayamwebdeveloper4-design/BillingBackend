const puppeteer = require('puppeteer');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const GstSetting = require('../models/GstSetting');
const { generateInvoiceHtml } = require('../templates/invoiceTemplate');

const extractId = (val) => {
  if (!val) return '';
  if (typeof val === 'object') {
    if (val._id) return val._id.toString();
    if (val.id) return val.id.toString();
    return val.toString();
  }
  return String(val);
};

const getFirstName = (str) => {
  if (!str) return "";
  return str.split(";")[0].trim();
};

// Helper to fetch GST settings from DB
const getGstSettingsData = async () => {
  let settings = await GstSetting.findOne();
  if (!settings) {
    settings = {
      companyName: '',
      address: '',
      phone: '',
      email: '',
      gstin: '',
      cgstPercentage: 9,
      sgstPercentage: 9,
      igstPercentage: 18,
      signatureImage: ''
    };
  }
  return settings;
};

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

const capitalizeWords = (str) => {
  if (!str) return '';
  return str.replace(/\b[a-z]/g, (char) => char.toUpperCase());
};

const formatProductNames = (input) => {
  let names = [];
  if (Array.isArray(input)) {
    const flat = [];
    input.forEach(item => {
      if (typeof item === 'string') {
        item.split(/[,&]/).forEach(s => flat.push(s.trim()));
      } else if (item) {
        flat.push(item);
      }
    });
    names = flat.filter(Boolean);
  } else if (typeof input === 'string') {
    names = input.split(/[,&]/).map(s => s.trim()).filter(Boolean);
  }
  names = names.map(capitalizeWords);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  const firstParts = names.slice(0, -1).join(', ');
  const lastPart = names[names.length - 1];
  return `${firstParts} & ${lastPart}`;
};

// Helper to auto-generate invoice line item description from product name, domain and order dates
const buildAutoDescription = (prodName, domainUrl, startDate, endDate, years, hasValidation = true) => {
  const fmt = (d) => {
    if (!d) return null;
    const iso = new Date(d);
    if (!isNaN(iso.getTime())) {
      const day = String(iso.getDate()).padStart(2, '0');
      const month = String(iso.getMonth() + 1).padStart(2, '0');
      const year = iso.getFullYear();
      return `${day}.${month}.${year}`;
    }
    return d;
  };
  const start = fmt(startDate);
  const end = fmt(endDate);
  const numYears = Number(years) || 1;
  const yearText = numYears === 1 ? 'for 1 year' : `for ${numYears} years`;

  let formattedDom = domainUrl ? domainUrl.trim().replace(/^https?:\/\//i, '') : '';
  if (formattedDom && formattedDom.includes('.') && !formattedDom.toLowerCase().startsWith('www.')) {
    formattedDom = 'www.' + formattedDom;
  }

  const cleanProd = formatProductNames(prodName);
  let baseTitle = cleanProd || '';

  if (hasValidation) {
    if (baseTitle && !/^renewal/i.test(baseTitle)) {
      baseTitle = `Renewal of ${baseTitle}`;
    } else if (!baseTitle && formattedDom) {
      baseTitle = `Renewal of ${formattedDom}`;
    }
  } else {
    baseTitle = baseTitle.replace(/^renewal of\s+/i, '');
    if (!baseTitle && formattedDom) {
      baseTitle = formattedDom;
    }
  }

  const parts = [];
  if (formattedDom && baseTitle !== `Renewal of ${formattedDom}` && baseTitle !== formattedDom) {
    parts.push(`for ${formattedDom}`);
  }

  if (hasValidation) {
    if (start && end) {
      parts.push(`${yearText} from ${start} to ${end}`);
    } else if (start) {
      parts.push(`${yearText} starting ${start}`);
    }
  }

  return parts.length ? `${baseTitle} ${parts.join(' ')}` : baseTitle;
};

// Helper to calculate totals based on items and GST settings
const calculateTotals = (items, withGst, customerState, settings) => {
  let totalAmount = 0;
  items.forEach(item => {
    totalAmount += (item.price || 0);
  });

  const isTamilNadu = customerState === 'Tamil Nadu';
  const cgstRate = settings.cgstPercentage || 9;
  const sgstRate = settings.sgstPercentage || 9;
  const igstRate = settings.igstPercentage || 18;

  let taxableValue = totalAmount;
  let finalTotal = totalAmount;
  let taxAmount = 0;

  if (withGst) {
    if (isTamilNadu) {
      const cgstAmt = Math.round((taxableValue * cgstRate) / 100);
      const sgstAmt = Math.round((taxableValue * sgstRate) / 100);
      taxAmount = cgstAmt + sgstAmt;
    } else {
      taxAmount = Math.round((taxableValue * igstRate) / 100);
    }
    finalTotal = taxableValue + taxAmount;
  }

  return { totalAmount, taxAmount, finalTotal };
};

// Builds monthYear string from a date input, e.g. "07-2026"
const getMonthYear = (dateInput) => {
  const dateObj = new Date(dateInput);
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const year = dateObj.getFullYear();
  return `${month}-${year}`;
};

// Extracts the "MM-YYYY" portion out of an existing invoiceNo, based on its type.
const extractMonthYearFromInvoiceNo = (invoiceNo, invoiceType) => {
  const parts = invoiceNo.split('-');
  if (invoiceType === 'withGST') {
    return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : '';
  }
  return parts.length >= 4 ? `${parts[2]}-${parts[3]}` : '';
};

// Increments and returns a brand-new invoice number based on the Invoice collection directly.
const generateInvoiceNumber = async (invoiceType, dateInput) => {
  const monthYear = getMonthYear(dateInput);

  const invoices = await Invoice.find({ invoiceType });

  let maxSeq = 0;
  for (const inv of invoices) {
    if (!inv.invoiceNo) continue;
    let seq = 0;
    if (invoiceType === 'withGST') {
      const match = inv.invoiceNo.match(/^JT(\d+)/i);
      if (match) {
        seq = parseInt(match[1], 10);
      }
    } else {
      const match = inv.invoiceNo.match(/^(\d+)/);
      if (match) {
        seq = parseInt(match[1], 10);
      }
    }
    if (seq > maxSeq) {
      maxSeq = seq;
    }
  }

  let nextSeq = maxSeq + 1;
  let invoiceNo;
  let exists = true;

  while (exists) {
    if (invoiceType === 'withGST') {
      const seqStr = String(nextSeq).padStart(3, '0');
      invoiceNo = `JT${seqStr}-${monthYear}`;
    } else {
      const seqStr = String(nextSeq).padStart(4, '0');
      invoiceNo = `${seqStr}-JWS-${monthYear}`;
    }

    const existingDoc = await Invoice.findOne({ invoiceNo });
    if (!existingDoc) {
      exists = false;
    } else {
      nextSeq++;
    }
  }

  return { invoiceNo, monthYear };
};

// @desc    Get next invoice number for preview
// @route   GET /api/invoices/next-number
// @access  Private
const getNextInvoiceNumber = async (req, res) => {
  try {
    const { invoiceType, invoiceDate } = req.query;
    if (!invoiceType) {
      return res.status(400).json({ message: 'Missing invoiceType' });
    }
    const { invoiceNo } = await generateInvoiceNumber(invoiceType, invoiceDate || new Date());
    res.json({ invoiceNo });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Generate invoice PDF and stream it to client
// @route   POST /api/invoices/generate
// @access  Private
const generateInvoice = async (req, res) => {
  try {
    const {
      orderId,
      customerId,
      invoiceType,
      invoiceDate,
      selectedOrderIds,
      paymentData,
      customInvoiceNo,
      invoiceNo: bodyInvoiceNo,
      paymentStatus,
      isProforma,
      selectedCompanyName,
      selectedAddress,
      tdsAmount,
      invoiceCategory,
      paymentStage,
      stageNumber,
      paymentId,
      includePaymentHistory
    } = req.body;

    if (!orderId || !customerId || !invoiceType || !invoiceDate) {
      return res.status(400).json({ message: 'Missing required fields: orderId, customerId, invoiceType, invoiceDate' });
    }

    const normCustomerId = extractId(customerId);
    const normOrderId = extractId(orderId);

    const customer = await Customer.findById(normCustomerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const requestedInvoiceNo = (customInvoiceNo || bodyInvoiceNo || "").trim();
    const statusToSet = paymentStatus === 'Payable' ? 'Payable' : 'Paid';

    // Determine effective stage and category
    const effStage = paymentStage || paymentData?.paymentStage || 'full';
    const effStageNum = Number(stageNumber || paymentData?.stageNumber || 1);
    const isStageInstallment = effStage === 'advance' || effStage === 'mid';
    const isStageFinal = effStage === 'final';
    const effCategory = invoiceCategory || (isStageInstallment ? 'installment' : (isStageFinal ? 'consolidated' : 'regular'));
    const effPaymentId = paymentId || paymentData?.paymentId || paymentData?._id;

    let invoice = null;
    let isExistingInvoice = false;

    if (requestedInvoiceNo) {
      const dupCheck = await Invoice.findOne({ invoiceNo: requestedInvoiceNo });
      if (dupCheck) {
        const dupCustId = extractId(dupCheck.customerId);
        if (dupCustId === normCustomerId) {
          invoice = dupCheck;
          if (invoice.invoiceType === invoiceType) {
            isExistingInvoice = true;
          }
        } else {
          return res.status(400).json({
            message: `Invoice number "${requestedInvoiceNo}" is already in use by another invoice. Please enter a different invoice number.`
          });
        }
      }
    }

    const combinedProducts = [];
    const domainUrlsList = [];
    let subtotal = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    let totalPrice = 0;
    let combinedDomainUrl = invoice ? (invoice.domainUrl || "") : "";
    let targetOrderIds = [];

    const settings = await getGstSettingsData();

    if (!isExistingInvoice) {
      if (Array.isArray(selectedOrderIds) && selectedOrderIds.length > 0) {
        targetOrderIds = selectedOrderIds.map(extractId);
      } else if (paymentData && paymentData.selectedOrderIds && Array.isArray(paymentData.selectedOrderIds) && paymentData.selectedOrderIds.length > 0) {
        targetOrderIds = paymentData.selectedOrderIds.map(extractId);
      } else if (normOrderId) {
        targetOrderIds = [normOrderId];
      }

      let targetOrders = [];
      targetOrderIds.forEach(idStr => {
        const matchedOrder = customer.orders.find(o => extractId(o._id) === idStr);
        if (matchedOrder) {
          targetOrders.push(matchedOrder);
        } else {
          const idx = parseInt(idStr, 10);
          if (!isNaN(idx) && customer.orders[idx]) {
            targetOrders.push(customer.orders[idx]);
          }
        }
      });

      if (targetOrders.length === 0 && normOrderId) {
        const singleOrder = customer.orders.id(normOrderId);
        if (singleOrder) targetOrders = [singleOrder];
      }

      if (targetOrders.length === 0) {
        return res.status(404).json({ message: 'Order(s) not found' });
      }

      targetOrders.forEach(o => {
        if (o.domainUrl && !domainUrlsList.includes(o.domainUrl)) {
          domainUrlsList.push(o.domainUrl);
        }

        let orderPrice = 0;
        if (paymentData && paymentData.amount !== undefined && paymentData.amount !== null && Number(paymentData.amount) > 0) {
          let rawAmount = Number(paymentData.amount);

          if (targetOrders.length === 1) {
            orderPrice = rawAmount;
          } else {
            const totalOrderBase = targetOrders.reduce((sum, ord) => sum + (ord.totalPrice || 0), 0);
            if (totalOrderBase > 0) {
              orderPrice = Math.round(((o.totalPrice || 0) / totalOrderBase) * rawAmount);
            } else {
              orderPrice = Math.round(rawAmount / targetOrders.length);
            }
          }
        } else if (o.products && o.products.length > 0) {
          const activeProds = o.products.filter(p => !p.deactive);
          orderPrice = activeProds.reduce((sum, p) => {
            return sum + (p.renewalSelling !== undefined && p.renewalSelling !== null ? p.renewalSelling : (p.price || 0)) * (p.quantity || 1);
          }, 0);
        } else {
          orderPrice = o.sellerPriceRenewal !== null && o.sellerPriceRenewal !== undefined ? o.sellerPriceRenewal : (o.price || 0);
        }

        let prodName = "";
        if (o.products && o.products.length > 0) {
          const activeProds = o.products.filter(p => !p.deactive);
          const prodNames = activeProds.length > 0 ? activeProds.map(p => p.product || 'Service') : o.products.map(p => p.product || 'Service');
          prodName = formatProductNames(prodNames);
        } else {
          prodName = formatProductNames(o.productName || "Service");
        }

        const hasValidation = o.products && o.products.length > 0
          ? o.products.some(p => !p.deactive && p.validationEnabled !== false)
          : true;

        const effStartDate = paymentData?.startDate || o.startDate || (invoiceDate ? invoiceDate.split('T')[0] : "");
        let numYears = Number(paymentData?.years) || 1;
        if (!paymentData?.years && o.startDate && o.endDate) {
          const sY = new Date(o.startDate).getFullYear();
          const eY = new Date(o.endDate).getFullYear();
          if (!isNaN(sY) && !isNaN(eY) && eY > sY) numYears = eY - sY;
        }
        const sObj = new Date(effStartDate);
        const eObj = new Date(sObj);
        eObj.setFullYear(eObj.getFullYear() + numYears);
        const effEndDate = eObj.toISOString().split('T')[0];

        let autoDesc = buildAutoDescription(
          prodName,
          o.domainUrl,
          effStartDate,
          effEndDate,
          numYears,
          hasValidation
        );

        // Prepend Stage indicator to line item if this is an installment invoice
        if (effStage === 'advance') {
          autoDesc = `Advance Payment: ${autoDesc}`;
        } else if (effStage === 'mid') {
          autoDesc = `Part Payment (#${effStageNum}): ${autoDesc}`;
        } else if (effStage === 'final') {
          autoDesc = `Final Settlement: ${autoDesc}`;
        }

        if (paymentData && paymentData.description && paymentData.description.trim()) {
          const descTrimmed = paymentData.description.trim();
          if (!autoDesc.toLowerCase().includes(descTrimmed.toLowerCase())) {
            autoDesc = `${autoDesc} (${descTrimmed})`;
          }
        }

        combinedProducts.push({
          orderId: o._id,
          quantity: 1,
          domainName: o.domainUrl || "",
          price: orderPrice,
          description: autoDesc
        });
      });

      combinedDomainUrl = domainUrlsList.join(', ');

      const withGst = invoiceType === 'withGST';

      const { totalAmount, taxAmount, finalTotal } = calculateTotals(
        combinedProducts, withGst, customer.state, settings
      );

      subtotal = totalAmount;
      if (withGst) {
        if (customer.state === 'Tamil Nadu') {
          const cgstRate = settings.cgstPercentage || 9;
          const sgstRate = settings.sgstPercentage || 9;
          cgst = Math.round((subtotal * cgstRate) / 100);
          sgst = Math.round((subtotal * sgstRate) / 100);
        } else {
          const igstRate = settings.igstPercentage || 18;
          igst = Math.round((subtotal * igstRate) / 100);
        }
      }
      totalPrice = finalTotal;
    } 
    
    else {
      subtotal = invoice.subtotal;
      cgst = invoice.cgst;
      sgst = invoice.sgst;
      igst = invoice.igst;
      totalPrice = invoice.totalPrice;
      combinedDomainUrl = invoice.domainUrl || (invoice.items && invoice.items.length > 0 ? Array.from(new Set(invoice.items.map(item => item.domainName).filter(Boolean))).join(', ') : "");
    }

    // TDS CALCULATION
    const parsedTdsAmount = Number(
      paymentData?.tdsAmount ?? tdsAmount
    ) || 0;

    const finalTdsAmount = parsedTdsAmount > 0
      ? Math.min(
          parsedTdsAmount,
          Number(totalPrice) || 0
        )
      : 0;

    const netAmountReceived = Math.max(
      0,
      (Number(totalPrice) || 0) - finalTdsAmount
    );

    // Build Payment History for Consolidated Invoices, Milestones, or when multiple payments exist
    const effPaymentHistory = [];
    let historicalTotalPaid = 0;
    let targetOrdersRef = [];

    if (isExistingInvoice && (!targetOrderIds || targetOrderIds.length === 0)) {
      if (Array.isArray(invoice?.orderIds) && invoice.orderIds.length > 0) {
        targetOrderIds = invoice.orderIds.map(extractId);
      } else if (invoice?.orderId) {
        targetOrderIds = [extractId(invoice.orderId)];
      }
    }

    if (targetOrderIds && targetOrderIds.length > 0) {
      targetOrdersRef = customer.orders.filter(o => targetOrderIds.includes(extractId(o._id)));
    } else if (normOrderId) {
      const so = customer.orders.id(normOrderId);
      if (so) targetOrdersRef = [so];
    } else if (invoice?.orderId) {
      const so = customer.orders.id(extractId(invoice.orderId));
      if (so) targetOrdersRef = [so];
    }

    const hasMultiplePayments = targetOrdersRef.some(o => (o.payments || []).length > 1);
    const hasMilestonePayments = targetOrdersRef.some(o => (o.payments || []).some(p => ['advance', 'mid', 'final'].includes(p.paymentStage)));
    const shouldIncludeHistory = effCategory === 'consolidated' || isStageFinal || includePaymentHistory || hasMultiplePayments || hasMilestonePayments;

    if (shouldIncludeHistory) {
      targetOrdersRef.forEach(o => {
        (o.payments || []).forEach(p => {
          const pAmt = Number(p.amount) || 0;
          historicalTotalPaid += pAmt;
          effPaymentHistory.push({
            stage: p.paymentStage || 'full',
            stageNumber: p.stageNumber || 1,
            date: p.date ? p.date.split('T')[0] : '',
            amount: pAmt,
            invoiceNo: p.invoiceNo || '',
            description: p.description || ''
          });
        });
      });
    }

    const effBalanceDue = Math.max(0, (Number(totalPrice) || 0) - historicalTotalPaid);

    if (!invoice) {
      let finalInvoiceNo = requestedInvoiceNo;
      if (!finalInvoiceNo) {
        const { invoiceNo } = await generateInvoiceNumber(invoiceType, invoiceDate);
        finalInvoiceNo = invoiceNo;
      }

      invoice = new Invoice({
        orderId: normOrderId,
        orderIds: targetOrderIds && targetOrderIds.length > 0 ? targetOrderIds : [normOrderId],
        paymentId: effPaymentId,
        invoiceCategory: effCategory,
        paymentStage: effStage,
        stageNumber: effStageNum,
        paymentHistory: effPaymentHistory,
        totalOrderAmount: totalPrice,
        totalPaidPreviously: historicalTotalPaid,
        balanceDue: effBalanceDue,
        invoiceNo: finalInvoiceNo,
        invoiceType,
        invoiceDate,
        customerId: normCustomerId,
        customerName: getFirstName(selectedCompanyName || customer.name),
        items: combinedProducts,
        subtotal,
        cgst,
        sgst,
        igst,
        totalPrice,
        tdsAmount: finalTdsAmount,
        netAmountReceived,
        priceinword: numberToWords(Math.round(totalPrice)),
        paymentStatus: statusToSet
      });

      await invoice.save();
    } else if (!isExistingInvoice) {
      let updated = false;

      if (targetOrderIds && targetOrderIds.length > 0) {
        invoice.orderIds = targetOrderIds;
        updated = true;
      }

      if (requestedInvoiceNo && requestedInvoiceNo !== invoice.invoiceNo) {
        invoice.invoiceNo = requestedInvoiceNo;
        updated = true;
      }

      if (invoice.paymentStatus !== statusToSet) {
        invoice.paymentStatus = statusToSet;
        updated = true;
      }

      if (Number(invoice.tdsAmount || 0) !== finalTdsAmount) {
        invoice.tdsAmount = finalTdsAmount;
        updated = true;
      }

      if (Number(invoice.netAmountReceived || 0) !== netAmountReceived) {
        invoice.netAmountReceived = netAmountReceived;
        updated = true;
      }

      const expectedCustomerName = getFirstName(selectedCompanyName || customer.name);
      if (invoice.customerName !== expectedCustomerName) {
        invoice.customerName = expectedCustomerName;
        updated = true;
      }

      if (invoiceDate) {
        if (invoice.invoiceDate !== invoiceDate) {
          const oldMonthYear = getMonthYear(invoice.invoiceDate);
          const newMonthYear = getMonthYear(invoiceDate);

          if (oldMonthYear !== newMonthYear && !requestedInvoiceNo) {
            const { invoiceNo: newGeneratedNo } = await generateInvoiceNumber(invoiceType, invoiceDate);
            invoice.invoiceNo = newGeneratedNo;
          }

          invoice.invoiceDate = invoiceDate;
          updated = true;
        }

        invoice.items = combinedProducts;
        updated = true;
      }

      if (invoice.invoiceType !== invoiceType) {
        await Invoice.deleteMany({ orderId, invoiceType, _id: { $ne: invoice._id } });

        if (!requestedInvoiceNo) {
          const { invoiceNo } = await generateInvoiceNumber(invoiceType, invoiceDate);
          invoice.invoiceNo = invoiceNo;
        }
        invoice.invoiceType = invoiceType;
        invoice.invoiceDate = invoiceDate;
        invoice.items = combinedProducts;
        invoice.subtotal = subtotal;
        invoice.cgst = cgst;
        invoice.sgst = sgst;
        invoice.igst = igst;
        invoice.totalPrice = totalPrice;
        invoice.tdsAmount = finalTdsAmount;
        invoice.netAmountReceived = netAmountReceived;
        invoice.priceinword = numberToWords(Math.round(totalPrice));
        updated = true;
      }

      invoice.invoiceCategory = effCategory;
      invoice.paymentStage = effStage;
      invoice.stageNumber = effStageNum;
      invoice.paymentHistory = effPaymentHistory;
      invoice.totalOrderAmount = totalPrice;
      invoice.totalPaidPreviously = historicalTotalPaid;
      invoice.balanceDue = effBalanceDue;
      if (effPaymentId) invoice.paymentId = effPaymentId;
      updated = true;

      if (updated) {
        await invoice.save();
      }
    } else {
      let updated = false;
      if (invoiceDate && invoice.invoiceDate !== invoiceDate) {
        invoice.invoiceDate = invoiceDate;
        updated = true;
      }
      if (invoice.paymentStatus !== statusToSet) {
        invoice.paymentStatus = statusToSet;
        updated = true;
      }
      if (Number(invoice.tdsAmount || 0) !== finalTdsAmount) {
        invoice.tdsAmount = finalTdsAmount;
        updated = true;
      }
      if (Number(invoice.netAmountReceived || 0) !== netAmountReceived) {
        invoice.netAmountReceived = netAmountReceived;
        updated = true;
      }
      const expectedCustomerName = getFirstName(selectedCompanyName || customer.name);
      if (invoice.customerName !== expectedCustomerName) {
        invoice.customerName = expectedCustomerName;
        updated = true;
      }
      if (effPaymentHistory.length > 0) {
        invoice.paymentHistory = effPaymentHistory;
        invoice.invoiceCategory = effCategory;
        invoice.balanceDue = effBalanceDue;
        updated = true;
      }
      if (updated) {
        await invoice.save();
      }
    }

    // Link generated invoice number back to customer.orders.payments if paymentId is given
    if (effPaymentId && customer) {
      let linked = false;
      customer.orders.forEach(ord => {
        (ord.payments || []).forEach(p => {
          if (extractId(p._id) === extractId(effPaymentId)) {
            p.invoiceId = invoice._id;
            p.invoiceNo = invoice.invoiceNo;
            linked = true;
          }
        });
      });
      if (linked) {
        await customer.save();
      }
    }

    // Synchronize payment date and TDS amount across target orders in customer.orders
    if (targetOrderIds && targetOrderIds.length > 0) {
      let customerUpdated = false;
      const targetDateStr = invoice.invoiceDate ? invoice.invoiceDate.split("T")[0] : "";

      customer.orders.forEach(order => {
        const orderIdStr = extractId(order._id);
        if (targetOrderIds.includes(orderIdStr)) {
          if (order.payments && order.payments.length > 0) {
            order.payments.forEach(p => {
              if (targetDateStr) {
                const formattedPaymentDate = p.date ? p.date.split("T")[0] : "";
                if (formattedPaymentDate !== targetDateStr) {
                  p.date = invoice.invoiceDate;
                  customerUpdated = true;
                }
              }
              if (finalTdsAmount !== undefined && p.tdsAmount !== finalTdsAmount) {
                p.tdsAmount = finalTdsAmount;
                customerUpdated = true;
              }
            });
          }
        }
      });
      if (customerUpdated) {
        await customer.save();
      }
    }

    const invoiceData = {
      invoiceNo: isProforma ? (customInvoiceNo || 'PROFORMA') : invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate,
      paymentStatus: invoice.paymentStatus || statusToSet,
      customerName: getFirstName(
        invoice.customerName || selectedCompanyName || customer.name
      ),
      customerAddress: getFirstName(
        selectedAddress || customer.address
      ),
      customerState: customer.state,
      customerGstin: customer.gstin,
      domainUrl: combinedDomainUrl,
      items: invoice.items,
      totalAmount: invoice.subtotal,
      withGst: invoice.invoiceType === 'withGST',
      tdsAmount: invoice.tdsAmount || 0,
      netAmountReceived: invoice.netAmountReceived ?? invoice.totalPrice,
      isProforma: !!isProforma,
      invoiceCategory: invoice.invoiceCategory || effCategory,
      paymentStage: invoice.paymentStage || effStage,
      stageNumber: invoice.stageNumber || effStageNum,
      paymentHistory: effPaymentHistory.length > 0 ? effPaymentHistory : (invoice.paymentHistory && invoice.paymentHistory.length > 0 ? invoice.paymentHistory : []),
      totalOrderAmount: invoice.totalOrderAmount || totalPrice,
      totalPaidPreviously: invoice.totalPaidPreviously || historicalTotalPaid,
      balanceDue: invoice.balanceDue !== undefined ? invoice.balanceDue : effBalanceDue
    };

    const html = generateInvoiceHtml(invoiceData, settings);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
    await browser.close();

    const cleanCompany = getFirstName(customer.name || "Customer").replace(/[\s\/\\]+/g, "");
    const generatedFilename = invoice.invoiceType === 'withGST'
      ? (invoice.invoiceNo ? `TAX-Invoice-${cleanCompany}-${invoice.invoiceNo}.pdf` : `TAX-Invoice-${cleanCompany}.pdf`)
      : (invoice.invoiceNo ? `${cleanCompany.toLowerCase()}-${invoice.invoiceNo}.pdf` : `${cleanCompany.toLowerCase()}.pdf`);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${generatedFilename}"`,
      'Content-Length': pdfBuffer.length
    });

    res.send(pdfBuffer);
  } catch (error) {
    console.error('Invoice Generation Error:', error);
    if (error.code === 11000 || (error.message && error.message.includes('E11000'))) {
      const match = error.message.match(/dup key:\s*\{\s*invoiceNo:\s*["']?([^"'\s}]+)/i) || error.message.match(/invoiceNo:\s*["']?([^"'\s}]+)/i);
      const dupNo = match ? match[1] : requestedInvoiceNo || '';
      return res.status(400).json({
        message: dupNo
          ? `Invoice number "${dupNo}" is already in use. Please enter a different invoice number.`
          : `This invoice number is already in use. Please enter a different invoice number.`
      });
    }
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all invoices
// @route   GET /api/invoices
// @access  Private
const getInvoices = async (req, res) => {
  try {
    const { customerId } = req.query;
    const filter = {};
    if (customerId) {
      filter.customerId = customerId;
    }
    const invoices = await Invoice.find(filter)
      .populate('customerId', 'name companyName email phone gstin state address')
      .sort({ invoiceDate: -1, createdAt: -1 });
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Verify if invoice number already exists
// @route   GET /api/invoices/verify-number
// @access  Private
const verifyInvoiceNumber = async (req, res) => {
  try {
    const { invoiceNo, orderId, customerId, currentInvoiceId } = req.query;
    if (!invoiceNo) {
      return res.status(400).json({ message: 'Invoice number is required' });
    }
    const existing = await Invoice.findOne({ invoiceNo: invoiceNo.trim() });
    if (existing) {
      const existingCustId = extractId(existing.customerId);
      const existingOrderId = extractId(existing.orderId);
      const existingOrderIds = existing.orderIds ? existing.orderIds.map(extractId) : [];

      if (currentInvoiceId && extractId(existing._id) === extractId(currentInvoiceId)) {
        return res.json({ exists: false });
      }

      if (orderId) {
        const normOrdId = extractId(orderId);
        if (existingOrderId === normOrdId || existingOrderIds.includes(normOrdId)) {
          return res.json({ exists: false });
        }
      }

      if (customerId && existingCustId === extractId(customerId) && !orderId) {
        return res.json({ exists: false });
      }

      return res.json({ exists: true });
    }
    res.json({ exists: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete an invoice
// @route   DELETE /api/invoices/:id
// @access  Private
const deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    await Invoice.findByIdAndDelete(id);
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { generateInvoice, getInvoices, verifyInvoiceNumber, getNextInvoiceNumber, deleteInvoice };

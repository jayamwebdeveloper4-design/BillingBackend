const PaymentConfirmationSetting = require('../models/PaymentConfirmationSetting');
const Customer = require('../models/Customer');
const Template = require('../models/Template');
const sendEmail = require('../utils/sendEmail');

/**
 * Helper to send payment confirmation email and log to mailHistory
 */
const sendPaymentEmailHelper = async (customer, order, payment) => {
  if (!customer.email || (Array.isArray(customer.email) && customer.email.length === 0)) {
    console.log(`[PaymentConfirmation] Customer ${customer.name} has no email configured. Skipped email.`);
    return;
  }

  let dbTemplate = await Template.findOne({ name: 'Payment' });
  let templateSubject = dbTemplate?.subject || "Payment Confirmation – Renewal of [Service Name] – Paid";
  let templateContent = dbTemplate?.content || `Jayam Web Solutions

Thank you for your payment.

We are pleased to confirm that the payment for the renewal of [Service Name] has been successfully received.`;

  const isPartialOrUpdated = order.paymentStatus === "Partially Paid" || payment?.paymentType === "updated";

  let serviceProds = (order.products || []).filter(p => !p.deactive);
  if (isPartialOrUpdated) {
    const noValProds = serviceProds.filter(p => p.validationEnabled === false || !p.validationEnabled);
    if (noValProds.length > 0) {
      serviceProds = noValProds;
    }
  }

  const serviceName = serviceProds.length > 0
    ? serviceProds.map(p => p.productName || p.product).filter(Boolean).join(', ')
    : (order.products && order.products.length > 0 ? order.products.map(p => p.productName || p.product).filter(Boolean).join(', ') : 'Services');

  // Build price values
  const activeProds = (order.products || []).filter(p => p.validationEnabled && !p.deactive);
  let orderPrice = 0;
  if (activeProds.length > 0) {
    activeProds.forEach(p => {
      orderPrice += (p.renewalSelling !== undefined && p.renewalSelling !== null ? p.renewalSelling : (p.price || 0)) * (p.quantity || 1);
    });
  } else {
    orderPrice = order.totalPrice || 0;
  }

  // Number to words helper (inline)
  const numToWords = (num) => {
    if (!num || isNaN(num)) return '';
    num = Math.round(Number(num));
    if (num === 0) return 'Zero Only';
    const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const numStr = num.toString();
    if (numStr.length > 9) return 'Overflow';
    const n = ('000000000' + numStr).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return '';
    const parts = [];
    if (Number(n[1]) !== 0) parts.push(((a[Number(n[1])] || (b[n[1][0]] + ' ' + a[n[1][1]])).trim()) + ' Crore');
    if (Number(n[2]) !== 0) parts.push(((a[Number(n[2])] || (b[n[2][0]] + ' ' + a[n[2][1]])).trim()) + ' Lakh');
    if (Number(n[3]) !== 0) parts.push(((a[Number(n[3])] || (b[n[3][0]] + ' ' + a[n[3][1]])).trim()) + ' Thousand');
    if (Number(n[4]) !== 0) parts.push(((a[Number(n[4])] || (b[n[4][0]] + ' ' + a[n[4][1]])).trim()) + ' Hundred');
    if (Number(n[5]) !== 0) parts.push((a[Number(n[5])] || (b[n[5][0]] + ' ' + a[n[5][1]])).trim());
    if (parts.length === 0) return 'Only';
    if (parts.length === 1) return parts[0] + ' Only';
    const lastPart = parts.pop();
    return parts.join(' ') + ' and ' + lastPart + ' Only';
  };

  const priceWords = numToWords(orderPrice);

  // Domain URL
  const rawDomain = order.domainUrl || '';
  const domUrl = rawDomain.split(',').map(d => {
    let clean = d.trim().replace(/^https?:\/\//i, '');
    if (clean.includes('.') && !clean.toLowerCase().startsWith('www.')) clean = 'www.' + clean;
    return clean;
  }).join(', ');

  // Dates: compute renewal start/end from order.endDate
  const formatRenewalDate = (dateStr) => {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts;
      return `${d}.${m}.${y}`;
    }
    return dateStr;
  };
  const startDate = order.startDate ? formatRenewalDate(order.startDate) : '';
  const endDateFormatted = order.endDate ? formatRenewalDate(order.endDate) : '';

  // Replace tags
  const replaceAll = (text, isSubject = false) => {
    if (!text) return "";
    const subjectServiceName = serviceName.length > 20 ? serviceName.slice(0, 20).trim() + "..." : serviceName;
    const prod = isSubject ? subjectServiceName : serviceName;
    return text
      .replace(/\[Customer Name\]/gi, customer.name || 'Customer')
      .replace(/\[customerName\]/gi, customer.name || 'Customer')
      .replace(/\[Service Name\]/gi, prod)
      .replace(/\[ServiceName\]/gi, prod)
      .replace(/\[product\]/gi, prod)
      .replace(/\[Product\]/gi, prod)
      .replace(/www\.\[domainUrl\]/gi, domUrl)
      .replace(/\[domainUrl\]/gi, domUrl)
      .replace(/www\.www\./gi, 'www.')
      .replace(/\[price\]words/gi, priceWords)
      .replace(/\[priceWords\]/gi, priceWords)
      .replace(/\[price\]/gi, orderPrice ? `${Number(orderPrice).toLocaleString('en-IN')}` : '0')
      .replace(/\[startDate\]/gi, startDate)
      .replace(/\[endDate\]/gi, endDateFormatted)
      .replace(/\[product\s*tables?\]|\[productTable\]|\[product_table\]/gi, serviceName);
  };

  const { paymentConfirmationTemplate } = require('../utils/emailTemplates');
  const subject = replaceAll(templateSubject, true);
  const rawTextContent = replaceAll(templateContent, false);
  const htmlContent = paymentConfirmationTemplate(subject, rawTextContent);

  try {
    await sendEmail({
      email: customer.email,
      subject: subject,
      message: htmlContent,
    });

    // Record successful mail history in Customer
    if (!customer.mailHistory) customer.mailHistory = [];
    customer.mailHistory.push({
      templateType: 'PaymentConfirmation',
      status: 'Sent',
      mode: 'Email',
      orderId: order._id ? order._id.toString() : '',
      sentAt: new Date()
    });

    await customer.save();
    console.log(`[PaymentConfirmation] Sent confirmation email for order ${order._id} to ${customer.name}`);
  } catch (err) {
    console.error(`[PaymentConfirmation] Failed to send email for order ${order._id}:`, err.message);
    throw err;
  }
};

/**
 * GET settings
 */
const getSettings = async (req, res) => {
  try {
    let settings = await PaymentConfirmationSetting.findOne();
    if (!settings) {
      settings = await PaymentConfirmationSetting.create({
        sendPaymentConfirmationEmail: true
      });
    }
    res.json(settings);
  } catch (err) {
    console.error('[PaymentConfirmation] getSettings error:', err);
    res.status(500).json({ message: 'Failed to retrieve payment confirmation settings' });
  }
};

/**
 * POST settings
 */
const saveSettings = async (req, res) => {
  try {
    const { sendPaymentConfirmationEmail } = req.body;
    let settings = await PaymentConfirmationSetting.findOne();
    if (!settings) {
      settings = new PaymentConfirmationSetting();
    }
    if (typeof sendPaymentConfirmationEmail === 'boolean') {
      settings.sendPaymentConfirmationEmail = sendPaymentConfirmationEmail;
    }
    await settings.save();
    res.json(settings);
  } catch (err) {
    console.error('[PaymentConfirmation] saveSettings error:', err);
    res.status(500).json({ message: 'Failed to save payment confirmation settings' });
  }
};

/**
 * POST /api/payment-confirmation/send-manual
 * Send payment confirmation manually
 */
const sendPaymentConfirmationManual = async (req, res) => {
  try {
    const { customerId, orderId, paymentId, subject: customSubject, content: customContent } = req.body;
    if (!customerId || !orderId) {
      return res.status(400).json({ message: 'Customer ID and Order ID are required' });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const order = customer.orders.id(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    let payment = null;
    if (paymentId && order.payments) {
      payment = order.payments.id(paymentId);
    } else if (order.payments && order.payments.length > 0) {
      payment = order.payments[order.payments.length - 1];
    }

    if (customSubject && customContent) {
      const { paymentConfirmationTemplate } = require('../utils/emailTemplates');
      const formattedHtml = paymentConfirmationTemplate(customSubject, customContent);
      await sendEmail({
        email: customer.email,
        subject: customSubject,
        message: formattedHtml,
      });

      // Record successful mail history in Customer
      if (!customer.mailHistory) customer.mailHistory = [];
      customer.mailHistory.push({
        templateType: 'PaymentConfirmation',
        status: 'Sent',
        mode: 'Email',
        orderId: order._id ? order._id.toString() : '',
        sentAt: new Date()
      });

      await customer.save();
    } else {
      await sendPaymentEmailHelper(customer, order, payment);
    }

    res.status(200).json({ message: 'Payment confirmation email sent successfully' });
  } catch (err) {
    console.error('[PaymentConfirmation] sendPaymentConfirmationManual error:', err);
    res.status(500).json({ message: err.message || 'Failed to send payment confirmation email' });
  }
};

module.exports = {
  getSettings,
  saveSettings,
  sendPaymentConfirmationManual,
  sendPaymentEmailHelper
};

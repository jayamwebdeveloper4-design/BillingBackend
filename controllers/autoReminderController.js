const AutoReminderSettings = require('../models/AutoReminderSettings');
const Customer = require('../models/Customer');
const Template = require('../models/Template');
const GstSetting = require('../models/GstSetting');
const { logCron } = require('../utils/logger');

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
const calculateRenewalDates = (endDateRaw) => {
  const endRaw = formatDateDot(endDateRaw);

  const parseDateParts = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const cleanStr = dateStr.trim();
    let day, month, year;
    let separator = '.';

    if (cleanStr.includes('.')) {
      separator = '.';
      const parts = cleanStr.split('.');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          year = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10);
          day = parseInt(parts[2], 10);
        } else {
          day = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10);
          year = parseInt(parts[2], 10);
        }
      }
    } else if (cleanStr.includes('-')) {
      separator = '-';
      const parts = cleanStr.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          year = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10);
          day = parseInt(parts[2], 10);
        } else {
          day = parseInt(parts[0], 10);
          month = parseInt(parts[1], 10);
          year = parseInt(parts[2], 10);
        }
      }
    }

    if (day && month && year && !isNaN(day) && !isNaN(month) && !isNaN(year)) {
      return { day, month, year, separator };
    }
    return null;
  };

  const endParts = parseDateParts(endRaw) || parseDateParts(endDateRaw);

  if (!endParts) {
    return {
      startDate: endRaw,
      endDate: endRaw
    };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const sep = endParts.separator || '.';
  const isDDMM = endRaw.includes('.') || (endRaw.split('-')[0] && endRaw.split('-')[0].length <= 2);

  let renewalStartFormatted = "";
  let renewalEndFormatted = "";

  const nextEndYear = endParts.year + 1;

  if (isDDMM) {
    renewalStartFormatted = `${pad(endParts.day)}${sep}${pad(endParts.month)}${sep}${endParts.year}`;
    renewalEndFormatted = `${pad(endParts.day)}${sep}${pad(endParts.month)}${sep}${nextEndYear}`;
  } else {
    renewalStartFormatted = `${endParts.year}${sep}${pad(endParts.month)}${sep}${pad(endParts.day)}`;
    renewalEndFormatted = `${nextEndYear}${sep}${pad(endParts.month)}${sep}${pad(endParts.day)}`;
  }

  return {
    startDate: renewalStartFormatted,
    endDate: renewalEndFormatted
  };
};

const capitalizeWords = (str) => {
  if (!str) return '';
  return str.replace(/\b[a-z]/g, (char) => char.toUpperCase());
};

// ── Helper: replace template variables ───────────────────────────────────────
const populateTemplate = (text, vars, htmlTable = '', isSubject = false) => {
  if (!text) return '';
  let domUrl = vars.domainUrl || '';
  if (domUrl.includes('.') && !domUrl.toLowerCase().startsWith('www.')) {
    domUrl = 'www.' + domUrl.replace(/^https?:\/\//i, '');
  }

  const rawProd = vars.productName || '';
  const capProd = capitalizeWords(rawProd);
  const boldProd = isSubject ? capProd : `<b>${capProd}</b>`;

  let res = text
    .replace(/\[Customer Name\]/gi, vars.customerName || '')
    .replace(/\[customerName\]/gi, vars.customerName || '')
    .replace(/\[Product\]/gi, boldProd)
    .replace(/\[product\]/gi, boldProd)
    .replace(/www\.\[domainUrl\]/gi, domUrl)
    .replace(/\[domainUrl\]/gi, domUrl)
    .replace(/www\.www\./gi, 'www.')
    .replace(/\[price\]words/gi, vars.priceWords || '')
    .replace(/\[priceWords\]/gi, vars.priceWords || '')
    .replace(/\[price\]/gi, vars.price ? `<b>${Number(vars.price).toLocaleString('en-IN')}</b>` : '<b>0</b>')
    .replace(/\[startDate\]/gi, vars.startDate || '')
    .replace(/\[endDate\]/gi, vars.endDate || '');

  if (htmlTable) {
    res = res.replace(/\[product\s*tables?\]|\[productTable\]|\[product_table\]/gi, htmlTable);
  }

  if (!isSubject && vars.bankText) {
    const bankBlockRegex = /GPAY\s*:\s*[^\n]*[\s\S]*?IFSC Code\s*:\s*[^\r\n]+(?:\r?\n(?:Account Type|MICR CODE|SWIFT CODE)\s*:\s*[^\r\n]+)*/gi;
    if (bankBlockRegex.test(res)) {
      res = res.replace(bankBlockRegex, vars.bankText);
    }
  }

  return res;
};

// ── GET /auto-reminder/settings ───────────────────────────────────────────────
const getSettings = async (req, res) => {
  try {
    let settings = await AutoReminderSettings.findOne();
    if (!settings) {
      settings = await AutoReminderSettings.create({
        enabled: true,
        daysBefore: 7,
        sendExpiredEmail: true,
        sendDeletionEmail: true,
        deletionDaysAfter: 7
      });
    }
    res.json(settings);
  } catch (err) {
    console.error('[AutoReminder] getSettings error:', err);
    res.status(500).json({ message: 'Failed to get auto reminder settings' });
  }
};

// ── POST /auto-reminder/settings ──────────────────────────────────────────────
const saveSettings = async (req, res) => {
  try {
    const { enabled, daysBefore, sendExpiredEmail, sendDeletionEmail, deletionDaysAfter } = req.body;
    let settings = await AutoReminderSettings.findOne();
    if (!settings) {
      settings = new AutoReminderSettings();
    }
    if (typeof enabled === 'boolean') settings.enabled = enabled;
    if (daysBefore !== undefined && !isNaN(Number(daysBefore))) {
      settings.daysBefore = Number(daysBefore);
    }
    if (typeof sendExpiredEmail === 'boolean') settings.sendExpiredEmail = sendExpiredEmail;
    if (typeof sendDeletionEmail === 'boolean') settings.sendDeletionEmail = sendDeletionEmail;
    if (deletionDaysAfter !== undefined && !isNaN(Number(deletionDaysAfter))) {
      settings.deletionDaysAfter = Number(deletionDaysAfter);
    }
    await settings.save();
    res.json(settings);
  } catch (err) {
    console.error('[AutoReminder] saveSettings error:', err);
    res.status(500).json({ message: 'Failed to save auto reminder settings' });
  }
};

// ── Core cron runner — called daily or via POST /auto-reminder/run ────────────
// ── Core cron runner — called daily or via POST /auto-reminder/run ────────────
const runAutoReminderCron = async () => {
  try {
    const settings = await AutoReminderSettings.findOne();
    if (!settings || !settings.enabled) {
      logCron('SKIP', 'Auto reminders are disabled — cron skipped.');
      console.log('[AutoReminder] Cron skipped — auto reminders disabled.');
      return { sent: 0, skipped: 'disabled' };
    }

    const daysBefore = settings.daysBefore || 7;
    const deletionDaysAfter = settings.deletionDaysAfter || 7;

    logCron('START', `Cron started — daysBefore=${daysBefore}, sendExpiredEmail=${settings.sendExpiredEmail}, sendDeletionEmail=${settings.sendDeletionEmail}, deletionDaysAfter=${deletionDaysAfter}`);
    console.log(`[AutoReminder] Cron started — daysBefore=${daysBefore}, sendExpired=${settings.sendExpiredEmail}, sendDeletion=${settings.sendDeletionEmail}, deletionDaysAfter=${deletionDaysAfter}`);

    // Compute date representations
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const toLocalYYYYMMDD = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const todayStr = toLocalYYYYMMDD(today);

    // Load email templates
    const templates = {
      Renewal: {
        subject: 'Renewal of Domain, Hosting for www.[domainUrl]- from JAYAM WEB SOLUTIONS',
        content: `Dear Sir/Ma’am,

Reg. Renewal of [product] for www.[domainUrl]

Kindly make payment [price]/-INR ([priceWords]) for One year from [startDate] to [endDate] & confirm with payment transaction details.

𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗱𝗲𝘁𝗮𝗶𝗹𝘀:

GPAY : 9677876445

Bank Name : Indian bank
Account Number : 722473240
Account Name : Jayam Web Solutions
Branch : West Tambaram-Chennai
IFSC Code : IDIB000T092
Account Type : Current Account

Let us know if there are any queries.
-- 

Thanks & Regards,
Lakshmi.L 
Jayam Web Solutions 
+91 9677 87 6445 / 98405 99789 
www.jayamwebsolutions.com`
      },
      Expired: {
        subject: 'EXPIRED: Renewal of Domain, Hosting for www.[domainUrl] - JAYAM WEB SOLUTIONS',
        content: `Dear Sir/Ma’am,

We would like to inform you that the [product] for www.[domainUrl] have expired.

To avoid any interruption to your website and email services (if applicable), we request you to renew the services at the earliest.

Kindly make payment [price]/-INR ([priceWords]) for One year from [startDate] to [endDate] & confirm with payment transaction details.

𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗱𝗲𝘁𝗮𝗶𝗹𝘀:

GPAY : 9677876445

Bank Name : Indian bank
Account Number : 722473240
Account Name : Jayam Web Solutions
Branch : West Tambaram-Chennai
IFSC Code : IDIB000T092
Account Type : Current Account

Let us know if there are any queries.
-- 

Thanks & Regards,
Lakshmi.L 
Jayam Web Solutions 
+91 9677 87 6445 / 98405 99789 
www.jayamwebsolutions.com`
      },
      Deletion: {
        subject: 'FINAL NOTICE: Service Deletion for www.[domainUrl] - JAYAM WEB SOLUTIONS',
        content: `Dear Sir/Ma’am,

This is a final reminder regarding the renewal of the [product] for www.[domainUrl]

Despite our previous renewal reminders, we have not yet received the renewal payment or any confirmation from your end.

Please note that the expired services have now entered the deletion period. If the renewal is not completed within the permitted time, the domain may be permanently deleted, and the website, emails, and associated data may no longer be recoverable.

Kindly make payment [price]/-INR ([priceWords]) for One year from [startDate] to [endDate] & confirm with payment transaction details.

𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗱𝗲𝘁𝗮𝗶𝗹𝘀:

GPAY : 9677876445

Bank Name : Indian bank
Account Number : 722473240
Account Name : Jayam Web Solutions
Branch : West Tambaram-Chennai
IFSC Code : IDIB000T092
Account Type : Current Account

Let us know if there are any queries.
-- 

Thanks & Regards,
Lakshmi.L 
Jayam Web Solutions 
+91 9677 87 6445 / 98405 99789 
www.jayamwebsolutions.com`
      }
    };

    try {
      const dbTemplates = await Template.find({});
      dbTemplates.forEach(tmpl => {
        if (tmpl.name) {
          let normalizedName = tmpl.name;
          if (tmpl.name.toLowerCase() === 'renewal') normalizedName = 'Renewal';
          else if (tmpl.name.toLowerCase() === 'expired') normalizedName = 'Expired';
          else if (tmpl.name.toLowerCase() === 'deletion') normalizedName = 'Deletion';
          else if (tmpl.name.toLowerCase() === 'reminder') normalizedName = 'Renewal';

          templates[normalizedName] = {
            subject: tmpl.subject || templates[normalizedName].subject,
            content: tmpl.content || templates[normalizedName].content
          };
        }
      });
    } catch (e) {
      console.warn('[AutoReminder] Could not load templates:', e.message);
    }

    const emailQueue = require('../queues/emailQueue');

    const gstSettings = await GstSetting.findOne();

    // Fetch all customers with orders
    const customers = await Customer.find({ "orders.0": { $exists: true } });

    let sentCount = 0;

    for (const customer of customers) {
      const customerGstin = (customer.gstin || customer.gstNumber || "").trim();
      const hasGst = !!customerGstin;
      const bName = hasGst ? (gstSettings?.bankName || 'Canara Bank') : (gstSettings?.bankNameWithoutGst || 'Indian Bank');
      const isIndianBank = bName.toLowerCase().includes('indian');

      let bankText = '';
      if (hasGst) {
        const gpay = gstSettings?.gpayNumber || '9840599789';
        const accNo = gstSettings?.bankAccountNumber || '120035000004';
        const accName = gstSettings?.bankAccountName || 'JAYAM TECHNOLOGIES';
        const branch = gstSettings?.bankBranch || 'Perungalathur';
        const ifsc = gstSettings?.bankIfsc || 'CNRB0003856';
        bankText = `GPAY : ${gpay}\n\nBank Name : ${bName}\nAccount Number : ${accNo}\nAccount Name : ${accName}\nBranch : ${branch}\nIFSC Code : ${ifsc}\nAccount Type : Current Account`;
      } else {
        const gpay = gstSettings?.gpayNumberWithoutGst || '9677876445';
        const accNo = gstSettings?.bankAccountNumberWithoutGst || '722473240';
        const accName = gstSettings?.bankAccountNameWithoutGst || 'Jayam Web Solutions';
        const branch = gstSettings?.bankBranchWithoutGst || 'West Tambaram-Chennai';
        const ifsc = gstSettings?.bankIfscWithoutGst || 'IDIB000T092';
        bankText = `GPAY : ${gpay}\n\nBank Name : ${bName}\nAccount Number : ${accNo}\nAccount Name : ${accName}\nBranch : ${branch}\nIFSC Code : ${ifsc}\nAccount Type : Current Account`;
      }

      for (const order of customer.orders) {
        if (!order.endDate) continue;

        // Calculate date difference
        const endD = new Date(order.endDate);

        // Temporarily skip if renewal is in month 07 (July) and year 2026
        if (!isNaN(endD.getTime())) {
          const renewalYear = endD.getFullYear();
          const renewalMonth = endD.getMonth() + 1; // 1-indexed (July is 7)
          if (renewalYear === 2026 && renewalMonth === 7) {
            continue;
          }
        }
        const startOfToday = new Date(todayStr);
        const startOfEnd = new Date(toLocalYYYYMMDD(endD));

        const msDiff = startOfEnd.getTime() - startOfToday.getTime();
        const daysDiff = Math.ceil(msDiff / (1000 * 60 * 60 * 24)); // > 0 for future, < 0 for past

        let sentType = null;

        // Check Deletion first (most critical/later stage of expiry)
        if (
          settings.sendDeletionEmail &&
          daysDiff < 0 &&
          Math.abs(daysDiff) >= deletionDaysAfter &&
          order.deletionEmailSend !== true &&
          order.expiredEmailSend === true
        ) {
          sentType = 'Deletion';
        }
        // Check Expired second
        else if (
          settings.sendExpiredEmail &&
          daysDiff < 0 &&
          order.expiredEmailSend !== true
        ) {
          sentType = 'Expired';
        }
        // Check Renewal third
        else if (
          daysDiff >= 0 &&
          daysDiff <= daysBefore &&
          order.emailSend !== true
        ) {
          sentType = 'Renewal';
        }

        if (!sentType) continue;

        const activeProducts = order.products?.filter(p => p.validationEnabled && !p.deactive) || [];
        if (activeProducts.length === 0) continue; // Skip since all validationEnabled products are deactive

        const productNames = activeProducts.map(p => capitalizeWords(p.product || p.productName || '')).join(', ');

        let renewalPrice = 0;
        activeProducts.forEach(p => {
          const itemSelling = p.price || 0;
          renewalPrice += (itemSelling * (p.quantity || 1));
        });
        const displayPrice = renewalPrice;

        const renewalDates = calculateRenewalDates(order.endDate);

        const vars = {
          customerName: customer.name,
          productName: productNames,
          domainUrl: order.domainUrl || '',
          price: displayPrice,
          priceWords: numberToWords(Math.round(displayPrice)),
          startDate: renewalDates.startDate,
          endDate: renewalDates.endDate,
          bankText
        };

        const activeTemplate = templates[sentType];
        const subject = populateTemplate(activeTemplate.subject, vars, '', true);

        const cleanDomain = (order.domainUrl || productNames || '').replace(/^https?:\/\//, '');
        const isDomainUrl = cleanDomain.includes('.');
        const displayDomain = isDomainUrl ? `<a href="https://${cleanDomain}" style="color: #004a99; font-weight: 600; text-decoration: underline;">${cleanDomain}</a>` : (order.domainUrl || productNames);

        const orderTableRows = `
        <tr>
          <td style="padding: 8px 12px; border: 1px solid #cbd5e1; text-align: center; font-weight: 500;">1</td>
          <td style="padding: 8px 12px; border: 1px solid #cbd5e1; font-weight: 600;">${displayDomain}</td>
          <td style="padding: 8px 12px; border: 1px solid #cbd5e1; font-weight: 700;"><b>${productNames}</b></td>
          <td style="padding: 8px 12px; border: 1px solid #cbd5e1; font-weight: 500; white-space: nowrap;">${renewalDates.startDate} – ${renewalDates.endDate}</td>
          <td style="padding: 8px 12px; border: 1px solid #cbd5e1; text-align: right; font-weight: 600;">${displayPrice.toLocaleString('en-IN')}/-</td>
        </tr>`;

        const htmlTable = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 650px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 13px; border: 1px solid #cbd5e1; margin: 15px 0;">
      <thead>
        <tr style="background-color: #f1f5f9; text-align: left; color: #1e293b; font-weight: bold;">
          <th style="padding: 10px 12px; border: 1px solid #cbd5e1; text-align: center; width: 50px;">S. No</th>
          <th style="padding: 10px 12px; border: 1px solid #cbd5e1;">Domain Name</th>
          <th style="padding: 10px 12px; border: 1px solid #cbd5e1;">Services</th>
          <th style="padding: 10px 12px; border: 1px solid #cbd5e1;">Period</th>
          <th style="padding: 10px 12px; border: 1px solid #cbd5e1; text-align: right;">Cost per year in INR</th>
        </tr>
      </thead>
      <tbody>
        ${orderTableRows}
        <tr style="font-weight: bold; background-color: #f8fafc; color: #1e293b;">
          <td colspan="4" style="text-align: right; padding: 10px 12px; border: 1px solid #cbd5e1;">Total Amount to be paid</td>
          <td style="padding: 10px 12px; border: 1px solid #cbd5e1; text-align: right; color: #004a99; font-size: 14px;">${displayPrice.toLocaleString('en-IN')}/-</td>
        </tr>
      </tbody>
    </table>`;

        const content = populateTemplate(activeTemplate.content, vars, htmlTable, false);

        try {
          await emailQueue.add(
            "send-reminder-email",
            {
              customerId: customer._id,
              orderId: order._id,
              customerEmail: customer.email,
              subject,
              content,
              sentType
            },
            {
              jobId: `${order._id}-${sentType}-${todayStr}`,
              attempts: 5,
              backoff: {
                type: "exponential",
                delay: 5000
              },
              removeOnComplete: 1000,
              removeOnFail: 100
            }
          );

          sentCount++;
          logCron('QUEUED', `[${sentType}] Email job queued for ${customer.name} <${customer.email}> for order ${order._id} (ends ${order.endDate})`);
          console.log(`[AutoReminder] Queued [${sentType}] for ${customer.name} (${customer.email}) for order ${order._id}`);
        } catch (queueErr) {
          logCron('ERROR', `Failed to queue [${sentType}] job for ${customer.name} <${customer.email}>: ${queueErr.message}`);
          console.error(`[AutoReminder] Failed to queue [${sentType}] for ${customer.email}:`, queueErr.message);
        }
      }
    }

    logCron('DONE', `Cron completed — ${sentCount} reminder(s) sent.`);
    console.log(`[AutoReminder] Cron done — ${sentCount} reminder(s) sent.`);
    return { sent: sentCount };
  } catch (err) {
    logCron('ERROR', `Cron fatal error: ${err.message}`);
    console.error('[AutoReminder] runAutoReminderCron error:', err);
    return { error: err.message };
  }
};

// ── POST /auto-reminder/run — manual trigger ──────────────────────────────────
const triggerCron = async (req, res) => {
  try {
    const result = await runAutoReminderCron();
    res.json({ message: 'Auto reminder cron executed', result });
  } catch (err) {
    res.status(500).json({ message: 'Cron execution failed', error: err.message });
  }
};

module.exports = { getSettings, saveSettings, triggerCron, runAutoReminderCron };

const fs = require('fs');
const path = require('path');

const generateInvoiceHtml = (invoice, settings) => {
  let signatureSrc = settings.signatureImage;
  if (signatureSrc && !signatureSrc.startsWith('data:') && !signatureSrc.startsWith('http')) {
    try {
      let filePath = signatureSrc;
      if (signatureSrc.startsWith('uploads/')) {
        filePath = path.join(__dirname, '..', 'public', signatureSrc);
      } else if (signatureSrc.startsWith('public/uploads/')) {
        filePath = path.join(__dirname, '..', signatureSrc);
      } else {
        filePath = path.join(__dirname, '..', 'public', 'uploads', signatureSrc);
      }

      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml'
        };
        const mimeType = mimeTypes[ext] || 'image/png';
        const fileData = fs.readFileSync(filePath);
        signatureSrc = `data:${mimeType};base64,${fileData.toString('base64')}`;
      }
    } catch (err) {
      console.error('Error reading signature file:', err);
    }
  }

  const BRAND_BLUE = '#4472C4';
  const INVOICE_RED = '#EE0000';

  const isTamilNadu = invoice.customerState === 'Tamil Nadu';
  const cgstRate = settings.cgstPercentage || 9;
  const sgstRate = settings.sgstPercentage || 9;
  const igstRate = settings.igstPercentage || 18;
  const totalGstRate = isTamilNadu ? (cgstRate + sgstRate) : igstRate;

  // Bank account details — selected automatically based on GST type
  const bankAccountName = invoice.withGst
    ? (settings.bankAccountName || "JAYAM TECHNOLOGIES")
    : (settings.bankAccountNameWithoutGst || "Jayam Web Solutions");

  const bankAccountNumber = invoice.withGst
    ? (settings.bankAccountNumber || "120035000004")
    : (settings.bankAccountNumberWithoutGst || "722473240");

  const bankName = invoice.withGst
    ? (settings.bankName || "Canara Bank")
    : (settings.bankNameWithoutGst || "Indian Bank");

  const bankBranch = invoice.withGst
    ? (settings.bankBranch || "Perungalathur")
    : (settings.bankBranchWithoutGst || "Tambaram West, Chennai");

  const bankIfsc = invoice.withGst
    ? (settings.bankIfsc || "CNRB0003856")
    : (settings.bankIfscWithoutGst || "IDIB000T092");

  const gpayNumber = invoice.withGst
    ? (settings.gpayNumber || "9840599789")
    : (settings.gpayNumberWithoutGst || "9677876445");

  // Format date
  const formattedDate = invoice.invoiceDate
    ? new Date(invoice.invoiceDate).toLocaleDateString('en-GB')
    : new Date().toLocaleDateString('en-GB');

  const totalAmount = Number(invoice.totalAmount) || 0;

  let taxableValue = totalAmount;
  let actualTotal = totalAmount;
  let roundedTotal = 0;

  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;

  if (invoice.withGst) {
    if (isTamilNadu) {
      cgstAmount = Math.round((taxableValue * cgstRate) / 100 * 100) / 100;
      sgstAmount = Math.round((taxableValue * sgstRate) / 100 * 100) / 100;
      actualTotal = Number((taxableValue + cgstAmount + sgstAmount).toFixed(2));
    } else {
      igstAmount = Math.round((taxableValue * igstRate) / 100 * 100) / 100;
      actualTotal = Number((taxableValue + igstAmount).toFixed(2));
    }
  } else {
    actualTotal = Number(taxableValue.toFixed(2));
  }

  const integerPart = Math.floor(actualTotal);
  const decimalPart = Number((actualTotal - integerPart).toFixed(2));
  const hasDecimals = decimalPart > 0 && decimalPart < 1;
  let roundOffLabel = "";

  if (hasDecimals) {
    if (decimalPart >= 0.50) {
      roundedTotal = integerPart + 1;
      roundOffLabel = "Total (Rounded-up)";
    } else {
      roundedTotal = integerPart;
      roundOffLabel = "Total (Rounded-off)";
    }
  } else {
    roundedTotal = integerPart;
    roundOffLabel = "";
  }

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

  const tdsAmount = Number(invoice.tdsAmount) || 0;
  const netAmountReceived = tdsAmount > 0
    ? Math.max(0, roundedTotal - tdsAmount)
    : roundedTotal;
  const amountInWords = numberToWords(netAmountReceived);

  const highlightDomainAndDates = (str) => {
    if (!str) return '';
    let result = str;

    if (/^Renewal of\s+/i.test(result)) {
      result = result.replace(
        /^(Renewal of\s+)(.*?)(?=\s+for\s+|$)/i,
        (match, p1, p2) => {
          if (!p2 || p2.includes('<strong') || p2.includes('<b>')) return match;
          return `${p1}<strong style="font-weight: 700;">${p2}</strong>`;
        }
      );
    } else {
      result = result.replace(
        /^([a-zA-Z0-9\s&,/\-]+?)(?=\s+for\s+(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,})/i,
        (match, p1) => {
          if (!p1 || p1.includes('<strong') || p1.includes('<b>')) return match;
          return `<strong style="font-weight: 700;">${p1}</strong>`;
        }
      );
    }

    result = result.replace(
      /\b((?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)\b/g,
      (match) => {
        let dom = match.trim().replace(/^https?:\/\//i, '');
        if (dom.includes('.') && !dom.toLowerCase().startsWith('www.')) {
          dom = 'www.' + dom;
        }
        return `<strong style="font-weight: 700;">${dom}</strong>`;
      }
    );

    result = result.replace(
      /\b(\d{2}[\.\/]\d{2}[\.\/]\d{4}|\d{4}-\d{2}-\d{2})\b/g,
      '<strong style="font-weight: 700;">$1</strong>'
    );
    return result;
  };

  let productsHtml = '';
  invoice.items.forEach((p, idx) => {
    const qty = p.qty || p.quantity || 1;
    const amtVal = Number(p.price || p.amount || 0);
    const rateVal = p.rate !== undefined && p.rate !== null ? Number(p.rate) : (amtVal / qty);

    const formattedRate = rateVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formattedAmt = amtVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const rawText = p.description || p.Particulars || p.productName || '';
    const formattedText = highlightDomainAndDates(rawText);
    const mainText = `<span style="font-weight: 400; color: #1e293b;">${formattedText}</span>`;

    productsHtml += `
      <tr>
        <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: center; vertical-align: top; font-weight: normal;">${idx + 1}</td>
        <td style="border: 1px solid #cbd5e1; padding: 8px; vertical-align: top; font-weight: normal;">
          ${mainText}
        </td>
        <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; vertical-align: top; font-weight: normal;">₹ ${formattedRate}</td>
        <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: center; vertical-align: top; font-weight: normal;">${qty}</td>
        <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; vertical-align: top; font-weight: normal;">₹ ${formattedAmt}</td>
      </tr>
    `;
  });

  if (!invoice.withGst && invoice.isProforma) {
    const intPart = Math.floor(actualTotal);
    const decPart = Number((actualTotal - intPart).toFixed(2));
    const hasDec = decPart > 0 && decPart < 1;
    const isRoundUp = decPart >= 0.50;
    const rounded = isRoundUp ? intPart + 1 : intPart;
    const rLabel = isRoundUp ? "Total (Rounded-up)" : "Total (Rounded-off)";

    if (hasDec) {
      productsHtml += `
        <tr>
          <td colspan="4" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
            Total Amount:
          </td>
          <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
            ₹ ${actualTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </td>
        </tr>
        <tr>
          <td colspan="4" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
            ${rLabel}:
          </td>
          <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
            ₹ ${Number(rounded).toLocaleString('en-IN')}
          </td>
        </tr>
      `;
    } else {
      productsHtml += `
        <tr>
          <td colspan="4" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
            Total Amount:
          </td>
          <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
            ₹ ${Number(actualTotal).toLocaleString('en-IN')}
          </td>
        </tr>
      `;
    }
  }

  if (!invoice.withGst && !invoice.isProforma) {
    productsHtml += `
      <tr>
        <td colspan="4" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
          Total Amount:
        </td>
        <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
          ₹ ${actualTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
        </td>
      </tr>
      ${tdsAmount > 0 ? `
      <tr>
        <td colspan="4" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
          Less: TDS Deducted by Customer:
        </td>
        <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
          ₹ ${tdsAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
        </td>
      </tr>
      ` : ''}
      <tr>
        <td colspan="4" style="border: 1px solid #cbd5e1; border-top: 1px dashed #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
          ${tdsAmount > 0 ? 'Net Amount Received:' : 'Amount Received:'}
        </td>
        <td style="border: 1px solid #cbd5e1; border-top: 1px dashed #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
          ₹ ${netAmountReceived.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
        </td>
      </tr>
    `;
  }

  let gstSummaryHtml = '';
  if (invoice.withGst) {
    if (isTamilNadu) {
      gstSummaryHtml = `
        <div style="margin-bottom: 20px;">
          <h4 style="margin: 0 0 8px 0; font-weight: bold;">GST SUMMARY</h4>
          <table style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1;">
            <thead>
              <tr>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">Taxable Value</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">CGST Rate</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">CGST Amount</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">SGST Rate</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">SGST Amount</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${Number(taxableValue).toFixed(2)}</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">${cgstRate}%</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${Number(cgstAmount).toFixed(2)}</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">${sgstRate}%</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${Number(sgstAmount).toFixed(2)}</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${actualTotal.toFixed(2)}</td>
              </tr>
              ${hasDecimals ? `
              <tr>
                <td colspan="5" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">Total Amount:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${actualTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
              <tr>
                <td colspan="5" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">${roundOffLabel}:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${Number(roundedTotal).toLocaleString('en-IN')}</td>
              </tr>
              ` : `
              <tr>
                <td colspan="5" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">Total Amount:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${Number(actualTotal).toLocaleString('en-IN')}</td>
              </tr>
              `}
              <tr>
                <td colspan="5" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
                  ${tdsAmount > 0 ? 'Less: TDS Deducted by Customer:' : 'Amount Received:'}
                </td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
                  ₹ ${tdsAmount > 0 ? tdsAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : netAmountReceived.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </td>
              </tr>
              ${tdsAmount > 0 ? `
              <tr>
                <td colspan="5" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">Net Amount Received:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${netAmountReceived.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</td>
              </tr>
              ` : ''}
            </tbody>
          </table>
        </div>
      `;
    } else {
      gstSummaryHtml = `
        <div style="margin-bottom: 20px;">
          <h4 style="margin: 0 0 8px 0; font-weight: bold;">GST SUMMARY</h4>
          <table style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1;">
            <thead>
              <tr>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">Taxable Value</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">IGST Rate</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">IGST Amount</th>
                <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff;">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${Number(taxableValue).toFixed(2)}</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">${igstRate}%</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${Number(igstAmount).toFixed(2)}</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px;">₹ ${actualTotal.toFixed(2)}</td>
              </tr>
              ${hasDecimals ? `
              <tr>
                <td colspan="3" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">Total Amount:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${actualTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
              <tr>
                <td colspan="3" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">${roundOffLabel}:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${Number(roundedTotal).toLocaleString('en-IN')}</td>
              </tr>
              ` : `
              <tr>
                <td colspan="3" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">Total Amount:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${Number(actualTotal).toLocaleString('en-IN')}</td>
              </tr>
              `}
              <tr>
                <td colspan="3" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
                  ${tdsAmount > 0 ? 'Less: TDS Deducted by Customer:' : 'Amount Received:'}
                </td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">
                  ₹ ${tdsAmount > 0 ? tdsAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : netAmountReceived.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </td>
              </tr>
              ${tdsAmount > 0 ? `
              <tr>
                <td colspan="3" style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">Net Amount Received:</td>
                <td style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; font-weight: bold;">₹ ${netAmountReceived.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</td>
              </tr>
              ` : ''}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // Payment Breakdown & History (for consolidated / milestone invoices)
  let paymentHistoryHtml = '';
  if (invoice.paymentHistory && Array.isArray(invoice.paymentHistory) && invoice.paymentHistory.length > 0) {
    const historyRows = invoice.paymentHistory.map((item, hIdx) => {
      const stageName = item.stage === 'advance' ? 'Advance Payment'
        : item.stage === 'mid' ? `Milestone / Part Payment ${item.stageNumber ? `(#${item.stageNumber})` : ''}`
        : item.stage === 'final' ? 'Final Settlement'
        : (item.stage || 'Payment');
      const dateStr = item.date ? (item.date.includes('-') ? item.date.split('-').reverse().join('.') : item.date) : '—';
      const refStr = item.invoiceNo ? `Invoice: ${item.invoiceNo}` : (item.description || '—');
      const amtVal = Number(item.amount) || 0;
      return `
        <tr>
          <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center; vertical-align: top;">${hIdx + 1}</td>
          <td style="border: 1px solid #cbd5e1; padding: 6px 8px; vertical-align: top; font-weight: 500; color: #1e293b;">${stageName}</td>
          <td style="border: 1px solid #cbd5e1; padding: 6px 8px; vertical-align: top; text-align: center;">${dateStr}</td>
          <td style="border: 1px solid #cbd5e1; padding: 6px 8px; vertical-align: top; color: #475569;">${refStr}</td>
          <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; vertical-align: top; font-weight: 600;">₹ ${amtVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        </tr>
      `;
    }).join('');

    const totalPaidHistorical = invoice.paymentHistory.reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
    const balanceDueVal = invoice.balanceDue !== undefined && invoice.balanceDue !== null ? Number(invoice.balanceDue) : 0;

    paymentHistoryHtml = `
      <div style="margin-top: 15px; margin-bottom: 25px;">
        <h4 style="margin: 0 0 8px 0; font-weight: bold; color: #1e293b; font-size: 13px;">PAYMENT BREAKDOWN & HISTORY</h4>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 11px;">
          <thead>
            <tr style="background-color: #f1f5f9; color: #334155;">
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center; width: 6%;">#</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; width: 30%;">Payment Stage</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center; width: 18%;">Date</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; width: 26%;">Reference / Notes</th>
              <th style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; width: 20%;">Amount Paid</th>
            </tr>
          </thead>
          <tbody>
            ${historyRows}
            <tr style="background-color: #f8fafc; font-weight: bold;">
              <td colspan="4" style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right;">Total Paid Across Installments:</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; color: #15803d;">₹ ${totalPaidHistorical.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr style="background-color: #ffffff; font-weight: bold;">
              <td colspan="4" style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right;">Balance Remaining Due:</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; color: ${balanceDueVal > 0 ? '#b91c1c' : '#15803d'};">₹ ${balanceDueVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Invoice</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap" rel="stylesheet">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap');
        body {
          margin: 0;
          padding: 0;
          font-family: 'Roboto', 'Segoe UI', Arial, sans-serif;
        }
        * {
          box-sizing: border-box;
        }
      </style>
    </head>
    <body>
      <div style="width: 100%; min-height: 1050px; padding: 40px 30px; background-color: #fff; color: #000; font-family: 'Roboto', 'Segoe UI', Arial, sans-serif; font-size: 12px; position: relative; box-sizing: border-box;">
        <!-- Header -->
        <div style="text-align: center; margin-bottom: 4px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: bold;">${invoice.withGst ? settings.companyName : (settings.companyNameWithoutGst || settings.companyName)}</h2>
          <p style="margin: 4px 0; font-size: 12px; white-space: pre-wrap;">${invoice.withGst ? settings.address : (settings.addressWithoutGst || settings.address)}</p>
          <p style="margin: 4px 0; font-size: 12px;">Email: ${invoice.withGst ? settings.email : (settings.emailWithoutGst || settings.email)}, Phone: ${invoice.withGst ? settings.phone : (settings.phoneWithoutGst || settings.phone)}</p>
          <h3 style="margin: 8px 0 0; color: ${INVOICE_RED}; font-size: 14px; font-weight: bold;">${invoice.isProforma ? 'PROFORMA INVOICE' : (invoice.withGst ? "TAX INVOICE" : "INVOICE")}</h3>
          <hr style="border: 0; border-top: 2px solid ${BRAND_BLUE}; margin: 12px 0 10px;" />
        </div>

        <!-- Bill To & Invoice Info -->
        <table style="width: 100%; margin-top: 25px; margin-bottom: 30px; border-collapse: collapse; table-layout: fixed;">
          <tbody>
            <tr>
              <!-- Left Side: Bill To -->
              <td style="width: 52%; vertical-align: top; padding-right: 15px;">
                <h4 style="margin: 0 0 6px 0; text-decoration: underline; font-weight: bold;">Bill To</h4>
                <div style="">
                  <p style="margin: 0 0 4px 0; font-weight: bold; font-size: 13px;">${invoice.customerName}</p>
                  <p style="margin: 0 0 4px 0; white-space: pre-wrap; line-height: 1.5; color: #334155;">${invoice.customerAddress || ''}</p>
                  ${(invoice.customerGstin && invoice.withGst) ? `<p style="margin: 0; font-weight: bold;">GSTIN: ${invoice.customerGstin}</p>` : ''}
                </div>
              </td>

              <!-- Right Side: Invoice Details Table Box -->
              <td style="width: 48%; vertical-align: top; padding-left: 15px;">
                <table style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 12px;">
                  <tbody>
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc; width: 42%;">Invoice No.:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; color: #1e293b;">${invoice.invoiceNo}</td>
                    </tr>
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc;">Invoice Date:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px;">${formattedDate}</td>
                    </tr>
                    ${invoice.withGst && settings.gstin ? `
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc;">GSTIN:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px;">${settings.gstin}</td>
                    </tr>
                    ` : ''}
                    ${invoice.paymentStage && invoice.paymentStage !== 'full' ? `
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc;">Payment Stage:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; color: #2563eb; text-transform: capitalize;">
                        ${invoice.paymentStage === 'advance' ? 'Advance Payment' : (invoice.paymentStage === 'mid' ? `Milestone / Part #${invoice.stageNumber || 1}` : (invoice.paymentStage === 'final' ? 'Final Settlement' : invoice.paymentStage))}
                      </td>
                    </tr>
                    ` : ''}
                    ${invoice.invoiceCategory === 'consolidated' ? `
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc;">Invoice Type:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; color: #16a34a;">Consolidated Final</td>
                    </tr>
                    ` : ''}
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Products Table -->
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; border: 1px solid #cbd5e1;">
          <thead>
            <tr>
              <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: center; background-color: ${BRAND_BLUE}; color: #fff; width: 7%;">S. No</th>
              <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: left; background-color: ${BRAND_BLUE}; color: #fff; width: 53%;">Item (Description)</th>
              <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; background-color: ${BRAND_BLUE}; color: #fff; width: 15%;">Rate</th>
              <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: center; background-color: ${BRAND_BLUE}; color: #fff; width: 7%;">Qty</th>
              <th style="border: 1px solid #cbd5e1; padding: 8px; text-align: right; background-color: ${BRAND_BLUE}; color: #fff; width: 18%;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${productsHtml}
          </tbody>
        </table>

        <!-- GST Summary -->
        ${gstSummaryHtml}

        <!-- Payment History Breakdown -->
        ${paymentHistoryHtml}

        <!-- Bank Details + Payment Summary -->
        <div
          style="
            display: flex;
            justify-content: ${invoice.isProforma ? 'space-between' : 'flex-end'};
            align-items: flex-start;
            gap: 20px;
            width: 100%;
            margin-bottom: 30px;
            page-break-inside: avoid;
          "
        >
          <!-- LEFT: BANK ACCOUNT DETAILS - PROFORMA ONLY -->
          ${invoice.isProforma ? `
          <div style="width: 48%;">
            <h4 style="margin: 0 0 8px 0; font-weight: bold;">BANK ACCOUNT DETAILS</h4>
            <table style="border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 12px; width: 100%;">
              <tbody>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">Account Name</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">${bankAccountName}</td>
                </tr>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">Account Number</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">${bankAccountNumber}</td>
                </tr>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">Bank Name</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">${bankName}</td>
                </tr>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">Branch</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">${bankBranch}</td>
                </tr>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">IFSC</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">${bankIfsc}</td>
                </tr>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">Account Type</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">Current Account</td>
                </tr>
                <tr>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px; font-weight: bold; white-space: nowrap;">GPay Number</td>
                  <td style="border: 1px solid #cbd5e1; padding: 6px 12px;">${gpayNumber}</td>
                </tr>
              </tbody>
            </table>
          </div>
          ` : ''}
        </div>

        <!-- PAID INVOICE PAYMENT INFORMATION -->
        ${!invoice.isProforma && invoice.paymentStatus === 'Paid' ? `
        <div
          style="
            width: 48%;
            margin-left: 0;
            margin-right: auto;
            margin-top: -10px;
            margin-bottom: 20px;
            page-break-inside: avoid;
          "
        >
          <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: normal; text-align: left;">
            <span style="font-weight: bold;">Payment Status:</span> Paid
          </p>
          <p style="margin: 0; font-size: 12px; font-weight: normal; text-align: left; line-height: 1.5;">
            <span style="font-weight: bold;">Amount in words:</span> ${amountInWords}
          </p>
        </div>
        ` : ''}

        <!-- Signature -->
        <div
          style="
            width: 100%;
            display: flex;
            justify-content: flex-end;
            align-items: flex-end;
            margin-top: 35px;
            page-break-inside: avoid;
          "
        >
          <div style="width: 180px; text-align: center;">
            ${
              signatureSrc
                ? `<img
                    src="${signatureSrc}"
                    alt="Signature"
                    style="
                      max-height: 60px;
                      max-width: 160px;
                      margin-bottom: 8px;
                      display: block;
                      margin-left: auto;
                      margin-right: auto;
                    "
                  />`
                : `<div style="height: 60px; margin-bottom: 8px;"></div>`
            }
            <p style="margin: 0; font-weight: bold; color: ${BRAND_BLUE};">
              (Authorized Signatory)
            </p>
          </div>
        </div>
        
      </div>
    </body>
    </html>
  `;
};

module.exports = { generateInvoiceHtml };

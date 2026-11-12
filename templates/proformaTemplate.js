const fs = require('fs');
const path = require('path');

const generateProformaHtml = (proforma, settings) => {
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

  const isWithGst = proforma.gstType === 'withGST' || 
                    proforma.gstType === 'With GST' ||
                    proforma.withGst === true || 
                    proforma.withGst === 'true' || 
                    proforma.isWithGst === true || 
                    String(proforma.gstType || '').toLowerCase() === 'withgst';

  const companyName = isWithGst 
    ? (settings.companyName || settings.companyNameWithoutGst) 
    : (settings.companyNameWithoutGst || settings.companyName);

  const companyAddress = isWithGst 
    ? (settings.address || settings.addressWithoutGst) 
    : (settings.addressWithoutGst || settings.address);

  const companyPhone = isWithGst 
    ? (settings.phone || settings.phoneWithoutGst) 
    : (settings.phoneWithoutGst || settings.phone);

  const companyEmail = isWithGst 
    ? (settings.email || settings.emailWithoutGst) 
    : (settings.emailWithoutGst || settings.email);

  const bankAccountName = isWithGst 
    ? (settings.bankAccountName || "JAYAM TECHNOLOGIES") 
    : (settings.bankAccountNameWithoutGst || "Jayam Web Solutions");
  const bankAccountNumber = isWithGst 
    ? (settings.bankAccountNumber || "120035000004") 
    : (settings.bankAccountNumberWithoutGst || "722473240");
  const bankName = isWithGst 
    ? (settings.bankName || "Canara Bank") 
    : (settings.bankNameWithoutGst || "Indian Bank");
  const bankBranch = isWithGst 
    ? (settings.bankBranch || "Perungalathur") 
    : (settings.bankBranchWithoutGst || "Tambaram West, Chennai");
  const bankIfsc = isWithGst 
    ? (settings.bankIfsc || "CNRB0003856") 
    : (settings.bankIfscWithoutGst || "IDIB000T092");
  const gpayNumber = isWithGst 
    ? (settings.gpayNumber || "9840599789") 
    : (settings.gpayNumberWithoutGst || "9677876445");

  const custName = proforma.customerId?.name || proforma.companyName || '';
  const custAddr = proforma.customerId?.address || proforma.address || '';
  const custPhone = proforma.customerId?.phone || proforma.phone || '';
  const custEmail = proforma.customerId?.email || proforma.email || '';
  const custGst = proforma.customerId?.gstin || proforma.gstNumber || '';
  const custState = proforma.customerId?.state || proforma.state || 'Tamil Nadu';

  const phoneStr = Array.isArray(custPhone) ? custPhone.filter(Boolean).join(', ') : (custPhone || '');
  const emailStr = Array.isArray(custEmail) ? custEmail.filter(Boolean).join(', ') : (custEmail || '');

  const isTamilNadu = custState === 'Tamil Nadu';
  const cgstRate = settings.cgstPercentage || 9;
  const sgstRate = settings.sgstPercentage || 9;
  const igstRate = settings.igstPercentage || 18;
  const totalGstRate = isTamilNadu ? (cgstRate + sgstRate) : igstRate;

  // Format date
  const formattedDate = proforma.date
    ? new Date(proforma.date).toLocaleDateString('en-GB')
    : new Date().toLocaleDateString('en-GB');


    const subtotal = Number(proforma.subtotal || 0);

let taxableValue = subtotal;

let actualTotal = subtotal;
let roundedTotal = Math.round(subtotal);

let cgstAmount = 0;
let sgstAmount = 0;
let igstAmount = 0;

let roundOffLabel = "Total (Round Off)";

// ======================================================
// GST CALCULATION
// ======================================================

if (isWithGst) {

  if (isTamilNadu) {

    // CGST
    cgstAmount =
      proforma.cgst !== undefined && proforma.cgst !== null
        ? Number(proforma.cgst)
        : Math.round(
            ((taxableValue * Number(cgstRate)) / 100) * 100
          ) / 100;

    // SGST
    sgstAmount =
      proforma.sgst !== undefined && proforma.sgst !== null
        ? Number(proforma.sgst)
        : Math.round(
            ((taxableValue * Number(sgstRate)) / 100) * 100
          ) / 100;

    // Actual GST inclusive amount
    actualTotal = Number(
      (
        taxableValue +
        cgstAmount +
        sgstAmount
      ).toFixed(2)
    );

  } else {

    // IGST
    igstAmount =
      proforma.igst !== undefined && proforma.igst !== null
        ? Number(proforma.igst)
        : Math.round(
            ((taxableValue * Number(igstRate)) / 100) * 100
          ) / 100;

    // Actual GST inclusive amount
    actualTotal = Number(
      (
        taxableValue +
        igstAmount
      ).toFixed(2)
    );
  }

} else {

  // ====================================================
  // WITHOUT GST
  // ====================================================

  actualTotal = Number(
    (
      proforma.totalPrice !== undefined &&
      proforma.totalPrice !== null
        ? proforma.totalPrice
        : subtotal
    ).toFixed(2)
  );
}

// ====================================================
// ROUND-OFF / ROUND-UP RULE (APPLIES TO BOTH WITH GST & WITHOUT GST)
//
// If decimal === 0.00 => Stop with Total (no round-off row)
// 0.01 - 0.49         => Round Off / Down: Total (Rounded-off)
// 0.50 - 0.99         => Round Up: Total (Rounded-up)
// ====================================================

const integerPart = Math.floor(actualTotal);
const decimalPart = Number(
  (actualTotal - integerPart).toFixed(2)
);
const hasDecimals = decimalPart > 0 && decimalPart < 1;

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

  // Convert number to words
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

const amountInWords = (
  proforma.priceinword &&
  !/\d/.test(proforma.priceinword)
)
  ? proforma.priceinword
  : numberToWords(
      isWithGst
        ? roundedTotal
        : Math.round(actualTotal)
    );

  const highlightDomainAndDates = (str) => {
    if (!str) return '';
    let result = str;

    // Bold service / product name
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

    // Bold domain names (e.g. madhanpackagingmachineries.co.in, impeccablepack.in)
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
    // Bold dates (e.g. 14.08.2026, 13.08.2027)
    result = result.replace(
      /\b(\d{2}[\.\/]\d{2}[\.\/]\d{4}|\d{4}-\d{2}-\d{2})\b/g,
      '<strong style="font-weight: 700;">$1</strong>'
    );
    return result;
  };

  // Products / Particulars table (same markup pattern as invoice)
  let productsHtml = '';
  (proforma.items || []).forEach((item, idx) => {
    const qty = item.qty || item.quantity || 1;
    const amtVal = Number(item.price || item.amount || 0);
    const rateVal = item.rate !== undefined && item.rate !== null ? Number(item.rate) : (amtVal / qty);

    const formattedRate = rateVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formattedAmt = amtVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const formattedText = highlightDomainAndDates(item.Particulars || item.description || '');
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

if (!isWithGst) {
  if (hasDecimals) {
    productsHtml += `
      <tr>
        <td
          colspan="4"
          style="
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: right;
            font-weight: bold;
          "
        >
          Total Amount:
        </td>
        <td
          style="
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: right;
            font-weight: bold;
          "
        >
          ₹ ${actualTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </td>
      </tr>
      <tr>
        <td
          colspan="4"
          style="
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: right;
            font-weight: bold;
          "
        >
          ${roundOffLabel}:
        </td>
        <td
          style="
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: right;
            font-weight: bold;
          "
        >
          ₹ ${Number(roundedTotal).toLocaleString('en-IN')}
        </td>
      </tr>
    `;
  } else {
    // If there is no need for round up/round off, stop with total
    productsHtml += `
      <tr>
        <td
          colspan="4"
          style="
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: right;
            font-weight: bold;
          "
        >
          Total Amount:
        </td>
        <td
          style="
            border: 1px solid #cbd5e1;
            padding: 8px;
            text-align: right;
            font-weight: bold;
          "
        >
          ₹ ${Number(actualTotal).toLocaleString('en-IN')}
        </td>
      </tr>
    `;
  }
}

  // GST Summary (same markup pattern as invoice)
  let gstSummaryHtml = '';
 if (isWithGst) {
  if (isTamilNadu) {

    gstSummaryHtml = `
      <div style="margin-bottom: 20px;">

        <h4 style="
          margin: 0 0 8px 0;
          font-weight: bold;
        ">
          GST SUMMARY
        </h4>

        <table style="
          width: 100%;
          border-collapse: collapse;
          border: 1px solid #cbd5e1;
        ">

          <thead>
            <tr>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                Taxable Value
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                CGST Rate
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                CGST Amount
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                SGST Rate
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                SGST Amount
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                Total
              </th>

            </tr>
          </thead>

          <tbody>

            <tr>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ₹ ${Number(taxableValue).toFixed(2)}
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ${cgstRate}%
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ₹ ${Number(cgstAmount).toFixed(2)}
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ${sgstRate}%
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ₹ ${Number(sgstAmount).toFixed(2)}
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                font-weight: bold;
              ">
                ₹ ${Number(actualTotal).toFixed(2)}
              </td>

            </tr>

          </tbody>

        </table>

      </div>
    `;

  } else {

    gstSummaryHtml = `
      <div style="margin-bottom: 20px;">

        <h4 style="
          margin: 0 0 8px 0;
          font-weight: bold;
        ">
          GST SUMMARY
        </h4>

        <table style="
          width: 100%;
          border-collapse: collapse;
          border: 1px solid #cbd5e1;
        ">

          <thead>

            <tr>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                Taxable Value
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                IGST Rate
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                IGST Amount
              </th>

              <th style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                text-align: left;
                background-color: ${BRAND_BLUE};
                color: #fff;
              ">
                Total
              </th>

            </tr>

          </thead>

          <tbody>

            <tr>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ₹ ${Number(taxableValue).toFixed(2)}
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ${igstRate}%
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
              ">
                ₹ ${Number(igstAmount).toFixed(2)}
              </td>

              <td style="
                border: 1px solid #cbd5e1;
                padding: 8px;
                font-weight: bold;
              ">
                ₹ ${Number(actualTotal).toFixed(2)}
              </td>

            </tr>

          </tbody>

        </table>

      </div>
    `;
  }
}

  // Totals block (same markup pattern as invoice)
let totalsHtml = '';

if (isWithGst) {

  totalsHtml += `
    <tr>

      <td style="
        border-bottom: 1px dashed #cbd5e1;
        padding: 5px 10px;
        text-align: right;
      ">
        GST%:
      </td>

      <td style="
        border-bottom: 1px dashed #cbd5e1;
        border-left: 1px dashed #cbd5e1;
        padding: 5px 10px;
        text-align: right;
      ">
        ${totalGstRate}%
      </td>

    </tr>

    <tr>

      <td style="
        border-bottom: 1px dashed #cbd5e1;
        padding: 5px 10px;
        text-align: right;
      ">
        Taxable:
      </td>

      <td style="
        border-bottom: 1px dashed #cbd5e1;
        border-left: 1px dashed #cbd5e1;
        padding: 5px 10px;
        text-align: right;
      ">
        ₹ ${Number(taxableValue).toFixed(2)}
      </td>

    </tr>
  `;

  if (isTamilNadu) {

    totalsHtml += `
      <tr>

        <td style="
          border-bottom: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
        ">
          CGST (${cgstRate}%):
        </td>

        <td style="
          border-bottom: 1px dashed #cbd5e1;
          border-left: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
        ">
          ₹ ${Number(cgstAmount).toFixed(2)}
        </td>

      </tr>

      <tr>

        <td style="
          border-bottom: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
        ">
          SGST (${sgstRate}%):
        </td>

        <td style="
          border-bottom: 1px dashed #cbd5e1;
          border-left: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
        ">
          ₹ ${Number(sgstAmount).toFixed(2)}
        </td>

      </tr>
    `;

  } else {

    totalsHtml += `
      <tr>

        <td style="
          border-bottom: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
        ">
          IGST (${igstRate}%):
        </td>

        <td style="
          border-bottom: 1px dashed #cbd5e1;
          border-left: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
        ">
          ₹ ${Number(igstAmount).toFixed(2)}
        </td>

      </tr>
    `;
  }

  // ====================================================
  // TOTAL AMOUNT / ROUND-OFF
  // ====================================================

  if (hasDecimals) {
    totalsHtml += `
      <tr>
        <td style="
          border-bottom: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
          font-weight: bold;
        ">
          Total Amount:
        </td>
        <td style="
          border-bottom: 1px dashed #cbd5e1;
          border-left: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
          font-weight: bold;
        ">
          ₹ ${actualTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </td>
      </tr>

      <!-- ROUND OFF / ROUND UP -->
      <tr>
        <td style="
          padding: 5px 10px;
          text-align: right;
          font-weight: bold;
        ">
          ${roundOffLabel}:
        </td>
        <td style="
          border-left: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
          font-weight: bold;
        ">
          ₹ ${Number(roundedTotal).toLocaleString('en-IN')}
        </td>
      </tr>
    `;
  } else {
    // If there is no need for round up/round off, stop with total
    totalsHtml += `
      <tr>
        <td style="
          padding: 5px 10px;
          text-align: right;
          font-weight: bold;
        ">
          Total Amount:
        </td>
        <td style="
          border-left: 1px dashed #cbd5e1;
          padding: 5px 10px;
          text-align: right;
          font-weight: bold;
        ">
          ₹ ${Number(actualTotal).toLocaleString('en-IN')}
        </td>
      </tr>
    `;
  }
} 
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Proforma Invoice - ${proforma.proforma_no}</title>
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
      <div style="width: 100%; min-height: 1050px; padding: 20px 15px; background-color: #fff; color: #000; font-family: 'Roboto', 'Segoe UI', Arial, sans-serif; font-size: 12px; position: relative; box-sizing: border-box;">
        <!-- Header -->
        <div style="text-align: center; margin-bottom: 4px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: bold;">${companyName}</h2>
          <p style="margin: 4px 0; font-size: 12px; white-space: pre-wrap;">${companyAddress}</p>
          <p style="margin: 4px 0; font-size: 12px;">Email: ${companyEmail}, Phone: ${companyPhone}</p>
          <h3 style="margin: 8px 0 0; color: ${INVOICE_RED}; font-size: 14px; font-weight: bold;">PROFORMA INVOICE</h3>
          <hr style="border: 0; border-top: 2px solid ${BRAND_BLUE}; margin: 12px 0 10px;" />
        </div>

        <!-- Bill To & Proforma Info -->
        <table style="width: 100%; margin-top: 25px; margin-bottom: 30px; border-collapse: collapse; table-layout: fixed;">
          <tbody>
            <tr>
              <!-- Left Side: Bill To -->
              <td style="width: 52%; vertical-align: top; padding-right: 15px;">
                <h4 style="margin: 0 0 6px 0; text-decoration: underline; font-weight: bold;">Bill To</h4>
                <div style="">
                  <p style="margin: 0 0 4px 0; font-weight: bold; font-size: 13px;">${custName}</p>
                  <p style="margin: 0 0 4px 0; white-space: pre-wrap; line-height: 1.5; color: #334155;">${custAddr}</p>
                  ${(custGst && isWithGst) ? `<p style="margin: 0; font-weight: bold;">GSTIN: ${custGst}</p>` : ''}
                </div>
              </td>

              <!-- Right Side: Proforma Details Table Box -->
              <td style="width: 48%; vertical-align: top; padding-left: 15px;">
                <table style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 12px;">
                  <tbody>
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc; width: 42%;">Proforma No.:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; color: #1e293b;">${proforma.proforma_no}</td>
                    </tr>
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc;">Date:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px;">${formattedDate}</td>
                    </tr>
                    ${isWithGst && settings.gstin ? `
                    <tr>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px; font-weight: bold; background-color: #f8fafc;">GSTIN:</td>
                      <td style="border: 1px solid #cbd5e1; padding: 6px 10px;">${settings.gstin}</td>
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

        <!-- Summary Totals -->
        ${isWithGst ? `
        <div style="display: flex; justify-content: flex-end; margin-bottom: 30px;">
          <table style="border-collapse: collapse; border: 1px dashed #cbd5e1; width: 300px;">
            <tbody>
              ${totalsHtml}
            </tbody>
          </table>
        </div>
        ` : ''}

        <!-- Amount in words -->
        <div style="margin-bottom: 20px;">
          <p style="margin: 0;">
            <span style="font-weight: bold;">Amount in words:</span> ${amountInWords}
          </p>
        </div>

        <!-- Bank Account Details -->
        <div style="margin-bottom: 20px;">
          <h4 style="margin: 0 0 8px 0; font-weight: bold;">BANK ACCOUNT DETAILS</h4>
          <table style="border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 12px;">
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

        ${proforma.note ? `
        <!-- Note -->
        <div style="margin-bottom: 40px; font-size: 12px;">
          <span style="font-weight: bold;">Note:</span> ${proforma.note}
        </div>
        ` : ''}

        <!-- Signature -->
        <div style="display: flex; justify-content: flex-end; margin-top: 30px; page-break-inside: avoid;">
          <div style="text-align: center; min-width: 180px;">
            ${signatureSrc ? `<img src="${signatureSrc}" alt="Signature" style="max-height: 60px; margin-bottom: 8px;" />` : `<div style="height: 60px; margin-bottom: 8px;"></div>`}
            <p style="margin: 0; font-weight: bold; color: ${BRAND_BLUE};">(Authorized Signatory)</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

module.exports = { generateProformaHtml };
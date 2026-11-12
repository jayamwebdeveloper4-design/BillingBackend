const Customer = require('../models/Customer');

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

// @desc    Get order management stats and list of renewal orders
// @route   GET /api/order-management
// @access  Private
const getOrderManagementData = async (req, res) => {
  try {
    const { startDate, endDate, search, status, month } = req.query;
    
    // Timezone-safe local YYYY-MM-DD formatting
    const today = new Date();
    const getLocalYYYYMMDD = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    const todayStr = getLocalYYYYMMDD(today);

    // Fetch all customers with their orders
    const customers = await Customer.find({});

    let totalOrders = 0;
    let expiredOrdersCount = 0;
    let renewalOrdersCount = 0; // Total count of date-validated orders (regardless of expiry status)
    
    const allRenewalOrders = [];

    customers.forEach(customer => {
      if (customer.orders && Array.isArray(customer.orders)) {
        customer.orders.forEach(order => {
          const activeValidationProds = order.products?.filter(p => p.validationEnabled && !p.deactive) || [];
          const isDateValidated = activeValidationProds.length > 0;
          const isExpired = isDateValidated && order.endDate < todayStr;

          const orderDateVal = order.orderDate || order.startDate || "";
          let orderMonth = "";
          if (orderDateVal) {
            const parts = orderDateVal.split('-');
            orderMonth = parts[1] || "";
          }

          if (month) {
            if (orderMonth === month) {
              totalOrders++;
              if (isDateValidated) {
                if (isExpired) {
                  expiredOrdersCount++;
                } else {
                  renewalOrdersCount++;
                }
              }
            }
          } else {
            totalOrders++;
            if (isDateValidated) {
              if (isExpired) {
                expiredOrdersCount++;
              } else {
                renewalOrdersCount++;
              }
            }
          }
        });

        customer.orders.forEach(order => {
          const activeValidationProds = order.products?.filter(p => p.validationEnabled && !p.deactive) || [];
          const isDateValidated = activeValidationProds.length > 0;

          if (isDateValidated) {
            const isExpired = order.endDate < todayStr;

            // Extract validation-enabled products
            const productNames = activeValidationProds.map(p => p.product).join(', ');

            let renewalPrice = 0;
            let renewalCost = 0;

            activeValidationProds.forEach(p => {
              const itemSelling = p.price || 0;
              const itemCost = p.costPrice || 0;

              renewalPrice += (itemSelling * (p.quantity || 1));
              renewalCost += (itemCost * (p.quantity || 1));
            });

            // If query filters are active, check if order fits range
            let matchesFilter = true;
            if (month) {
              const orderDateVal = order.orderDate || order.startDate || "";
              if (orderDateVal) {
                const parts = orderDateVal.split('-'); // YYYY-MM-DD
                if (parts[1] !== month) {
                  matchesFilter = false;
                }
              } else {
                matchesFilter = false;
              }
            } else {
              if (startDate && order.endDate < startDate) matchesFilter = false;
              if (endDate && order.endDate > endDate) matchesFilter = false;
            }

            if (search) {
              const q = search.toLowerCase();
              const nameMatch = customer.name?.toLowerCase().includes(q);
              const emailMatch = Array.isArray(customer.email)
                ? customer.email.some(e => e.toLowerCase().includes(q))
                : customer.email?.toLowerCase().includes(q);
              const phoneMatch = Array.isArray(customer.phone)
                ? customer.phone.some(p => p.toLowerCase().includes(q))
                : customer.phone?.toLowerCase().includes(q);
              const domainMatch = order.domainUrl?.toLowerCase().includes(q);
              const productMatch = productNames?.toLowerCase().includes(q);
              
              if (!nameMatch && !emailMatch && !phoneMatch && !domainMatch && !productMatch) {
                matchesFilter = false;
              }
            }

            if (status) {
              const s = status.toLowerCase();
              if (s === 'expired' && !isExpired) matchesFilter = false;
              if (s === 'renewal' && isExpired) matchesFilter = false;
            }

            if (matchesFilter) {
              const createdDateVal = order.products?.find(p => p.validationEnabled && p.startDate === order.startDate)?.createdDate 
                || order.products?.find(p => p.createdDate)?.createdDate 
                || order.orderDate 
                || order.startDate;

              allRenewalOrders.push({
                id: `${customer._id}-${order._id}`,
                customerId: customer._id,
                orderId: order._id,
                customerName: customer.name,
                email: customer.email,
                phone: customer.phone,
                customerState: customer.state || "Tamil Nadu",
                address: customer.address || "",
                productName: productNames,
                dueDate: order.endDate,
                domainUrl: order.domainUrl || "",
                startDate: order.startDate || "",
                endDate: order.endDate || "",
                price: renewalPrice,
                priceWords: numberToWords(Math.round(renewalPrice)),
                startDateDot: formatDateDot(order.startDate),
                endDateDot: formatDateDot(order.endDate),
                emailSend: order.emailSend || false,
                expiredEmailSend: order.expiredEmailSend || false,
                deletionEmailSend: order.deletionEmailSend || false,
                sellerPriceRenewal: renewalPrice,
                costPriceRenewal: renewalCost,
                paymentStatus: order.paymentStatus || 'Unpaid',
                isExpired,
                orderDate: order.orderDate,
                createdDate: createdDateVal  
              });
            }
          }
        });
      }
    });

    // Sort by insertion order descending (_id is newest last inserted = latest first)
    allRenewalOrders.sort((a, b) => {
      const idA = (a.orderId || '').toString();
      const idB = (b.orderId || '').toString();
      return idB.localeCompare(idA);
    });

    res.json({
      stats: {
        totalOrders,
        expiredOrders: expiredOrdersCount,
        renewalOrders: renewalOrdersCount,
      },
      renewalOrders: allRenewalOrders
    });

  } catch (error) {
    console.error('[OrderManagementController] error:', error);
    res.status(500).json({ message: 'Failed to fetch order management data', error: error.message });
  }
};

module.exports = {
  getOrderManagementData
};

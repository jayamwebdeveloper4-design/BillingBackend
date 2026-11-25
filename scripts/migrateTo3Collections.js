const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');

const isExecute = process.argv.includes('--execute');

const runMigration = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('❌ MONGO_URI is missing from environment variables.');
      process.exit(1);
    }

    console.log(`🔌 Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    console.log(`✅ Connected successfully.\n`);

    console.log(`=======================================================`);
    console.log(`MODE: ${isExecute ? '🚀 EXECUTE (Writing to DB)' : '🔍 DRY-RUN (Preview Only, No DB Writes)'}`);
    console.log(`=======================================================\n`);

    const customers = await Customer.find({});
    console.log(`📦 Found ${customers.length} customer records to inspect.\n`);

    let totalOrdersCount = 0;
    let totalProductsCount = 0;
    let totalPaymentsCount = 0;
    let totalRevenueSum = 0;

    const orderBulkOps = [];
    const productBulkOps = [];

    for (const cust of customers) {
      const orders = cust.orders || [];

      for (const ord of orders) {
        totalOrdersCount++;

        // 1. Prepare Order Document
        const orderDoc = {
          _id: ord._id,
          customerId: cust._id,
          orderDate: ord.orderDate || cust.createdAt?.toISOString().split('T')[0] || '',
          domainUrl: ord.domainUrl || '',
          totalPrice: ord.totalPrice || 0,
          paymentStatus: ord.paymentStatus || 'Unpaid',
          startDate: ord.startDate || '',
          endDate: ord.endDate || '',
          billingCycle: ord.billingCycle || 'yearly',
          emailSend: !!ord.emailSend,
          expiredEmailSend: !!ord.expiredEmailSend,
          deletionEmailSend: !!ord.deletionEmailSend,
          createdAt: ord.createdAt || cust.createdAt || new Date(),
          updatedAt: ord.updatedAt || cust.updatedAt || new Date()
        };

        orderBulkOps.push({
          updateOne: {
            filter: { _id: ord._id },
            update: { $set: orderDoc },
            upsert: true
          }
        });

        // 2. Prepare Products & Map Payments
        const prods = ord.products || [];
        const payments = ord.payments || [];

        // Sum payment metrics
        payments.forEach(p => {
          totalPaymentsCount++;
          totalRevenueSum += Number(p.amount || 0);
        });

        // Helper to normalize legacy paymentStage into ['advance', 'mid', 'full']
        const normalizePaymentStage = (stage, amount, totalPrice) => {
          if (!stage) return (amount && totalPrice && amount >= totalPrice) ? 'full' : 'advance';
          const s = String(stage).toLowerCase().trim();
          if (s === 'advance') return 'advance';
          if (s === 'mid') return 'mid';
          if (s === 'full' || s === 'final' || s === 'renewal' || s === 'onetimepayment') return 'full';
          if (s === 'base') return (amount && totalPrice && amount >= totalPrice) ? 'full' : 'advance';
          return 'full';
        };

        // Determine primary product (highest price) to receive payments if multiple products exist
        let primaryProdIdx = 0;
        if (prods.length > 1) {
          let maxPrice = -1;
          prods.forEach((p, idx) => {
            const pr = Number(p.price || 0);
            if (pr > maxPrice) {
              maxPrice = pr;
              primaryProdIdx = idx;
            }
          });
        }

        prods.forEach((prod, pIdx) => {
          totalProductsCount++;

          // Payments mapping: 
          // If this is the only product, or the primary product in multi-product order, assign order payments
          const assignedPayments = (pIdx === primaryProdIdx) ? payments.map(p => ({
            _id: p._id,
            date: p.date,
            amount: p.amount,
            withGst: !!p.withGst,
            gstvalue: p.gstvalue || 0,
            paymentStage: normalizePaymentStage(p.paymentStage, p.amount, ord.totalPrice),
            stageNumber: p.stageNumber || 1,
            invoiceId: p.invoiceId || null,
            invoiceNo: p.invoiceNo || '',
            description: p.description || '',
            tdsAmount: p.tdsAmount || 0,
            renewalSellingPrice: p.renewalSellingPrice || null,
            renewalCostPrice: p.renewalCostPrice || null,
            createdAt: p.createdAt || ord.createdAt || new Date(),
            updatedAt: p.updatedAt || ord.updatedAt || new Date()
          })) : [];

          // Determine productType: 'Renewal' if validationEnabled or has renewal prices or recurring dates, else 'Regular'
          const isRenewalProduct = !prod.oneTimePayment && (
            !!prod.validationEnabled ||
            (prod.sellerPriceRenewal && prod.sellerPriceRenewal > 0) ||
            (prod.endDate && prod.endDate.trim() !== '') ||
            (prod.product && /domain|hosting|renewal|ssl|vps|server/i.test(prod.product))
          );
          const computedProductType = isRenewalProduct ? 'Renewal' : 'Regular';

          const latestStage = assignedPayments.length > 0 
            ? assignedPayments[assignedPayments.length - 1].paymentStage 
            : 'advance';

          const productDoc = {
            _id: prod._id,
            orderId: ord._id,
            customerId: cust._id,
            product: prod.product,
            variant: prod.variant,
            price: prod.price || 0,
            costPrice: prod.costPrice || 0,
            quantity: prod.quantity || 1,
            productType: computedProductType,
            billingCycle: prod.billingCycle || ord.billingCycle || 'yearly',
            cycleCount: 1,
            paymentStage: latestStage,
            startDate: prod.startDate || ord.startDate || '',
            endDate: prod.endDate || ord.endDate || '',
            sellerPriceRenewal: prod.sellerPriceRenewal !== undefined ? prod.sellerPriceRenewal : null,
            costPriceRenewal: prod.costPriceRenewal !== undefined ? prod.costPriceRenewal : null,
            validationEnabled: !!prod.validationEnabled,
            oneTimePayment: !!prod.oneTimePayment,
            deactive: !!prod.deactive,
            deactiveYear: prod.deactiveYear || '',
            deactiveDate: prod.deactiveDate || '',
            paymentHistory: assignedPayments,
            createdAt: prod.createdAt || ord.createdAt || new Date(),
            updatedAt: prod.updatedAt || ord.updatedAt || new Date()
          };

          productBulkOps.push({
            updateOne: {
              filter: { _id: prod._id },
              update: { $set: productDoc },
              upsert: true
            }
          });
        });
      }
    }

    console.log(`📊 Migration Audit Statistics:`);
    console.log(`-------------------------------------------------------`);
    console.log(`  Total Customers Audited: ${customers.length}`);
    console.log(`  Total Orders Prepared:   ${totalOrdersCount}`);
    console.log(`  Total Products Prepared: ${totalProductsCount}`);
    console.log(`  Total Payments Mapped:   ${totalPaymentsCount}`);
    console.log(`  Total Revenue Sum:       ₹${totalRevenueSum.toLocaleString('en-IN')}`);
    console.log(`-------------------------------------------------------\n`);

    if (isExecute) {
      console.log(`⏳ Executing bulkWrite on 'orders' collection (${orderBulkOps.length} ops)...`);
      if (orderBulkOps.length > 0) {
        await Order.bulkWrite(orderBulkOps);
      }
      console.log(`✅ 'orders' collection updated successfully.\n`);

      console.log(`⏳ Executing bulkWrite on 'customerproducts' collection (${productBulkOps.length} ops)...`);
      if (productBulkOps.length > 0) {
        await CustomerProduct.bulkWrite(productBulkOps);
      }
      console.log(`✅ 'customerproducts' collection updated successfully.\n`);

      console.log(`🎉 MIGRATION COMPLETED SAFELY!`);
      console.log(`Original 'Customer' documents remain 100% intact.`);
    } else {
      console.log(`💡 DRY-RUN FINISHED.`);
      console.log(`To write these changes to the database, run:`);
      console.log(`  node backend/scripts/migrateTo3Collections.js --execute\n`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration Error:', error);
    process.exit(1);
  }
};

runMigration();


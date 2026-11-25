const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');

const runVerification = async () => {
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
    console.log(`🔍 MIGRATION VERIFICATION & RECONCILIATION AUDIT`);
    console.log(`=======================================================\n`);

    // 1. Audit Old (Legacy) Data
    const customers = await Customer.find({});
    let legacyOrderCount = 0;
    let legacyProductCount = 0;
    let legacyPaymentCount = 0;
    let legacyRevenueSum = 0;

    customers.forEach(cust => {
      (cust.orders || []).forEach(ord => {
        legacyOrderCount++;
        (ord.products || []).forEach(() => {
          legacyProductCount++;
        });
        (ord.payments || []).forEach(p => {
          legacyPaymentCount++;
          legacyRevenueSum += Number(p.amount || 0);
        });
      });
    });

    // 2. Audit New (3-Collection) Data
    const newOrderCount = await Order.countDocuments({});
    const newProductCount = await CustomerProduct.countDocuments({});

    const allProducts = await CustomerProduct.find({}, 'paymentHistory');
    let newPaymentCount = 0;
    let newRevenueSum = 0;

    allProducts.forEach(prod => {
      (prod.paymentHistory || []).forEach(p => {
        newPaymentCount++;
        newRevenueSum += Number(p.amount || 0);
      });
    });

    // 3. Compare Results
    console.log(`Metric                     | Legacy (Old)       | New Collections    | Status`);
    console.log(`---------------------------------------------------------------------------------`);
    
    const ordersMatch = legacyOrderCount === newOrderCount;
    console.log(`Orders Count               | ${legacyOrderCount.toString().padEnd(18)} | ${newOrderCount.toString().padEnd(18)} | ${ordersMatch ? '✅ MATCH' : '❌ MISMATCH'}`);

    const productsMatch = legacyProductCount === newProductCount;
    console.log(`Products Count             | ${legacyProductCount.toString().padEnd(18)} | ${newProductCount.toString().padEnd(18)} | ${productsMatch ? '✅ MATCH' : '❌ MISMATCH'}`);

    const paymentsMatch = legacyPaymentCount === newPaymentCount;
    console.log(`Payments Count             | ${legacyPaymentCount.toString().padEnd(18)} | ${newPaymentCount.toString().padEnd(18)} | ${paymentsMatch ? '✅ MATCH' : '❌ MISMATCH'}`);

    const revenueMatch = Math.round(legacyRevenueSum) === Math.round(newRevenueSum);
    console.log(`Total Revenue (₹)          | ₹${legacyRevenueSum.toLocaleString('en-IN').padEnd(17)} | ₹${newRevenueSum.toLocaleString('en-IN').padEnd(17)} | ${revenueMatch ? '✅ MATCH' : '❌ MISMATCH'}`);

    console.log(`---------------------------------------------------------------------------------\n`);

    if (ordersMatch && productsMatch && paymentsMatch && revenueMatch) {
      console.log(`🎉 100% RECONCILIATION SUCCESS! All data migrated with ZERO discrepancy.\n`);
    } else {
      console.log(`⚠️ Some counts do not match. Review the numbers above.\n`);
    }

    // 4. Sample Linkage Check
    console.log(`🔗 Sampling 3 Customers to test relational joins:`);
    const sampleCustomers = await Customer.find({ 'orders.0': { $exists: true } }).limit(3);
    for (const sc of sampleCustomers) {
      const linkedOrders = await Order.find({ customerId: sc._id });
      const linkedProducts = await CustomerProduct.find({ customerId: sc._id });
      console.log(`  Customer: "${sc.name}" (ID: ${sc._id})`);
      console.log(`    ↳ Found ${linkedOrders.length} linked Orders in 'orders' collection`);
      console.log(`    ↳ Found ${linkedProducts.length} linked Products in 'customerproducts' collection`);
    }

    console.log(`\n=======================================================`);
    console.log(`Verification Complete.`);
    console.log(`=======================================================`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Verification Error:', error);
    process.exit(1);
  }
};

runVerification();


const path = require('path');
const fs = require('fs');

// Support running from either root directory or backend directory
const envPaths = [
  path.join(__dirname, '../.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'backend/.env')
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    break;
  }
}
const mongoose = require('mongoose');
// Disable automatic Mongoose background index building during migration
mongoose.set('autoIndex', false);
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');

// Parse Command Line Arguments
const args = process.argv.slice(2);
const isExecute = args.includes('--execute');
const shouldCleanOldOrders = args.includes('--clean-orders');
const isDropExisting = args.includes('--drop-existing');
const shouldSyncCustomers = args.includes('--sync-customers');
const shouldDropUnwanted = args.includes('--drop-unwanted');

// Known active core collections in JayamBillings
const ACTIVE_COLLECTIONS = new Set([
  'admins',
  'autoremindersettings',
  'customers',
  'customerproducts',
  'orders',
  'expenses',
  'gstsettings',
  'paymentconfirmationsettings',
  'products',
  'proformas',
  'revenueexpenses',
  'smtpsettings',
  'templates'
]);

// Optional custom URIs
const sourceUriArg = args.find(a => a.startsWith('--source=') || a.startsWith('--uri='));
const customMongoUri = sourceUriArg ? sourceUriArg.split('=')[1] : null;

/**
 * Normalizes email and phone into clean unique arrays
 */
const cleanArray = (val, isEmail = false) => {
  if (!val) return [];
  let rawList = [];
  if (typeof val === 'string') rawList = val.split(',');
  else if (Array.isArray(val)) rawList = val.flatMap(i => (typeof i === 'string' ? i.split(',') : [i]));
  else rawList = [String(val)];
  return Array.from(new Set(
    rawList.map(i => String(i).trim()).map(i => (isEmail ? i.toLowerCase() : i)).filter(Boolean)
  ));
};

/**
 * Safe ObjectId conversion
 */
const toObjectId = (val) => {
  if (!val) return new mongoose.Types.ObjectId();
  if (val instanceof mongoose.Types.ObjectId) return val;
  if (mongoose.Types.ObjectId.isValid(val)) return new mongoose.Types.ObjectId(val);
  return new mongoose.Types.ObjectId();
};

/**
 * Strict UTC date parser
 */
const parseDateToUTC = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? null
      : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value !== 'string') return null;

  const clean = value.trim();
  let year, month, day;
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = clean.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/);

  if (iso) {
    [, year, month, day] = iso;
  } else if (local) {
    [, day, month, year] = local;
  } else {
    return null;
  }

  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return isNaN(d.getTime()) ? null : d;
};

const getTodayUTC = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/**
 * Normalizes legacy payment stage into CustomerProduct enum: ['advance', 'mid', 'final', 'full']
 */
const normalizePaymentStage = (stage, amount, totalPrice) => {
  if (!stage) {
    return (amount && totalPrice && Number(amount) >= Number(totalPrice)) ? 'full' : 'advance';
  }
  const s = String(stage).toLowerCase().trim();
  if (s === 'advance' || s === 'adv') return 'advance';
  if (s === 'mid' || s === 'middle' || s === 'partial' || s === 'part') return 'mid';
  if (s === 'final') return 'final';
  if (s === 'full' || s === 'renewal' || s === 'onetimepayment' || s === 'completed' || s === 'paid') return 'full';
  return (amount && totalPrice && Number(amount) >= Number(totalPrice)) ? 'full' : 'advance';
};

/**
 * Computes Order paymentStatus enum: ['Unpaid', 'Partially Paid', 'Fully Paid']
 */
const computeOrderPaymentStatus = (totalPaid, totalPrice) => {
  const paid = Math.round((Number(totalPaid || 0) + Number.EPSILON) * 100) / 100;
  const price = Math.round((Number(totalPrice || 0) + Number.EPSILON) * 100) / 100;

  if (paid <= 0) return 'Unpaid';
  if (price > 0 && paid >= price) return 'Fully Paid';
  return 'Partially Paid';
};

/**
 * Determines productType: must be either 'Renewal' or 'OneTime' (CustomerProduct enum)
 */
const determineProductType = (prod, ord = {}) => {
  if (prod.productType) {
    const pt = String(prod.productType).trim().toLowerCase();
    if (pt === 'renewal') return 'Renewal';
    if (pt === 'onetime' || pt === 'one-time' || pt === 'regular') return 'OneTime';
  }

  if (prod.oneTimePayment === true) {
    return 'OneTime';
  }

  if (prod.validationEnabled === true) {
    return 'Renewal';
  }

  const sellerRenewal = Number(prod.sellerPriceRenewal);
  if (Number.isFinite(sellerRenewal) && sellerRenewal > 0) {
    return 'Renewal';
  }

  if (prod.endDate && String(prod.endDate).trim() !== '') {
    return 'Renewal';
  }

  const nameToCheck = `${prod.product || ''} ${prod.variant || ''}`.toLowerCase();
  if (/(domain|hosting|renewal|ssl|vps|server|maintenance|amc|annual)/i.test(nameToCheck)) {
    return 'Renewal';
  }

  return 'OneTime';
};

/**
 * Determines renewalStatus: ['active', 'renewed', 'yearly renewed', 'upcoming', 'not renewed']
 */
const determineRenewalStatus = (prod, productType) => {
  if (productType !== 'Renewal') {
    return prod.deactive ? 'not renewed' : 'active';
  }

  if (prod.deactive) {
    return 'not renewed';
  }

  if (prod.renewalStatus) {
    const s = String(prod.renewalStatus).toLowerCase().trim();
    if (['renewed', 'renewald'].includes(s)) return 'renewed';
    if (s === 'yearly renewed') return 'yearly renewed';
    if (s === 'upcoming') return 'upcoming';
    if (['not renewed', 'not_renewal', 'not renewaled', 'expired'].includes(s)) return 'not renewed';
    if (s === 'active') return 'active';
  }

  const endStr = prod.endDate || '';
  if (endStr) {
    const endUTC = parseDateToUTC(endStr);
    const todayUTC = getTodayUTC();
    if (endUTC && endUTC < todayUTC) {
      return 'not renewed';
    }
  }

  return 'active';
};

const runMigration = async () => {
  try {
    const mongoUri = customMongoUri || process.env.OLD_MONGO_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('❌ MONGO_URI is missing from environment variables or arguments.');
      process.exit(1);
    }

    console.log(`🔌 Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    console.log(`✅ Connected successfully to: ${mongoUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')}\n`);

    console.log(`=======================================================`);
    console.log(`MODE: ${isExecute ? '🚀 EXECUTE (Writing directly to Database)' : '🔍 DRY-RUN (Preview Only, No Database Writes)'}`);
    console.log(`Drop Existing Collections: ${isDropExisting ? '⚠️ YES' : 'NO (Idempotent Upsert)'}`);
    console.log(`Clean Legacy Orders Array: ${shouldCleanOldOrders ? '⚠️ YES' : 'NO (Intact)'}`);
    console.log(`Sync Customer Core Fields: ${shouldSyncCustomers ? 'YES' : 'NO'}`);
    console.log(`=======================================================\n`);

    // Unconditionally drop any legacy index on paymentHistory.invoiceNo that lacks proper partialFilterExpression
    try {
      const coll = mongoose.connection.db.collection('customerproducts');
      const existingIndexes = await coll.indexes().catch(() => []);
      for (const idx of existingIndexes) {
        if (idx.name === 'paymentHistory.invoiceNo_1' || (idx.key && idx.key['paymentHistory.invoiceNo'])) {
          console.log(`🔧 Dropping legacy index '${idx.name}' from 'customerproducts'...`);
          await coll.dropIndex(idx.name).catch(() => {});
          console.log(`✅ Legacy index dropped successfully.`);
        }
      }
    } catch (idxErr) {
      // Ignore if collection or index does not exist yet
    }

    // Fetch existing invoice numbers to prevent duplicate key collisions across runs
    const existingInvoices = await CustomerProduct.distinct('paymentHistory.invoiceNo', {
      'paymentHistory.invoiceNo': { $type: 'string', $gt: '' }
    });
    const seenInvoiceNos = new Set(existingInvoices.map(s => String(s).trim()));
    console.log(`📋 Preloaded ${seenInvoiceNos.size} existing invoice numbers to enforce uniqueness.\n`);

    // Use raw MongoDB collection to ensure embedded orders are NEVER stripped by Mongoose schema virtuals
    const rawCustomers = await mongoose.connection.db.collection('customers').find({}).toArray();
    console.log(`📦 Found ${rawCustomers.length} customer records in 'customers' collection.\n`);

    let totalOrdersCount = 0;
    let totalProductsCount = 0;
    let totalRenewalProducts = 0;
    let totalOneTimeProducts = 0;
    let totalPaymentsCount = 0;
    let totalRevenueSum = 0;

    let ordersPaidCount = 0;
    let ordersPartialCount = 0;
    let ordersUnpaidCount = 0;

    const orderBulkOps = [];
    const productBulkOps = [];
    const customerSyncOps = [];

    for (const cust of rawCustomers) {
      const custId = toObjectId(cust._id);

      // Clean customer snapshot details
      const cleanedPhone = cleanArray(cust.phone, false);
      const cleanedEmail = cleanArray(cust.email, true);
      const customerState = cust.state && /tamil/i.test(cust.state) ? 'Tamil Nadu' : (cust.state === 'Other State' ? 'Other State' : 'Tamil Nadu');

      const customerDetails = {
        name: cust.name || '',
        phone: cleanedPhone.length ? cleanedPhone : ['0000000000'],
        email: cleanedEmail.length ? cleanedEmail : ['noemail@customer.com'],
        gstin: String(cust.gstin || '').trim(),
        address: String(cust.address || '-').trim(),
        contactPerson: String(cust.contactPerson || '').trim()
      };

      if (shouldSyncCustomers) {
        customerSyncOps.push({
          updateOne: {
            filter: { _id: custId },
            update: {
              $set: {
                phone: customerDetails.phone,
                email: customerDetails.email,
                state: customerState,
                address: customerDetails.address
              }
            }
          }
        });
      }

      const orders = Array.isArray(cust.orders) ? cust.orders : [];

      for (const ord of orders) {
        totalOrdersCount++;
        const ordId = toObjectId(ord._id);

        const prods = Array.isArray(ord.products) ? ord.products : [];
        const rawPayments = Array.isArray(ord.payments) ? ord.payments : [];

        // Sum payment metrics for this order
        let orderTotalPaid = 0;
        const normalizedPayments = rawPayments.map(p => {
          totalPaymentsCount++;
          const amount = Number(p.amount || 0);
          orderTotalPaid += amount;
          totalRevenueSum += amount;

          let rawInvoiceNo = String(p.invoiceNo || '').trim();
          let finalInvoiceNo = '';
          let note = '';

          if (rawInvoiceNo) {
            if (seenInvoiceNos.has(rawInvoiceNo)) {
              note = `[Ref Inv: ${rawInvoiceNo}]`;
            } else {
              seenInvoiceNos.add(rawInvoiceNo);
              finalInvoiceNo = rawInvoiceNo;
            }
          }

          const desc = [p.description || '', note].filter(Boolean).join(' ').trim();

          const paymentDoc = {
            _id: toObjectId(p._id),
            productId: p.productId ? toObjectId(p.productId) : null,
            date: p.date || (p.createdAt ? new Date(p.createdAt).toISOString().split('T')[0] : (ord.orderDate || new Date().toISOString().split('T')[0])),
            amount,
            withGst: Boolean(p.withGst),
            gstvalue: Number(p.gstvalue || 0),
            paymentStage: normalizePaymentStage(p.paymentStage, amount, ord.totalPrice),
            stageNumber: Number(p.stageNumber || 1),
            description: desc,
            tdsAmount: Number(p.tdsAmount || 0),
            renewalSellingPrice: p.renewalSellingPrice !== undefined && p.renewalSellingPrice !== null ? Number(p.renewalSellingPrice) : null,
            renewalCostPrice: p.renewalCostPrice !== undefined && p.renewalCostPrice !== null ? Number(p.renewalCostPrice) : null,
            createdAt: p.createdAt || ord.createdAt || new Date(),
            updatedAt: p.updatedAt || ord.updatedAt || new Date()
          };
          if (finalInvoiceNo) {
            paymentDoc.invoiceNo = finalInvoiceNo;
          }
          return paymentDoc;
        });

        // Derive Order Payment Status
        const computedOrderStatus = computeOrderPaymentStatus(orderTotalPaid, ord.totalPrice);
        if (computedOrderStatus === 'Fully Paid') ordersPaidCount++;
        else if (computedOrderStatus === 'Partially Paid') ordersPartialCount++;
        else ordersUnpaidCount++;

        // 1. Build Order Document
        const orderDoc = {
          _id: ordId,
          customerId: custId,
          orderDate: ord.orderDate || (cust.createdAt ? new Date(cust.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
          domainUrl: String(ord.domainUrl || '').trim(),
          totalPrice: Number(ord.totalPrice || 0),
          paymentStatus: computedOrderStatus,
          startDate: ord.startDate || '',
          endDate: ord.endDate || '',
          emailSend: Boolean(ord.emailSend),
          expiredEmailSend: Boolean(ord.expiredEmailSend),
          deletionEmailSend: Boolean(ord.deletionEmailSend),
          customerDetails,
          createdAt: ord.createdAt || cust.createdAt || new Date(),
          updatedAt: ord.updatedAt || cust.updatedAt || new Date()
        };

        orderBulkOps.push({
          updateOne: {
            filter: { _id: ordId },
            update: { $set: orderDoc },
            upsert: true
          }
        });

        // 2. Determine payment assignment across products
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
          const prodId = toObjectId(prod._id);

          const computedProductType = determineProductType(prod, ord);
          if (computedProductType === 'Renewal') totalRenewalProducts++;
          else totalOneTimeProducts++;

          const computedRenewalStatus = determineRenewalStatus(prod, computedProductType);

          // Build payment history for this product:
          // Check if product already has paymentHistory, else assign order payments
          let assignedPayments = [];
          if (Array.isArray(prod.paymentHistory) && prod.paymentHistory.length > 0) {
            assignedPayments = prod.paymentHistory.map(p => {
              let rawInv = String(p.invoiceNo || '').trim();
              let finalInv = '';
              let note = '';
              if (rawInv) {
                if (seenInvoiceNos.has(rawInv)) {
                  note = `[Ref Inv: ${rawInv}]`;
                } else {
                  seenInvoiceNos.add(rawInv);
                  finalInv = rawInv;
                }
              }

              const pDoc = {
                _id: toObjectId(p._id),
                date: p.date || (p.createdAt ? new Date(p.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
                amount: Number(p.amount || 0),
                withGst: Boolean(p.withGst),
                gstvalue: Number(p.gstvalue || 0),
                paymentStage: normalizePaymentStage(p.paymentStage, p.amount, prod.price),
                stageNumber: Number(p.stageNumber || 1),
                description: [p.description || '', note].filter(Boolean).join(' ').trim(),
                tdsAmount: Number(p.tdsAmount || 0),
                renewalSellingPrice: p.renewalSellingPrice !== undefined && p.renewalSellingPrice !== null ? Number(p.renewalSellingPrice) : null,
                renewalCostPrice: p.renewalCostPrice !== undefined && p.renewalCostPrice !== null ? Number(p.renewalCostPrice) : null,
                createdAt: p.createdAt || ord.createdAt || new Date(),
                updatedAt: p.updatedAt || ord.updatedAt || new Date()
              };
              if (finalInv) {
                pDoc.invoiceNo = finalInv;
              }
              return pDoc;
            });
          } else {
            // Assign order payments: if single product, or matched by productId, or primary product
            assignedPayments = normalizedPayments.filter(p => {
              if (p.productId) return String(p.productId) === String(prodId);
              return pIdx === primaryProdIdx;
            });
          }

          const latestStage = assignedPayments.length > 0
            ? assignedPayments[assignedPayments.length - 1].paymentStage
            : 'advance';

          // Map Renewal History if present
          const cleanedRenewalHistory = Array.isArray(prod.renewalHistory) ? prod.renewalHistory.map(rh => ({
            _id: toObjectId(rh._id),
            invoiceNo: String(rh.invoiceNo || '').trim(),
            cycleNumber: Number(rh.cycleNumber) || 1,
            startDate: rh.startDate || '',
            endDate: rh.endDate || '',
            totalAmount: Number(rh.totalAmount || 0),
            paidAmount: Number(rh.paidAmount || 0),
            paymentStatus: ['Unpaid', 'Partially Paid', 'Paid'].includes(rh.paymentStatus)
              ? rh.paymentStatus
              : (Number(rh.paidAmount) >= Number(rh.totalAmount) && Number(rh.totalAmount) > 0 ? 'Paid' : (Number(rh.paidAmount) > 0 ? 'Partially Paid' : 'Unpaid')),
            renewalStatus: ['upcoming', 'active', 'complete'].includes(rh.renewalStatus) ? rh.renewalStatus : 'upcoming',
            paymentStages: Array.isArray(rh.paymentStages) ? rh.paymentStages.map(ps => ({
              _id: toObjectId(ps._id),
              payDate: ps.payDate || ps.date || '',
              stage: ['advance', 'mid', 'final', 'full'].includes(ps.stage) ? ps.stage : 'full',
              stageNumber: Number(ps.stageNumber || 1),
              amount: Number(ps.amount || 0),
              withGst: Boolean(ps.withGst),
              gstvalue: Number(ps.gstvalue || 0),
              description: String(ps.description || '')
            })) : []
          })) : [];

          // 3. Build CustomerProduct Document
          const productDoc = {
            _id: prodId,
            orderId: ordId,
            customerId: custId,
            customerDetails,
            domainUrl: String(prod.domainUrl || ord.domainUrl || '').trim(),
            product: String(prod.product || 'General Product').trim(),
            variant: String(prod.variant || 'Standard').trim(),
            price: Number(prod.price || 0),
            costPrice: Number(prod.costPrice || 0),
            quantity: Number(prod.quantity || 1),
            productType: computedProductType,
            billingCycle: ['yearly', 'monthly'].includes(String(prod.billingCycle || ord.billingCycle).toLowerCase())
              ? String(prod.billingCycle || ord.billingCycle).toLowerCase()
              : 'yearly',
            cycleCount: Number(prod.cycleCount) || 1,
            paymentStage: latestStage,
            startDate: prod.startDate || ord.startDate || '',
            endDate: prod.endDate || ord.endDate || '',
            sellerPriceRenewal: prod.sellerPriceRenewal !== undefined && prod.sellerPriceRenewal !== null ? Number(prod.sellerPriceRenewal) : null,
            costPriceRenewal: prod.costPriceRenewal !== undefined && prod.costPriceRenewal !== null ? Number(prod.costPriceRenewal) : null,
            validationEnabled: Boolean(prod.validationEnabled),
            oneTimePayment: Boolean(prod.oneTimePayment),
            reminder: Array.isArray(prod.reminder) ? prod.reminder : [],
            deactive: Boolean(prod.deactive),
            deactiveYear: prod.deactiveYear || '',
            deactiveDate: prod.deactiveDate || '',
            renewalStatus: computedRenewalStatus,
            renewalHistory: cleanedRenewalHistory,
            paymentHistory: assignedPayments,
            createdAt: prod.createdAt || ord.createdAt || cust.createdAt || new Date(),
            updatedAt: prod.updatedAt || ord.updatedAt || cust.updatedAt || new Date()
          };

          productBulkOps.push({
            updateOne: {
              filter: { _id: prodId },
              update: { $set: productDoc },
              upsert: true
            }
          });
        });
      }
    }

    console.log(`📊 Migration Audit Statistics:`);
    console.log(`-------------------------------------------------------`);
    console.log(`  Total Customers Audited:     ${rawCustomers.length}`);
    console.log(`  Total Orders Prepared:       ${totalOrdersCount}`);
    console.log(`    - Fully Paid Orders:       ${ordersPaidCount}`);
    console.log(`    - Partially Paid Orders:   ${ordersPartialCount}`);
    console.log(`    - Unpaid Orders:           ${ordersUnpaidCount}`);
    console.log(`  Total Products Prepared:     ${totalProductsCount}`);
    console.log(`    - Renewal Products:        ${totalRenewalProducts}`);
    console.log(`    - OneTime Products:        ${totalOneTimeProducts}`);
    console.log(`  Total Payments Mapped:       ${totalPaymentsCount}`);
    console.log(`  Total Revenue Sum:           ₹${totalRevenueSum.toLocaleString('en-IN')}`);
    console.log(`-------------------------------------------------------\n`);

    if (isExecute) {
      if (isDropExisting) {
        console.log(`⚠️  --drop-existing specified. Dropping target collections...`);
        await Order.deleteMany({});
        await CustomerProduct.deleteMany({});
        console.log(`✅ Target collections cleared.\n`);
      }

      const BATCH_SIZE = 500;

      // 1. Bulk Write Orders
      console.log(`⏳ Executing bulkWrite on 'orders' collection (${orderBulkOps.length} ops)...`);
      for (let i = 0; i < orderBulkOps.length; i += BATCH_SIZE) {
        const batch = orderBulkOps.slice(i, i + BATCH_SIZE);
        await mongoose.connection.db.collection('orders').bulkWrite(batch, { ordered: false });
      }
      console.log(`✅ 'orders' collection updated successfully.\n`);

      // 2. Bulk Write CustomerProducts
      console.log(`⏳ Executing bulkWrite on 'customerproducts' collection (${productBulkOps.length} ops)...`);
      for (let i = 0; i < productBulkOps.length; i += BATCH_SIZE) {
        const batch = productBulkOps.slice(i, i + BATCH_SIZE);
        await mongoose.connection.db.collection('customerproducts').bulkWrite(batch, { ordered: false });
      }
      console.log(`✅ 'customerproducts' collection updated successfully.\n`);

      // 2b. Recreate proper partial index for invoiceNo (ignores empty string invoices)
      try {
        await mongoose.connection.db.collection('customerproducts').createIndex(
          { 'paymentHistory.invoiceNo': 1 },
          {
            unique: true,
            partialFilterExpression: { 'paymentHistory.invoiceNo': { $type: 'string', $gt: '' } },
            background: true
          }
        );
        console.log(`✅ Partial unique index on 'paymentHistory.invoiceNo' registered.\n`);
      } catch (idxErr) {
        console.warn(`Index notice: ${idxErr.message}`);
      }

      // 3. Optional: Sync Customer core fields
      if (customerSyncOps.length > 0) {
        console.log(`⏳ Synchronizing Customer core fields (${customerSyncOps.length} ops)...`);
        for (let i = 0; i < customerSyncOps.length; i += BATCH_SIZE) {
          const batch = customerSyncOps.slice(i, i + BATCH_SIZE);
          await mongoose.connection.db.collection('customers').bulkWrite(batch, { ordered: false });
        }
        console.log(`✅ 'customers' collection synchronized.\n`);
      }

      // 4. Optional: Clean legacy embedded orders
      if (shouldCleanOldOrders) {
        console.log(`🧹 Removing legacy embedded 'orders' array from 'customers' collection...`);
        const cleanRes = await mongoose.connection.db.collection('customers').updateMany(
          { orders: { $exists: true } },
          { $unset: { orders: '' } }
        );
        console.log(`✅ Cleaned legacy 'orders' array from ${cleanRes.modifiedCount} customer documents.\n`);
      } else {
        console.log(`ℹ️ Original 'Customer' documents remain intact. (Pass --clean-orders to remove embedded orders)`);
      }

      // 5. Optional: Drop Unwanted & Temporary Collections
      if (shouldDropUnwanted) {
        console.log(`🧹 Inspecting database for unwanted / temporary collections...`);
        const allDbColls = await mongoose.connection.db.listCollections().toArray();
        let droppedCount = 0;
        for (const col of allDbColls) {
          const colName = col.name;
          if (colName.startsWith('system.')) continue;
          const isBackup = colName.includes('backup') || colName.includes('old') || colName.includes('temp');
          const isLegacyUnused = ['categories', 'invoices', 'invoicesequences'].includes(colName);
          if (isBackup || isLegacyUnused || !ACTIVE_COLLECTIONS.has(colName)) {
            try {
              await mongoose.connection.db.collection(colName).drop();
              console.log(`🗑️ Dropped unwanted collection: '${colName}'`);
              droppedCount++;
            } catch (dropErr) {
              console.warn(`Could not drop '${colName}': ${dropErr.message}`);
            }
          }
        }
        console.log(`✅ ${droppedCount} unwanted collections cleaned successfully.\n`);
      }

      console.log(`🎉 MIGRATION COMPLETED SUCCESSFULLY!`);
      console.log(`\n📢 IMPORTANT COMPASS NOTE:`);
      console.log(`In MongoDB Compass, click the 🔄 Refresh button at the top of the collections list to see the changes!`);
    } else {
      console.log(`💡 DRY-RUN FINISHED.`);
      if (shouldDropUnwanted) {
        console.log(`🔍 [Preview] Unwanted collections detected that will be dropped with --execute:`);
        const allDbColls = await mongoose.connection.db.listCollections().toArray();
        for (const col of allDbColls) {
          const colName = col.name;
          const isBackup = colName.includes('backup') || colName.includes('old') || colName.includes('temp');
          const isLegacyUnused = ['categories', 'invoices', 'invoicesequences'].includes(colName);
          if (isBackup || isLegacyUnused || !ACTIVE_COLLECTIONS.has(colName)) {
            console.log(`   - ${colName}`);
          }
        }
        console.log('');
      }
      console.log(`To write these changes to the database, run:`);
      console.log(`  node backend/scripts/migrateTo3Collections.js --execute`);
      console.log(`Optional flags:`);
      console.log(`  --clean-orders     Remove legacy 'orders' array from 'customers' collection`);
      console.log(`  --drop-unwanted    Drop unused collections (backups, categories, invoices, etc.)`);
      console.log(`  --drop-existing    Clear existing 'orders' and 'customerproducts' before migration`);
      console.log(`  --sync-customers   Normalize phone/email arrays and state on 'customers' collection`);
      console.log(`  --source=<uri>     Migrate from a separate source MongoDB URI\n`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration Error:', error);
    process.exit(1);
  }
};

runMigration();

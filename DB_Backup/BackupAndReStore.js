const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Import Active Billing Database Models (New 3-Collection Structure)
const Admin = require('../models/Admin');
const AutoReminderSettings = require('../models/AutoReminderSettings');
const Customer = require('../models/Customer');
const CustomerProduct = require('../models/CustomerProduct');
const Order = require('../models/Order');
const Expenses = require('../models/Expenses');
const GstSetting = require('../models/GstSetting');
const Product = require('../models/Product');
const Proforma = require('../models/Proforma');
const SMTPSetting = require('../models/SMTPSetting');
const Template = require('../models/Template');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const HISTORY_FILE = path.join(BACKUP_DIR, 'backup_history.json');
const MAX_HISTORY_ENTRIES = 200;

/**
 * Single Source of Truth: Collection Registry for Backup & Restore (3-Collection Structure)
 */
const COLLECTIONS_CONFIG = [
  // Settings & Templates
  { key: 'admins', model: Admin, name: 'Admin', isCore: false },
  { key: 'autoReminderSettings', model: AutoReminderSettings, name: 'AutoReminderSettings', isCore: false },
  { key: 'gstSettings', model: GstSetting, name: 'GstSetting', isCore: false },
  { key: 'smtpSettings', model: SMTPSetting, name: 'SMTPSetting', isCore: false },
  { key: 'templates', model: Template, name: 'Template', isCore: false },
  // Core Business Data (3-Collection Architecture)
  { key: 'customers', model: Customer, name: 'Customer', isCore: true },
  { key: 'orders', model: Order, name: 'Order', isCore: true },
  { key: 'customerProducts', model: CustomerProduct, name: 'CustomerProduct', isCore: true },
  { key: 'products', model: Product, name: 'Product', isCore: true },
  { key: 'proformas', model: Proforma, name: 'Proforma', isCore: true },
  // Financial Records
  { key: 'expenses', model: Expenses, name: 'Expenses', isCore: false }
];

/**
 * Ensure backup directory exists
 */
const ensureBackupDir = () => {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
};

/**
 * Standard timestamp generator (e.g. 2026-11-18T09-22-30-123Z)
 */
const getTimestampString = (date = new Date()) => {
  return date.toISOString().replace(/[:.]/g, '-');
};

/**
 * Format bytes to readable string (e.g. 1.25 MB)
 */
const formatBytes = (bytes, decimals = 2) => {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

/**
 * Read Backup History Log from disk
 */
const getBackupHistory = () => {
  ensureBackupDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('⚠️ [BackupHistory] Could not read history file:', err.message);
    return [];
  }
};

/**
 * Append a new event entry to Backup History Log
 */
const recordBackupHistory = (entry) => {
  try {
    ensureBackupDir();
    const history = getBackupHistory();
    const newEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      version: '3.0',
      structure: '3-collections',
      ...entry
    };
    history.unshift(newEntry);
    const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
    return newEntry;
  } catch (err) {
    console.warn('⚠️ [BackupHistory] Failed to record history entry:', err.message);
    return null;
  }
};

/**
 * Securely resolve a filename within the backup directory.
 * Prevents directory traversal attacks.
 */
const resolveBackupFile = (filename) => {
  if (!filename || typeof filename !== 'string') return null;
  const safeFilename = path.basename(filename);
  if (safeFilename === path.basename(HISTORY_FILE)) return null;
  const targetPath = path.join(BACKUP_DIR, safeFilename);
  return {
    safeFilename,
    targetPath,
    exists: fs.existsSync(targetPath)
  };
};

/**
 * Export Entire Database to a JSON snapshot (New 3-Collection Structure)
 * Saves a copy in backend/backups, updates backup history, and returns the data object
 * @param {Object} options - { prefix: string }
 */
const exportFullDatabase = async (options = {}) => {
  ensureBackupDir();
  const prefix = options.prefix || 'backup';

  console.log('🔄 [BackupEngine] Gathering full database collections (3-collection structure)...');

  const queryPromises = COLLECTIONS_CONFIG.map(async ({ key, model }) => {
    const records = await model.find({}).lean();
    return { key, records };
  });

  const queryResults = await Promise.all(queryPromises);

  const stats = {};
  let totalRecords = 0;
  const exportedAt = new Date().toISOString();

  const backupData = {
    appName: 'JayamBillings',
    version: '3.0',
    structure: '3-collections',
    exportedAt,
    stats
  };

  for (const { key, records } of queryResults) {
    backupData[key] = records;
    stats[key] = records.length;
    totalRecords += records.length;
  }

  const filename = `${prefix}_${getTimestampString()}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(backupData), 'utf-8');
  const fileStat = fs.statSync(filepath);
  const fileSizeFormatted = formatBytes(fileStat.size);

  // Record in persistent backup history
  recordBackupHistory({
    action: prefix === 'pre_restore_safety' ? 'pre_restore_safety' : 'backup',
    filename,
    status: 'success',
    fileSize: fileStat.size,
    fileSizeFormatted,
    totalRecords,
    stats,
    exportedAt
  });

  console.log(`✅ [BackupEngine] Full database backup created: ${filename} (${fileSizeFormatted}, ${totalRecords} records)`);
  return {
    success: true,
    filename,
    filepath,
    fileSize: fileStat.size,
    fileSizeFormatted,
    exportedAt,
    totalRecords,
    stats,
    data: backupData
  };
};

/**
 * Helper: Convert legacy embedded customer.orders backup into 3-collection arrays
 */
const normalizeLegacyBackupData = (backupData) => {
  const hasNewStructure = Array.isArray(backupData.orders) || Array.isArray(backupData.customerProducts);
  if (hasNewStructure || !Array.isArray(backupData.customers)) {
    return backupData;
  }

  const hasEmbeddedOrders = backupData.customers.some(c => Array.isArray(c.orders) && c.orders.length > 0);
  if (!hasEmbeddedOrders) {
    return backupData;
  }

  console.log('🔄 [BackupEngine] Detected legacy embedded backup format. Converting to 3-collection structure...');
  const convertedOrders = [];
  const convertedProducts = [];
  const cleanedCustomers = [];

  for (const cust of backupData.customers) {
    const { orders = [], ...custCore } = cust;
    cleanedCustomers.push(custCore);

    const customerDetails = {
      name: cust.name || '',
      phone: Array.isArray(cust.phone) ? cust.phone : (cust.phone ? [cust.phone] : []),
      email: Array.isArray(cust.email) ? cust.email : (cust.email ? [cust.email] : []),
      gstin: cust.gstin || '',
      address: cust.address || '',
      contactPerson: cust.contactPerson || ''
    };

    for (const ord of orders) {
      const ordId = ord._id || new mongoose.Types.ObjectId();
      const rawPayments = Array.isArray(ord.payments) ? ord.payments : [];
      const totalPaid = rawPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const totalPrice = Number(ord.totalPrice || 0);

      let paymentStatus = 'Unpaid';
      if (totalPaid > 0) {
        paymentStatus = totalPrice > 0 && totalPaid >= totalPrice ? 'Fully Paid' : 'Partially Paid';
      }

      convertedOrders.push({
        _id: ordId,
        customerId: cust._id,
        orderDate: ord.orderDate || (cust.createdAt ? new Date(cust.createdAt).toISOString().split('T')[0] : ''),
        domainUrl: ord.domainUrl || '',
        totalPrice,
        paymentStatus,
        startDate: ord.startDate || '',
        endDate: ord.endDate || '',
        emailSend: Boolean(ord.emailSend),
        expiredEmailSend: Boolean(ord.expiredEmailSend),
        deletionEmailSend: Boolean(ord.deletionEmailSend),
        customerDetails,
        createdAt: ord.createdAt || cust.createdAt || new Date(),
        updatedAt: ord.updatedAt || cust.updatedAt || new Date()
      });

      const prods = Array.isArray(ord.products) ? ord.products : [];
      prods.forEach((prod, idx) => {
        const isRenewal = !prod.oneTimePayment && (
          Boolean(prod.validationEnabled) ||
          Number(prod.sellerPriceRenewal || 0) > 0 ||
          Boolean(prod.endDate && String(prod.endDate).trim())
        );

        const assignedPayments = Array.isArray(prod.paymentHistory) && prod.paymentHistory.length > 0
          ? prod.paymentHistory
          : (idx === 0 ? rawPayments.map(p => {
              const entry = {
                _id: p._id || new mongoose.Types.ObjectId(),
                date: p.date || ord.orderDate || '',
                amount: Number(p.amount || 0),
                withGst: Boolean(p.withGst),
                gstvalue: Number(p.gstvalue || 0),
                paymentStage: ['advance', 'mid', 'final', 'full'].includes(p.paymentStage) ? p.paymentStage : 'full',
                stageNumber: Number(p.stageNumber || 1),
                description: p.description || '',
                tdsAmount: Number(p.tdsAmount || 0)
              };
              if (p.invoiceNo && String(p.invoiceNo).trim()) {
                entry.invoiceNo = String(p.invoiceNo).trim();
              }
              return entry;
            }) : []);

        convertedProducts.push({
          _id: prod._id || new mongoose.Types.ObjectId(),
          orderId: ordId,
          customerId: cust._id,
          customerDetails,
          domainUrl: prod.domainUrl || ord.domainUrl || '',
          product: prod.product || 'General Product',
          variant: prod.variant || 'Standard',
          price: Number(prod.price || 0),
          costPrice: Number(prod.costPrice || 0),
          quantity: Number(prod.quantity || 1),
          productType: isRenewal ? 'Renewal' : 'OneTime',
          billingCycle: ['yearly', 'monthly'].includes(prod.billingCycle) ? prod.billingCycle : 'yearly',
          cycleCount: Number(prod.cycleCount || 1),
          startDate: prod.startDate || ord.startDate || '',
          endDate: prod.endDate || ord.endDate || '',
          sellerPriceRenewal: prod.sellerPriceRenewal ?? null,
          costPriceRenewal: prod.costPriceRenewal ?? null,
          validationEnabled: Boolean(prod.validationEnabled),
          oneTimePayment: Boolean(prod.oneTimePayment),
          deactive: Boolean(prod.deactive),
          deactiveYear: prod.deactiveYear || '',
          deactiveDate: prod.deactiveDate || '',
          renewalStatus: prod.deactive ? 'not renewed' : 'active',
          renewalHistory: Array.isArray(prod.renewalHistory) ? prod.renewalHistory : [],
          paymentHistory: assignedPayments,
          createdAt: prod.createdAt || ord.createdAt || new Date(),
          updatedAt: prod.updatedAt || ord.updatedAt || new Date()
        });
      });
    }
  }

  return {
    ...backupData,
    customers: cleanedCustomers,
    orders: convertedOrders,
    customerProducts: convertedProducts
  };
};

/**
 * Helper: Cast string ObjectIds and Dates on CustomerProduct documents before native insertMany
 */
const toOid = (val) => {
  if (!val) return val;
  if (val instanceof mongoose.Types.ObjectId) return val;
  if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val)) {
    return new mongoose.Types.ObjectId(val);
  }
  return val;
};

const toDateVal = (val) => {
  if (!val) return val;
  if (val instanceof Date) return val;
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return val;
};

const castCustomerProductDoc = (doc) => {
  const out = { ...doc };
  if (out._id) out._id = toOid(out._id);
  if (out.orderId) out.orderId = toOid(out.orderId);
  if (out.customerId) out.customerId = toOid(out.customerId);
  if (out.createdAt) out.createdAt = toDateVal(out.createdAt);
  if (out.updatedAt) out.updatedAt = toDateVal(out.updatedAt);

  if (Array.isArray(out.paymentHistory)) {
    out.paymentHistory = out.paymentHistory.map((p) => {
      const pOut = { ...p };
      if (pOut._id) pOut._id = toOid(pOut._id);
      if (pOut.createdAt) pOut.createdAt = toDateVal(pOut.createdAt);
      if (pOut.updatedAt) pOut.updatedAt = toDateVal(pOut.updatedAt);
      if (pOut.invoiceNo === '' || pOut.invoiceNo === null) {
        delete pOut.invoiceNo;
      }
      return pOut;
    });
  }

  if (Array.isArray(out.renewalHistory)) {
    out.renewalHistory = out.renewalHistory.map((rh) => {
      const rOut = { ...rh };
      if (rOut._id) rOut._id = toOid(rOut._id);
      if (rOut.createdAt) rOut.createdAt = toDateVal(rOut.createdAt);
      if (rOut.updatedAt) rOut.updatedAt = toDateVal(rOut.updatedAt);
      if (Array.isArray(rOut.paymentStages)) {
        rOut.paymentStages = rOut.paymentStages.map((ps) => ({
          ...ps,
          _id: ps._id ? toOid(ps._id) : ps._id
        }));
      }
      return rOut;
    });
  }

  if (Array.isArray(out.reminder)) {
    out.reminder = out.reminder.map((rem) => ({
      ...rem,
      _id: rem._id ? toOid(rem._id) : rem._id
    }));
  }

  return out;
};

/**
 * Import and Restore Entire Database from a JSON snapshot
 * Includes automatic safety snapshot before restoring and history tracking.
 */
const importFullDatabase = async (rawBackupData, options = {}) => {
  if (!rawBackupData || typeof rawBackupData !== 'object') {
    throw new Error('Invalid backup file: Not a valid JSON object.');
  }

  // Validate core collections from registry
  const coreCollections = COLLECTIONS_CONFIG.filter(c => c.isCore);
  const hasCore = coreCollections.some(c => Array.isArray(rawBackupData[c.key]));

  if (!hasCore) {
    throw new Error('Invalid backup file structure: Missing core billing collections (customers, orders, customerProducts).');
  }

  const backupData = normalizeLegacyBackupData(rawBackupData);

  // SAFETY NET: Automatically create a pre-restore backup before wiping/restoring
  if (!options.skipPreBackup) {
    try {
      console.log('🛡️ [BackupEngine] Creating pre-restore safety snapshot...');
      await exportFullDatabase({ prefix: 'pre_restore_safety' });
    } catch (preBackupErr) {
      console.warn('⚠️ [BackupEngine] Could not create pre-restore snapshot, proceeding:', preBackupErr.message);
    }
  }

  console.log('⚠️ [BackupEngine] Starting database restoration...');
  const restoredCounts = {};
  let totalRestored = 0;

  try {
    // Sequentially restore each collection from the registry
    for (const { key, model, name } of COLLECTIONS_CONFIG) {
      if (backupData[key] && Array.isArray(backupData[key])) {
        await model.deleteMany({});
        if (backupData[key].length > 0) {
          // Use native collection insertMany for CustomerProduct (cast ObjectIds/Dates & avoid empty invoiceNo collisions)
          if (key === 'customerProducts') {
            const castedDocs = backupData[key].map(castCustomerProductDoc);
            await model.collection.insertMany(castedDocs, { ordered: false });
          } else {
            await model.insertMany(backupData[key], { ordered: false });
          }
        }
        restoredCounts[key] = backupData[key].length;
        totalRestored += backupData[key].length;
        console.log(`   ✔ Restored ${name}: ${backupData[key].length} records`);
      }
    }

    const restoredAt = new Date().toISOString();

    recordBackupHistory({
      action: 'restore',
      filename: options.filename || 'uploaded_or_cli_restore',
      status: 'success',
      sourceVersion: rawBackupData.version || '1.0',
      totalRecords: totalRestored,
      stats: restoredCounts,
      restoredAt
    });

    console.log('✅ [BackupEngine] Full database restored successfully!');
    return {
      success: true,
      message: 'Database restored successfully',
      restoredCounts,
      totalRestored,
      restoredAt
    };
  } catch (err) {
    recordBackupHistory({
      action: 'restore',
      filename: options.filename || 'uploaded_or_cli_restore',
      status: 'failed',
      error: err.message
    });
    throw err;
  }
};

/**
 * List all backup files in backend/backups directory enriched with metadata & history
 */
const listServerBackups = () => {
  ensureBackupDir();
  const historyName = path.basename(HISTORY_FILE);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json') && f !== historyName);

  const history = getBackupHistory();
  const historyByFile = new Map();
  for (const h of history) {
    if (h.filename && !historyByFile.has(h.filename)) {
      historyByFile.set(h.filename, h);
    }
  }

  const backups = files.map(file => {
    const fullPath = path.join(BACKUP_DIR, file);
    const stat = fs.statSync(fullPath);
    const histEntry = historyByFile.get(file);

    let type = 'manual';
    if (file.startsWith('pre_restore_safety_')) type = 'pre_restore_safety';
    else if (file.startsWith('uploaded_')) type = 'uploaded';

    return {
      filename: file,
      size: stat.size,
      sizeFormatted: formatBytes(stat.size),
      createdAt: stat.birthtime || stat.mtime,
      type,
      version: histEntry?.version || null,
      structure: histEntry?.structure || null,
      totalRecords: histEntry?.totalRecords ?? null,
      stats: histEntry?.stats || null
    };
  });

  // Sort newest first
  backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return backups;
};

// Standalone CLI runner support (e.g. node BackupAndReStore.js --backup)
if (require.main === module) {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  const connectDB = require('../config/db');

  const runCLI = async () => {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
      if (command === '--history' || command === '-h') {
        const history = getBackupHistory();
        console.log(`📜 Backup & Restore History (${history.length} entries):`);
        console.log(JSON.stringify(history.slice(0, 20), null, 2));
        process.exit(0);
      }

      await connectDB();

      if (command === '--backup' || command === '-b') {
        const result = await exportFullDatabase();
        console.log(`Backup saved to ${result.filepath}`);
      } else if (command === '--import' || command === '-i') {
        const target = args[1];
        if (!target) {
          console.error('Please specify the backup filename or path: node BackupAndReStore.js -i <filename>');
          process.exit(1);
        }
        let fullPath = target;
        if (!fs.existsSync(fullPath)) {
          fullPath = path.join(BACKUP_DIR, target);
        }
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        await importFullDatabase(data, { filename: path.basename(fullPath) });
      } else if (command === '--fix-ids') {
        const rawDocs = await CustomerProduct.collection.find({}).toArray();
        if (rawDocs.length === 0) {
          console.log('No customerproducts found to fix.');
        } else {
          const casted = rawDocs.map(castCustomerProductDoc);
          await CustomerProduct.collection.deleteMany({});
          await CustomerProduct.collection.insertMany(casted, { ordered: false });
          console.log(`✅ Fixed ObjectIds & Dates on ${casted.length} customerproducts records!`);
        }
      } else {
        console.log(`
Usage:
  node BackupAndReStore.js --backup            (or -b)
  node BackupAndReStore.js --import <filename> (or -i)
  node BackupAndReStore.js --history           (or -h)
  node BackupAndReStore.js --fix-ids           (Convert string IDs to ObjectId in customerproducts)
        `);
      }
    } catch (err) {
      console.error('Error:', err.message);
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
      process.exit(0);
    }
  };

  runCLI();
}

module.exports = {
  exportFullDatabase,
  importFullDatabase,
  listServerBackups,
  getBackupHistory,
  recordBackupHistory,
  resolveBackupFile,
  getTimestampString,
  formatBytes,
  BACKUP_DIR,
  HISTORY_FILE,
  COLLECTIONS_CONFIG
};

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Import All 13 Billing Database Models
const Admin = require('../models/Admin');
const AutoReminderSettings = require('../models/AutoReminderSettings');
const Customer = require('../models/Customer');
const CustomerProduct = require('../models/CustomerProduct');
const Order = require('../models/Order');
const Expenses = require('../models/Expenses');
const GstSetting = require('../models/GstSetting');
const PaymentConfirmationSetting = require('../models/PaymentConfirmationSetting');
const Product = require('../models/Product');
const Proforma = require('../models/Proforma');
const RevenueExpense = require('../models/RevenueExpense');
const SMTPSetting = require('../models/SMTPSetting');
const Template = require('../models/Template');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

/**
 * Single Source of Truth: Collection Registry for Backup & Restore
 */
const COLLECTIONS_CONFIG = [
  // Settings & Sequences
  { key: 'admins', model: Admin, name: 'Admin', isCore: false },
  { key: 'autoReminderSettings', model: AutoReminderSettings, name: 'AutoReminderSettings', isCore: false },
  { key: 'gstSettings', model: GstSetting, name: 'GstSetting', isCore: false },
  { key: 'smtpSettings', model: SMTPSetting, name: 'SMTPSetting', isCore: false },
  { key: 'paymentConfirmationSettings', model: PaymentConfirmationSetting, name: 'PaymentConfirmationSetting', isCore: false },
  { key: 'templates', model: Template, name: 'Template', isCore: false },
  // Business Data
  { key: 'customers', model: Customer, name: 'Customer', isCore: true },
  { key: 'customerProducts', model: CustomerProduct, name: 'CustomerProduct', isCore: true },
  { key: 'orders', model: Order, name: 'Order', isCore: true },
  { key: 'products', model: Product, name: 'Product', isCore: true },
  { key: 'proformas', model: Proforma, name: 'Proforma', isCore: true },
  { key: 'expenses', model: Expenses, name: 'Expenses', isCore: false },
  { key: 'revenueExpenses', model: RevenueExpense, name: 'RevenueExpense', isCore: false }
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
 * Securely resolve a filename within the backup directory.
 * Prevents directory traversal attacks.
 */
const resolveBackupFile = (filename) => {
  if (!filename || typeof filename !== 'string') return null;
  const safeFilename = path.basename(filename);
  const targetPath = path.join(BACKUP_DIR, safeFilename);
  return {
    safeFilename,
    targetPath,
    exists: fs.existsSync(targetPath)
  };
};

/**
 * Export Entire Database to a JSON snapshot
 * Saves a copy in backend/backups and returns the data object
 * @param {Object} options - { prefix: string, isPreRestore: boolean }
 */
const exportFullDatabase = async (options = {}) => {
  ensureBackupDir();
  const prefix = options.prefix || 'backup';

  console.log('🔄 [BackupEngine] Gathering full database collections...');

  // Query all collections concurrently using the registry
  const queryPromises = COLLECTIONS_CONFIG.map(async ({ key, model }) => {
    const records = await model.find({}).lean();
    return { key, records };
  });

  const queryResults = await Promise.all(queryPromises);

  const stats = {};
  const backupData = {
    appName: 'JayamBillings',
    version: '2.0',
    exportedAt: new Date().toISOString(),
    stats
  };

  for (const { key, records } of queryResults) {
    backupData[key] = records;
    stats[key] = records.length;
  }

  const filename = `${prefix}_${getTimestampString()}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  // Write compact JSON to optimize disk space and I/O performance
  fs.writeFileSync(filepath, JSON.stringify(backupData), 'utf-8');
  const fileStat = fs.statSync(filepath);

  console.log(`✅ [BackupEngine] Full database backup created: ${filename} (${formatBytes(fileStat.size)})`);
  return {
    success: true,
    filename,
    filepath,
    fileSize: fileStat.size,
    fileSizeFormatted: formatBytes(fileStat.size),
    exportedAt: backupData.exportedAt,
    stats,
    data: backupData
  };
};

/**
 * Import and Restore Entire Database from a JSON snapshot
 * Includes automatic safety snapshot before restoring.
 */
const importFullDatabase = async (backupData, options = {}) => {
  if (!backupData || typeof backupData !== 'object') {
    throw new Error('Invalid backup file: Not a valid JSON object.');
  }

  // Validate core collections from registry
  const coreCollections = COLLECTIONS_CONFIG.filter(c => c.isCore);
  const hasCore = coreCollections.some(c => Array.isArray(backupData[c.key]));

  if (!hasCore) {
    throw new Error('Invalid backup file structure: Missing core billing collections (customers, products, customerProducts).');
  }

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

  // Sequentially restore each collection from the registry
  for (const { key, model, name } of COLLECTIONS_CONFIG) {
    if (backupData[key] && Array.isArray(backupData[key])) {
      await model.deleteMany({});
      if (backupData[key].length > 0) {
        await model.insertMany(backupData[key]);
      }
      restoredCounts[key] = backupData[key].length;
      console.log(`   ✔ Restored ${name}: ${backupData[key].length} records`);
    }
  }

  console.log('✅ [BackupEngine] Full database restored successfully!');
  return {
    success: true,
    message: 'Database restored successfully',
    restoredCounts,
    restoredAt: new Date().toISOString()
  };
};

/**
 * List all backup files in backend/backups directory
 */
const listServerBackups = () => {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));

  const backups = files.map(file => {
    const fullPath = path.join(BACKUP_DIR, file);
    const stat = fs.statSync(fullPath);
    return {
      filename: file,
      size: stat.size,
      sizeFormatted: formatBytes(stat.size),
      createdAt: stat.birthtime || stat.mtime
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
        await importFullDatabase(data);
      } else {
        console.log(`
Usage:
  node BackupAndReStore.js --backup     (or -b)
  node BackupAndReStore.js --import <filename> (or -i)
        `);
      }
    } catch (err) {
      console.error('Error:', err.message);
    } finally {
      await mongoose.disconnect();
      process.exit(0);
    }
  };

  runCLI();
}

module.exports = {
  exportFullDatabase,
  importFullDatabase,
  listServerBackups,
  resolveBackupFile,
  getTimestampString,
  formatBytes,
  BACKUP_DIR,
  COLLECTIONS_CONFIG
};

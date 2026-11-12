const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const connectDB = require('./config/db');

// Import Models
const Admin = require('./models/Admin');
const AutoReminderSettings = require('./models/AutoReminderSettings');
const Customer = require('./models/Customer');
const GstSetting = require('./models/GstSetting');
const Invoice = require('./models/Invoice');
const Product = require('./models/Product');
const RevenueExpense = require('./models/RevenueExpense');
const SMTPSetting = require('./models/SMTPSetting');
const Template = require('./models/Template');

const BACKUP_DIR = path.join(__dirname, 'backups');

const ensureBackupDir = () => {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
};

const backup = async () => {
  console.log('🔄 Starting database backup...');
  try {
    ensureBackupDir();
    
    const backupData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      admins: await Admin.find({}).lean(),
      autoReminderSettings: await AutoReminderSettings.find({}).lean(),
      customers: await Customer.find({}).lean(),
      gstSettings: await GstSetting.find({}).lean(),
      invoices: await Invoice.find({}).lean(),
      products: await Product.find({}).lean(),
      revenueExpenses: await RevenueExpense.find({}).lean(),
      smtpSettings: await SMTPSetting.find({}).lean(),
      templates: await Template.find({}).lean(),
    };

    const filename = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(BACKUP_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2), 'utf-8');
    console.log(`✅ Backup successfully saved to: ${filepath}`);
    console.log(`📊 Statistics:`);
    console.log(`   - Admins: ${backupData.admins.length}`);
    console.log(`   - Customers: ${backupData.customers.length}`);
    console.log(`   - Products: ${backupData.products.length}`);
    console.log(`   - Invoices: ${backupData.invoices.length}`);
    console.log(`   - Revenue & Expenses: ${backupData.revenueExpenses.length}`);
    console.log(`   - Templates: ${backupData.templates.length}`);
  } catch (error) {
    console.error('❌ Backup failed:', error);
  }
};

const restore = async (filename) => {
  if (!filename) {
    console.error('❌ Error: Please specify the backup filename or path to restore.');
    console.log('Usage: node dbBackupRestore.js --import <filename_or_path>');
    return;
  }

  let filepath = filename;
  if (!fs.existsSync(filepath)) {
    // Try in backups folder
    filepath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.error(`❌ Error: Backup file not found at "${filename}" or "${filepath}"`);
      return;
    }
  }

  console.log(`🔄 Reading backup file from: ${filepath}...`);
  try {
    const rawData = fs.readFileSync(filepath, 'utf-8');
    const backupData = JSON.parse(rawData);

    if (!backupData || typeof backupData !== 'object') {
      throw new Error('Invalid JSON format');
    }

    if (!backupData.customers && !backupData.products && !backupData.templates) {
      throw new Error('Invalid backup file structure: Missing critical collections');
    }

    console.log('⚠️ WARNING: This will overwrite your existing database records! Starting import...');

    // 1. AutoReminderSettings
    if (backupData.autoReminderSettings && Array.isArray(backupData.autoReminderSettings)) {
      await AutoReminderSettings.deleteMany({});
      if (backupData.autoReminderSettings.length > 0) {
        await AutoReminderSettings.insertMany(backupData.autoReminderSettings);
        console.log(`   - AutoReminderSettings restored: ${backupData.autoReminderSettings.length}`);
      }
    }

    // 2. GstSettings
    if (backupData.gstSettings && Array.isArray(backupData.gstSettings)) {
      await GstSetting.deleteMany({});
      if (backupData.gstSettings.length > 0) {
        await GstSetting.insertMany(backupData.gstSettings);
        console.log(`   - GstSettings restored: ${backupData.gstSettings.length}`);
      }
    }

    // 3. SMTPSetting
    if (backupData.smtpSettings && Array.isArray(backupData.smtpSettings)) {
      await SMTPSetting.deleteMany({});
      if (backupData.smtpSettings.length > 0) {
        await SMTPSetting.insertMany(backupData.smtpSettings);
        console.log(`   - SMTPSetting restored: ${backupData.smtpSettings.length}`);
      }
    }

    // 4. Templates
    if (backupData.templates && Array.isArray(backupData.templates)) {
      await Template.deleteMany({});
      if (backupData.templates.length > 0) {
        await Template.insertMany(backupData.templates);
        console.log(`   - Templates restored: ${backupData.templates.length}`);
      }
    }

    // 5. Products
    if (backupData.products && Array.isArray(backupData.products)) {
      await Product.deleteMany({});
      if (backupData.products.length > 0) {
        await Product.insertMany(backupData.products);
        console.log(`   - Products restored: ${backupData.products.length}`);
      }
    }

    // 6. Customers
    if (backupData.customers && Array.isArray(backupData.customers)) {
      await Customer.deleteMany({});
      if (backupData.customers.length > 0) {
        await Customer.insertMany(backupData.customers);
        console.log(`   - Customers restored: ${backupData.customers.length}`);
      }
    }

    // 7. Invoices
    if (backupData.invoices && Array.isArray(backupData.invoices)) {
      await Invoice.deleteMany({});
      if (backupData.invoices.length > 0) {
        await Invoice.insertMany(backupData.invoices);
        console.log(`   - Invoices restored: ${backupData.invoices.length}`);
      }
    }



    // 9. RevenueExpense
    if (backupData.revenueExpenses && Array.isArray(backupData.revenueExpenses)) {
      await RevenueExpense.deleteMany({});
      if (backupData.revenueExpenses.length > 0) {
        await RevenueExpense.insertMany(backupData.revenueExpenses);
        console.log(`   - RevenueExpense restored: ${backupData.revenueExpenses.length}`);
      }
    }

    // 10. Revenues
    if (backupData.revenues && Array.isArray(backupData.revenues)) {
      await Revenue.deleteMany({});
      if (backupData.revenues.length > 0) {
        await Revenue.insertMany(backupData.revenues);
        console.log(`   - Revenues restored: ${backupData.revenues.length}`);
      }
    }

    // 10. Admins
    if (backupData.admins && Array.isArray(backupData.admins)) {
      await Admin.deleteMany({});
      if (backupData.admins.length > 0) {
        await Admin.insertMany(backupData.admins);
        console.log(`   - Admins restored: ${backupData.admins.length}`);
      }
    }

    console.log('✅ Database restoration completed successfully!');
  } catch (error) {
    console.error('❌ Restoration failed:', error.message);
  }
};

const run = async () => {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === '--backup' || command === '-b') {
    await connectDB();
    await backup();
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB.');
    process.exit(0);
  } else if (command === '--import' || command === '-i') {
    await connectDB();
    await restore(args[1]);
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB.');
    process.exit(0);
  } else {
    console.log(`
Database Backup & Restore Utility
=================================
Usage:
  Backup:
    node dbBackupRestore.js --backup
    node dbBackupRestore.js -b

  Import / Restore:
    node dbBackupRestore.js --import <filename_or_path>
    node dbBackupRestore.js -i <filename_or_path>

  Note: Backup files are stored in the "./backups" directory.
`);
    process.exit(0);
  }
};

run();

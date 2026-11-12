const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

dotenv.config();

const connectDB = require('./config/db');
const projectDB = require("./ProjectTool/DBconnection")
const seedAdmin = require('./seedAdmin');

const app = express();
const PORT = process.env.PORT || 5000;
const apiName = process.env.API_NAME;

// Ensure public/uploads directory exists
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'https://webscape.co.in',
    "http://localhost:4173"
  ],
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// Serve static uploads folder under /billing/uploads and /uploads
app.use(`/${apiName}/uploads`, express.static(path.join(__dirname, 'public/uploads')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

const apiRouter = express.Router();

apiRouter.use('/auth', require('./routes/authRoutes'));
apiRouter.use('/products', require('./routes/productRoutes'));
apiRouter.use('/customers', require('./routes/customerRoutes'));
apiRouter.use('/templates', require('./routes/templateRoutes'));
apiRouter.use('/dashboard', require('./routes/dashboardRoutes'));
apiRouter.use('/gst-settings', require('./routes/gstSettingRoutes'));
apiRouter.use('/invoices', require('./routes/invoiceRoutes'));
apiRouter.use('/revenue', require('./routes/revenueRoutes'));
apiRouter.use('/auto-reminder', require('./routes/autoReminderRoutes'));
apiRouter.use('/order-management', require('./routes/orderManagementRoutes'));
apiRouter.use('/smtp-settings', require('./routes/smtpRoutes'));
apiRouter.use('/proformas', require('./routes/proformaRoutes'));
apiRouter.use('/payment-confirmation', require('./routes/paymentConfirmationRoutes'));


// other port accsess
apiRouter.use("/projectTool", require("./ProjectTool/Router/ProjectRouter"));

apiRouter.get('/test', (req, res) => {
  res.send('Billing Backend API is running...');
});

if (apiName) {
  app.use(`/${apiName}/api`, apiRouter);
}
app.use('/billing-test/api', apiRouter);
app.use('/billing/api', apiRouter);
app.use('/api', apiRouter);

app.use((req, res) => {
  res.status(404).json({
    message: 'Route not found'
  });
});

const startServer = async () => {
  try {
    await connectDB();
    await projectDB();
    await seedAdmin();

    const { syncExpiredPaymentStatuses } = require('./utils/paymentStatusSync');
    await syncExpiredPaymentStatuses();

    // Migration: Update Customer createdAt date to match their first order's orderDate
    // const { syncCustomerCreatedAtFromFirstOrder } = require('./utils/customerCreatedAtSync');
    // await syncCustomerCreatedAtFromFirstOrder();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);

      // the automatically mail function is disabled

      // also comd for emailWorker.js 32 to 36 lines

      // ── Daily Auto Reminder Cron (runs once 5 seconds after start, then every 24h) ──
      // const { runAutoReminderCron } = require('./controllers/autoReminderController');
      // const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
      // setTimeout(async () => {
      //   console.log('[AutoReminder] Running initial cron check...');
      //   await runAutoReminderCron();
      //   setInterval(async () => {
      //     console.log('[AutoReminder] Running scheduled daily cron...');
      //     await runAutoReminderCron();
      //   }, RUN_INTERVAL_MS);
      // }, 5000);

      // ── Scheduled Cron for Expired Payment Statuses (runs every 24 hours) ──
      const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
      setInterval(async () => {
        console.log('⏰ [PaymentStatusCron] Running scheduled daily check for expired order payment statuses...');
        await syncExpiredPaymentStatuses();
      }, RUN_INTERVAL_MS);
    });
  } catch (error) {
    console.error('❌ Server startup failed:', error.message);
    process.exit(1);
  }
};

startServer();
// Nodemon reload trigger

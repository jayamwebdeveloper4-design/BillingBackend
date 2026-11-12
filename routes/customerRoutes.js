const express = require('express');
const router = express.Router();
const {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getReminders,
  exportRemindersExcel,
  importCustomers,
  exportCustomers,
  deleteOrder,
  downloadSampleExcel,
  sendReminderEmail,
  emailInvoice,
  getMailHistory,
  getReportAnalytics,
  exportReportExcel,
  recordPayment
} = require('../controllers/customerController');
const { protect } = require('../middleware/authMiddleware');
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.route('/')
  .get(protect, getCustomers)
  .post(protect, createCustomer);

router.get('/reports', protect, getReportAnalytics);
router.get('/reports/export', protect, exportReportExcel);
router.post('/import', protect, upload.single('file'), importCustomers);
router.get('/export', protect, exportCustomers);
router.get('/sample', protect, downloadSampleExcel);

router.get('/reminders', protect, getReminders);
router.get('/reminders/export', protect, exportRemindersExcel);
router.get('/:id/mail-history', protect, getMailHistory);
router.post('/:id/remind', protect, sendReminderEmail);
router.post('/:id/email-invoice', protect, upload.single('pdf'), emailInvoice);
router.post('/:id/record-payment', protect, recordPayment);

router.delete('/:customerId/orders/:orderId', protect, deleteOrder);

router.route('/:id')
  .get(protect, getCustomerById)
  .put(protect, updateCustomer)
  .delete(protect, deleteCustomer);

module.exports = router;

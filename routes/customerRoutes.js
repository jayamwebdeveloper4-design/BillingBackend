const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const c = require('../controllers/customerController');

// Protect all customer routes with authentication middleware
router.use(protect);

router.route('/')
  .get(c.getCustomers)
  .post(c.createCustomer);

router.route('/:id')
  .get(c.getCustomerById)
  .put(c.updateCustomer)
  .delete(c.deleteCustomer);

router.post('/:id/record-payment', c.recordCustomerPayment);

module.exports = router;

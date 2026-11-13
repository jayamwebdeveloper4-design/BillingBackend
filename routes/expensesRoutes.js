const express = require('express');
const multer = require('multer');
const {
  getExpenses,
  createExpense,
  updateExpense,
  getExpenseReceipt,
} = require('../Service/Expenses/Expensescontroller');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
const receiveReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('receipt');

const parseReceipt = (req, res, next) => {
  receiveReceipt(req, res, (error) => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({
        message: status === 413
          ? 'Receipt must be 5 MB or smaller.'
          : 'Receipt upload is invalid.',
      });
    }
    return next();
  });
};

router.get('/', protect, getExpenses);
router.post('/', protect, parseReceipt, createExpense);
router.patch('/:id', protect, updateExpense);
router.get('/:id/receipt', protect, getExpenseReceipt);

module.exports = router;

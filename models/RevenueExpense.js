const mongoose = require('mongoose');

const revenueExpenseSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  { timestamps: true }
);

// Map model to the existing collection 'renewexpenses' to prevent data loss.
const RevenueExpense = mongoose.model('RevenueExpense', revenueExpenseSchema);

module.exports = RevenueExpense;

const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    expenseType: {
      type: String,
      required: true,
      enum: ['salary', 'officeRent', 'internet', 'officeMaintenance', 'furniture', 'other'],
      trim: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Amount must be a valid integer in paise.',
      },
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    payPeriod: {
      type: String,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    payrollFinalized: {
      type: Boolean,
    },
    expenseDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    billDocument: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cancelled'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'expenses',
  },
);

expenseSchema.index({ expenseDate: -1, _id: -1 });
expenseSchema.index({ expenseType: 1, expenseDate: -1, _id: -1 });
expenseSchema.index(
  { employeeId: 1, payPeriod: 1 },
  {
    unique: true,
    partialFilterExpression: {
      expenseType: 'salary',
      employeeId: { $exists: true },
      payPeriod: { $exists: true },
    },
  },
);

module.exports = mongoose.model('Expense', expenseSchema);

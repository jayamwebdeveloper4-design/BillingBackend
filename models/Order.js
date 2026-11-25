const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: false
  },
  orderDate: {
    type: String,
    required: true
  },
  domainUrl: {
    type: String,
    default: ''
  },
  totalPrice: {
    type: Number,
    required: true,
    default: 0
  },
  paymentStatus: {
    type: String,
    enum: ['Unpaid', 'Partially Paid', 'Fully Paid'],
    default: 'Unpaid'
  },
  startDate: {
    type: String,
    default: ''
  },
  endDate: {
    type: String,
    default: ''
  },
  // billingCycle: {
  //   type: String,
  //   enum: ['yearly', 'monthly'],
  //   default: 'yearly'
  // },
  emailSend: {
    type: Boolean,
    default: false
  },
  expiredEmailSend: {
    type: Boolean,
    default: false
  },
  deletionEmailSend: {
    type: Boolean,
    default: false
  },
  customerDetails: {
    type: new mongoose.Schema(
      {
        name: { type: String, default: '' },
        phone: [{ type: String }],
        email: [{ type: String }],
        gstin: { type: String, default: '' },
        address: { type: String, default: '' },
        contactPerson: { type: String, default: '' }
      },
      { _id: false }
    ),
    default: null
  }
}, {
  timestamps: true
});

// Customer orders with latest first
orderSchema.index({ customerId: 1, createdAt: -1 });

// Customer order date filtering
orderSchema.index({ customerId: 1, orderDate: -1 });

// Payment status filtering
orderSchema.index({ customerId: 1, paymentStatus: 1 });

// Expiry / renewal checks
orderSchema.index({ endDate: 1 });

// Email notification background jobs
orderSchema.index({
  expiredEmailSend: 1,
  endDate: 1
});

orderSchema.index({
  emailSend: 1,
  createdAt: -1
});

module.exports = mongoose.model('Order', orderSchema);


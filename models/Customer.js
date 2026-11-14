const mongoose = require('mongoose');

const customerProductSchema = new mongoose.Schema({
  product: {
    type: String,
    required: true
  },
  variant: {
    type: String,
    required: true
  },
  costPrice:{
    type: Number,
    default: 0
  },
  price: {
    type: Number,
    required: true
  },
  quantity: {
    type: Number,
    default: 1
  },
  validationEnabled: {
    type: Boolean,
    default: false
  },
  startDate: {
    type: String
  },
  endDate: {
    type: String
  },
    billingCycle: {
    type: String,
    enum: ['yearly', 'monthly'],
    default: 'yearly'
  },
  sellerPriceRenewal: {
    type: Number,
    default: null
  },
  costPriceRenewal: {
    type: Number,
    default: null
  },
  oneTimePayment: {
    type: Boolean,
    default: false
  },
  deactive: {
    type: Boolean,
    default: false
  },
  deactiveYear: {
    type: String,
    default: ""
  }
});


const paymentSchema = new mongoose.Schema({
  date: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  gstvalue: {
    type: Number,
    default: 0
  },
  paymentType: {
    type: String,
    default: 'base' // 'base', 'renewal', or 'oneTimePayment'
  },
  paymentStage: {
    type: String,
    enum: ['advance', 'mid', 'final', 'full', 'renewal', 'base', 'oneTimePayment'],
    default: 'full'
  },
  stageNumber: {
    type: Number,
    default: 1
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    default: null
  },
  invoiceNo: {
    type: String,
    default: ''
  },
  withGst: {
    type: Boolean,
    default: false
  },
  renewalSellingPrice: {
    type: Number,
    default: null
  },
  renewalCostPrice: {
    type: Number,
    default: null
  },
  description: {
    type: String,
    default: ''
  },
  tdsAmount: {
    type: Number,
    default: 0,
    min: 0
  }
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  orderDate: {
    type: String,
    required: true
  },
  domainUrl: {
    type: String,
    default: ""
  },
  products: [customerProductSchema],  
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
  payments: [paymentSchema],
  startDate:{
    type: String,
    default: ""
  },
  endDate:{
    type: String,
    default: ""
  },
    billingCycle: {
    type: String,
    enum: ['yearly', 'monthly'],
    default: 'yearly'
  },
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
  }
}, { timestamps: true });

const mailHistorySchema = new mongoose.Schema({
  templateType: {
    type: String,
    default: 'Renewal'
  },
  status: {
    type: String,
    enum: ['Sent', 'Failed'],
    default: 'Sent'
  },
  mode: {
    type: String,
    enum: ['Email', 'WhatsApp'],
    default: 'Email'
  },
  orderId: {
    type: String,
    default: ''
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: [String],
    required: true,
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.length > 0;
      },
      message: 'At least one phone number is required.'
    }
  },
  email: {
    type: [String],
    required: true,
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.length > 0;
      },
      message: 'At least one email is required.'
    }
  },
  country: {
    type: String,
    trim: true,
    default: ''
  },
  state: {
    type: String,
    enum: ['Tamil Nadu', 'Other State'],
    default: 'Tamil Nadu'
  },
  gstin: {
    type: String,
    trim: true,
    default: ''
  },
  address: {
    type: String,
    required: true,
    trim: true
  },
  contactPerson: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  orders: [orderSchema],
  mailHistory: [mailHistorySchema]
}, {
  timestamps: true
});

customerSchema.pre('validate', function(next) {
  const cleanArray = (val, isEmail = false) => {
    if (!val) return [];
    let rawList = [];
    if (typeof val === 'string') {
      rawList = val.split(',');
    } else if (Array.isArray(val)) {
      rawList = val.flatMap(item => typeof item === 'string' ? item.split(',') : [item]);
    } else {
      rawList = [String(val)];
    }
    return Array.from(new Set(rawList
      .map(item => String(item).trim())
      .map(item => isEmail ? item.toLowerCase() : item)
      .filter(Boolean)
    ));
  };

  this.email = cleanArray(this.email, true);
  this.phone = cleanArray(this.phone, false);
  next();
});

customerSchema.pre('save', function(next) {
  if (this.orders && Array.isArray(this.orders)) {
    // Deduplicate orders by _id to prevent duplicate order entries
    const seenOrderIds = new Set();
    this.orders = this.orders.filter(order => {
      if (!order || !order._id) return true;
      const strId = order._id.toString();
      if (seenOrderIds.has(strId)) {
        return false;
      }
      seenOrderIds.add(strId);
      return true;
    });

    this.orders.forEach(order => {
      // Evaluate payment status & milestone stages according to amounts:
      const orderPrice = Number(order.totalPrice) || 0;
      let runningTotal = 0;

      if (order.payments && Array.isArray(order.payments)) {
        order.payments.forEach((p, idx) => {
          const amt = Number(p.amount) || 0;
          runningTotal += amt;

          if (idx === 0) {
            // First payment: Full payment if clears orderPrice, otherwise Advance
            if (orderPrice > 0 && runningTotal >= orderPrice) {
              p.paymentStage = 'full';
            } else {
              p.paymentStage = 'advance';
            }
          } else {
            // Subsequent payments: Final if clears orderPrice, otherwise Milestone
            if (orderPrice > 0 && runningTotal >= orderPrice) {
              p.paymentStage = 'final';
            } else {
              p.paymentStage = 'mid';
              p.stageNumber = idx;
            }
          }
        });
      }

      // Overall order payment status
      if (runningTotal === 0) {
        order.paymentStatus = 'Unpaid';
      } else if (runningTotal < orderPrice) {
        order.paymentStatus = 'Partially Paid';
      } else {
        order.paymentStatus = 'Fully Paid';
      }

      if (order.products && Array.isArray(order.products)) {
        const validProducts = order.products.filter(
          p => p.validationEnabled && p.startDate && p.endDate
        );

        if (validProducts.length === 0) {
          order.startDate = "";
          order.endDate = "";
        } else {
          let maxDuration = -1;
          let chosenProduct = null;

          validProducts.forEach(p => {
            const start = new Date(p.startDate);
            const end = new Date(p.endDate);
            if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
              const duration = end.getTime() - start.getTime();
              if (duration > maxDuration) {
                maxDuration = duration;
                chosenProduct = p;
              }
            }
          });

          if (chosenProduct) {
            order.startDate = chosenProduct.startDate;
            order.endDate = chosenProduct.endDate;
          } else {
            order.startDate = "";
            order.endDate = "";
          }
        }
      } else {
        order.startDate = "";
        order.endDate = "";
      }
    });
  }
  next();
});
const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;

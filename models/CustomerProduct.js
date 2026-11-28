const mongoose = require('mongoose');


// Hierarchical Payment Stage within a Renewal Cycle
const paymentStageSchema = new mongoose.Schema({
  payDate: {
    type: String,
    required: true
  },
  stage: {
    type: String,
    enum: ['advance', 'mid', 'final', 'full'],
    default: 'full'
  },
  stageNumber: {
    type: Number,
    default: 1
  },
  amount: {
    type: Number,
    required: true
  },
  withGst: {
    type: Boolean,
    default: false
  },
  gstvalue: {
    type: Number,
    default: 0
  },
  description: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});


const paymentHistorySchema = new mongoose.Schema({
  date: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  withGst: {
    type: Boolean,
    default: false
  },
  gstvalue: {
    type: Number,
    default: 0
  },
  paymentStage: {
    type: String,
    enum: ['advance', 'mid', 'final', 'full'],
    default: 'advance'
  },
  stageNumber: {
    type: Number,
    default: 1
  },
  description: {
    type: String,
    default: ''
  },
  tdsAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  renewalSellingPrice: {
    type: Number,
    default: null
  },
  renewalCostPrice: {
    type: Number,
    default: null
  },
  invoiceNo: {
    type: String,
    default: '',
    trim: true
  },
  paymentHistory: [paymentStageSchema],
}, {
  timestamps: true
});

// Hierarchical Renewal Cycle History

const renewalHistorySchema = new mongoose.Schema({
  invoiceNo: {
    type: String,
    default: ''
  },

  cycleNumber: {
    type: Number,
    required: true
  },

  startDate: {
    type: String,
    required: true
  },

  endDate: {
    type: String,
    required: true
  },

  totalAmount: {
    type: Number,
    required: true,
    default: 0
  },

  paidAmount: {
    type: Number,
    default: 0,
    min: 0
  },

  paymentStatus: {
    type: String,
    enum: ['Unpaid', 'Partially Paid', 'Paid'],
    default: 'Unpaid'
  },

  renewalStatus: {
    type: String,
    enum: ['upcoming', 'active', 'complete'],
    default: 'upcoming'
  },

  paymentStages: [paymentStageSchema]

}, { timestamps: true });

const reminderSchema = new mongoose.Schema({
  reminder: {
    type: String,
    enum: ["send", "not send"],
    default: "not send"
  },
  date: {
    type: String,
    default: ""
  },
  count: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

const customerProductSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: false
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
  },
  domainUrl: {
    type: String,
    default: ''
  },
  product: {
    type: String,
    required: true
  },
  variant: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  costPrice: {
    type: Number,
    default: 0
  },
  quantity: {
    type: Number,
    default: 1
  },
  productType:{
    type:String,
    enum:["Renewal","OneTime"],
    default:"OneTime"
  },
  // This field is only used for variant is Renewal 
  billingCycle: {
    type: String,
    enum: ['yearly', 'monthly'],
    default: 'yearly'
  },
  cycleCount:{
    type: Number,
    default: 1
  },
  paymentStage: {
    type: String,
    enum: ['advance', 'mid', 'final', 'full'],
    default: 'advance'
  },
  startDate: {
    type: String
  },
  endDate: {
    type: String
  },
  sellerPriceRenewal: {
    type: Number,
    default: null
  },
  costPriceRenewal: {
    type: Number,
    default: null
  },
  validationEnabled: {
    type: Boolean,
    default: false
  },
  oneTimePayment: {
    type: Boolean,
    default: false
  },
  reminder: [reminderSchema],
  deactive: {
    type: Boolean,
    default: false
  },
  deactiveYear: {
    type: String,
    default: ''
  },
  deactiveDate: {
    type: String,
    default: ''
  },
  renewalStatus: {
    type: String,
    default :"active"
  },
  renewalHistory: [renewalHistorySchema],
  paymentHistory: [paymentHistorySchema]
}, {
  timestamps: true
});

// Customer and order lookups
customerProductSchema.index({ customerId: 1, createdAt: -1 });
customerProductSchema.index({ orderId: 1 });

// Active / inactive product filtering
customerProductSchema.index({ customerId: 1, deactive: 1 });

// Customer renewal billing filtering (covers customerId + productType as prefix)
customerProductSchema.index({
  customerId: 1,
  productType: 1,
  endDate: 1,
  renewalStatus: 1,
});
customerProductSchema.index({ 'paymentHistory.date': 1 });
customerProductSchema.index({ 'paymentHistory.paymentHistory.payDate': 1 });
customerProductSchema.index({ startDate: 1 });
customerProductSchema.index({ createdAt: 1 });

// Global renewal queries (Renewal Processing Engine & Reminders without customerId)
customerProductSchema.index({ productType: 1, renewalStatus: 1, deactive: 1, endDate: 1 });

// Unique index for invoice numbers in payment history (ignores blank/empty strings so unpaid/uninvoiced records do not collide)
customerProductSchema.index(
  { 'paymentHistory.invoiceNo': 1 },
  {
    unique: true,
    partialFilterExpression: { 'paymentHistory.invoiceNo': { $type: 'string', $gt: '' } }
  }
);

module.exports = mongoose.model('CustomerProduct', customerProductSchema);


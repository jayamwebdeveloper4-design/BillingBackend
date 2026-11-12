const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  quantity: Number,
  domainName : String,
  price: {
    type: Number,
    required: true
  },
  description: String
});

const paymentHistoryItemSchema = new mongoose.Schema({
  stage: {
    type: String,
    default: 'full'
  },
  stageNumber: {
    type: Number,
    default: 1
  },
  date: String,
  amount: Number,
  invoiceNo: String,
  description: String
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  orderIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  }],
  paymentId: {
    type: mongoose.Schema.Types.ObjectId
  },
  invoiceCategory: {
    type: String,
    enum: ['regular', 'installment', 'consolidated'],
    default: 'regular'
  },
  paymentStage: {
    type: String,
    default: 'full' // 'advance', 'mid', 'final', 'full'
  },
  stageNumber: {
    type: Number,
    default: 1
  },
  paymentHistory: [paymentHistoryItemSchema],
  totalOrderAmount: {
    type: Number,
    default: 0
  },
  totalPaidPreviously: {
    type: Number,
    default: 0
  },
  balanceDue: {
    type: Number,
    default: 0
  },
  customerName: {
    type: String
  },
  invoiceNo: {
    type: String,
    required: true,
    unique: true
  },
  invoiceType: {
    type: String,
    enum: ['withGST', 'withoutGST'],
    default: 'withGST'
  },
  invoiceDate: {
    type: String
  },
  items: [invoiceItemSchema],
  subtotal: {
    type: Number,
    default: 0
  },
  cgst: {
    type: Number,
    default: 0
  },
  sgst: {
    type: Number,
    default: 0
  },
  igst: {
    type: Number,
    default: 0
  },
  totalPrice: {
    type: Number,
    default: 0
  },

   tdsAmount: {
    type: Number,
    default: 0,
    min: 0
  },
   netAmountReceived: {
    type: Number,
    default: 0,
    min: 0
  },
  
  priceinword: {
    type: String,
    default: ""
  },
  paymentStatus: {
    type: String,
    enum: ['Paid', 'Payable'],
    default: 'Paid'
  }
}, { timestamps: true });

invoiceSchema.index({ orderId: 1, invoiceType: 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);

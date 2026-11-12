const mongoose = require('mongoose');

const proformaItemSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  Particulars: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true
  }
});

const proformaSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  companyName: {
    type: String
  },
  address: {
    type: String
  },
  state: {
    type: String,
    default: 'Tamil Nadu'
  },
  country: {
    type: String,
    default: 'India'
  },
  contactPerson: {
    type: String
  },
  gstNumber: {
    type: String
  },
  email: {
    type: mongoose.Schema.Types.Mixed
  },
  phone: {
    type: mongoose.Schema.Types.Mixed
  },
  proforma_no: {
    type: String,
    required: true,
    unique: true
  },
  items: [proformaItemSchema],
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
  priceinword: {
    type: String,
    default: ""
  },
  gstType: {
    type: String,
    enum: ['withGST', 'withoutGST'],
    default: 'withGST'
  },
  date: {
    type: String,
    required: true
  },
  note: {
    type: String,
    default: "If you have any doubt on this invoice, please contact us at: 9677 87 6445 / 98405 99789"
  }
}, { timestamps: true });

module.exports = mongoose.model('Proforma', proformaSchema);

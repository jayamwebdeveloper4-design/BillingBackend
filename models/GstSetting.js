const mongoose = require('mongoose');

const gstSettingSchema = new mongoose.Schema({
  companyName: {
    type: String,
    default: ""
  },
  companyNameWithoutGst: {
    type: String,
    default: ""
  },
  address: {
    type: String,
    default: ""
  },
  addressWithoutGst: {
    type: String,
    default: ""
  },
  phone: {
    type: String,
    default: ""
  },
  phoneWithoutGst: {
    type: String,
    default: ""
  },
  email: {
    type: String,
    default: ""
  },
  emailWithoutGst: {
    type: String,
    default: ""
  },
  gstin: {
    type: String,
    default: ""
  },
  cgstPercentage: {
    type: Number,
    default: 9
  },
  sgstPercentage: {
    type: Number,
    default: 9
  },
  igstPercentage: {
    type: Number,
    default: 18
  },
  signatureImage: {
    type: String,
    default: ''
  },
  // Bank Details With GST
  bankAccountName: {
    type: String,
    default: "JAYAM TECHNOLOGIES"
  },
  bankAccountNumber: {
    type: String,
    default: "120035000004"
  },
  bankName: {
    type: String,
    default: "Canara Bank"
  },
  bankBranch: {
    type: String,
    default: "Perungalathur"
  },
  bankIfsc: {
    type: String,
    default: "CNRB0003856"
  },
  gpayNumber: {
    type: String,
    default: "9840599789"
  },
  // Bank Details Without GST
  bankAccountNameWithoutGst: {
    type: String,
    default: "Jayam Web Solutions"
  },
  bankAccountNumberWithoutGst: {
    type: String,
    default: "722473240"
  },
  bankNameWithoutGst: {
    type: String,
    default: "Indian Bank"
  },
  bankBranchWithoutGst: {
    type: String,
    default: "Tambaram West, Chennai"
  },
  bankIfscWithoutGst: {
    type: String,
    default: "IDIB000T092"
  },
  gpayNumberWithoutGst: {
    type: String,
    default: "9677876445"
  }
}, { timestamps: true });

module.exports = mongoose.model('GstSetting', gstSettingSchema);

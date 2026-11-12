const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    default: 'Reminder'
  },
  subject: {
    type: String,
    default: ''
  },
  content: {
    type: String,
    required: true
  }
},{ timestamps: true });

module.exports = mongoose.model('Template', templateSchema);


const mongoose = require("mongoose");
const projectDB = require("../DBconnection");

const projectSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true, trim: true },
    billingCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    serviceName: { type: String, trim: true },
    budget: {
      currency: { type: String, default: "₹" },
      amount: { type: Number, min: 0 },
    },
    customerName: { type: String, trim: true },
    customerPhone: { type: [String], default: [] },
    customerEmail: { type: [String], default: [] },

  },
  { timestamps: true }
);

projectSchema.index({ createdAt: -1 });
projectSchema.index({ customerId: 1 });

module.exports = projectDB.connection.model("Project", projectSchema);
const mongoose = require("mongoose");
const projectDB = require("../DBconnection");

const projectClientSchema = new mongoose.Schema(
    {
        // ID of the customer in the billing database
        billingCustomerId: {
            type: mongoose.Schema.Types.ObjectId,
        },
        clientName: {
            type: String,
            required: true,
            trim: true,
        },
        phone: {
            type: [String],
            default: [],
        },
        email: {
            type: [String],
            default: [],
        },
        country: { type: String, default: "" },
        state: { type: String, default: "" },
        gstin: { type: String, default: "" },
        address: { type: String, default: "" },
        contactPerson: { type: String, default: "" },
        notes: { type: String, default: "" },
    },
    { timestamps: true }
);

// Allows existing ProjectDB client documents without this field.
projectClientSchema.index(
    { billingCustomerId: 1 },
    { unique: true, sparse: true }
);

module.exports =
    projectDB.connection.models.ProjectClient ||
    projectDB.connection.model("ProjectClient", projectClientSchema, "clinets");
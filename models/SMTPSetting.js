const mongoose = require("mongoose");

const SMTPSettingSchema = new mongoose.Schema(
    {
        smtpHost: {
            type: String,
            trim: true,
            default: ""
        },

        smtpUsername: {
            type: String,
            trim: true,
            default: ""
        },

        smtpPassword: {
            type: String,
            default: ""
        },

        smtpFromEmail: {
            type: String,
            trim: true,
            lowercase: true,
            default: ""
        },

        smtpFromName: {
            type: String,
            trim: true,
            default: ""
        },

        smtpPort: {
            type: Number,
            default: 587
        },

        secure: {
            type: Boolean,
            default: false
        },

        smtpEncryption: {
            type: String,
            enum: ["none", "ssl", "tls"],
            default: "tls"
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("SMTPSetting", SMTPSettingSchema);
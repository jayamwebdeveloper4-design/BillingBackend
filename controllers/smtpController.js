const SmtpSetting = require("../models/SMTPSetting");
const { encryptString, decryptString } = require("../utils/cryptoHelper");

// @desc    Get global SMTP settings
// @route   GET /api/smtp-settings
// @access  Private
const getSmtpSettings = async (req, res) => {
    try {
        let settings = await SmtpSetting.findOne();

        if (!settings) {
            return res.json({
                smtpHost: "",
                smtpPort: 587,
                secure: false,
                smtpEncryption: "tls",
                smtpUsername: "",
                smtpPassword: "",
                smtpFromEmail: "",
                smtpFromName: ""
            });
        }

        const result = settings.toObject();
        result.smtpPassword = decryptString(result.smtpPassword);

        res.json(result);
    } catch (error) {
        res.status(500).json({
            message: "Server Error",
            error: error.message
        });
    }
};

// @desc    Update global SMTP settings
// @route   PUT /api/smtp-settings
// @access  Private
const updateSmtpSettings = async (req, res) => {
    try {
        const {
            smtpHost,
            smtpPort,
            smtpUsername,
            smtpPassword,
            smtpFromEmail,
            smtpFromName,
            smtpEncryption,
            secure
        } = req.body;

        let settings = await SmtpSetting.findOne();

        if (!settings) {
            settings = new SmtpSetting();
        }

        if (smtpHost !== undefined)
            settings.smtpHost = smtpHost;

        if (smtpPort !== undefined)
            settings.smtpPort = smtpPort;

        if (smtpUsername !== undefined)
            settings.smtpUsername = smtpUsername;

        if (smtpPassword !== undefined)
            settings.smtpPassword = encryptString(smtpPassword);

        if (smtpFromEmail !== undefined)
            settings.smtpFromEmail = smtpFromEmail;

        if (smtpFromName !== undefined)
            settings.smtpFromName = smtpFromName;

        if (smtpEncryption !== undefined)
            settings.smtpEncryption = smtpEncryption;

        if (secure !== undefined)
            settings.secure = secure;

        const updatedSettings = await settings.save();
        const result = updatedSettings.toObject();
        result.smtpPassword = decryptString(result.smtpPassword);

        res.json(result);
    } catch (error) {
        res.status(500).json({
            message: "Server Error",
            error: error.message
        });
    }
};

module.exports = {
    getSmtpSettings,
    updateSmtpSettings
};
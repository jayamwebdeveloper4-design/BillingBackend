const nodemailer = require("nodemailer");
const SmtpSetting = require("../models/SMTPSetting");
const { encryptString, decryptString } = require("../utils/cryptoHelper");
const { normalizeSmtpSettings, getSmtpSettingsFromDb, clearSmtpSettingsCache } = require("../utils/smtpHelper");
const sendEmail = require("../utils/sendEmail");

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
                smtpFromName: "",
                autoReminder: false
            });
        }

        const result = settings.toObject();
        result.smtpPassword = decryptString(result.smtpPassword);
        result.autoReminder = Boolean(result.autoReminder);

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
            secure,
            autoReminder
        } = req.body;

        let settings = await SmtpSetting.findOne();

        if (!settings) {
            settings = new SmtpSetting();
        }

        if (autoReminder !== undefined)
            settings.autoReminder = Boolean(autoReminder);

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
        clearSmtpSettingsCache();
        sendEmail.clearTransporterCache();
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

// @desc    Test SMTP connection and optionally send a test email
// @route   POST /api/smtp-settings/test
// @access  Private
const testSmtpConnection = async (req, res) => {
    try {
        const { email, settings } = req.body;

        let host = settings?.smtpHost || settings?.host;
        let port = settings?.smtpPort || settings?.port || 587;
        let username = settings?.smtpUsername || settings?.username;
        let password = settings?.smtpPassword || settings?.password;
        let encryption = settings?.smtpEncryption || settings?.encryption || 'tls';
        let fromEmail = settings?.smtpFromEmail || settings?.fromEmail;
        let fromName = settings?.smtpFromName || settings?.fromName;

        // If settings not provided in payload, fetch from DB
        if (!host || !username || !password) {
            const dbSettings = await getSmtpSettingsFromDb();
            if (dbSettings) {
                host = host || dbSettings.host;
                port = port || dbSettings.port;
                username = username || dbSettings.username;
                password = password || dbSettings.password;
                encryption = encryption || dbSettings.encryption;
                fromEmail = fromEmail || dbSettings.fromEmail;
                fromName = fromName || dbSettings.fromName;
            }
        }

        if (!host || !username || !password) {
            return res.status(400).json({
                message: "SMTP Host, Username, and Password are required to test connection."
            });
        }

        const isSsl = encryption === 'ssl' || Number(port) === 465;
        const isTls = encryption === 'tls';

        const transporterOptions = {
            host,
            port: Number(port),
            auth: {
                user: username,
                pass: password,
            },
            tls: {
                rejectUnauthorized: false,
            },
        };

        if (isSsl) {
            transporterOptions.secure = true;
        } else if (isTls) {
            transporterOptions.secure = false;
            transporterOptions.requireTLS = true;
        } else {
            transporterOptions.secure = false;
        }

        const transporter = nodemailer.createTransport(transporterOptions);

        // Verify transporter credentials & connection
        await transporter.verify();

        const targetEmail = email || fromEmail || username;
        if (targetEmail) {
            const resolvedFromName = fromName || "Billing System";
            const authFrom = username;
            const aliasFrom = fromEmail && fromEmail !== username ? fromEmail : undefined;

            await transporter.sendMail({
                from: `"${resolvedFromName}" <${authFrom}>`,
                to: targetEmail,
                replyTo: aliasFrom,
                subject: "SMTP Connection Test - Jayam Billing System",
                text: "Your SMTP settings are configured correctly and this test email was delivered successfully.",
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 12px; background: #ffffff;">
                        <div style="border-bottom: 2px solid #0061a4; padding-bottom: 12px; margin-bottom: 16px;">
                            <h2 style="color: #0061a4; margin: 0; font-size: 20px;">SMTP Configuration Verified</h2>
                        </div>
                        <p style="color: #333333; font-size: 14px; line-height: 1.6;">
                            This is a confirmation test email from <strong>Jayam Billing System</strong>. Your SMTP server connection is working properly and ready to send customer reminders, invoices, and alerts.
                        </p>
                        <div style="background-color: #f7f9fc; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 13px; color: #444444;">
                            <p style="margin: 6px 0;"><strong>Host:</strong> ${host}</p>
                            <p style="margin: 6px 0;"><strong>Port:</strong> ${port}</p>
                            <p style="margin: 6px 0;"><strong>Encryption:</strong> ${encryption.toUpperCase()}</p>
                            <p style="margin: 6px 0;"><strong>Sender:</strong> ${resolvedFromName} &lt;${fromEmail || username}&gt;</p>
                        </div>
                        <p style="font-size: 12px; color: #888888; margin-top: 24px; border-top: 1px solid #eeeeee; padding-top: 12px;">
                            Sent on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                        </p>
                    </div>
                `
            });

            return res.json({
                success: true,
                message: `Connection successful! Test email delivered to ${targetEmail}`
            });
        }

        res.json({
            success: true,
            message: "SMTP connection verified successfully!"
        });
    } catch (error) {
        console.error("Error testing SMTP connection:", error);
        res.status(400).json({
            message: error.message || "Failed to establish SMTP connection",
            error: error.message
        });
    }
};

module.exports = {
    getSmtpSettings,
    updateSmtpSettings,
    testSmtpConnection
};
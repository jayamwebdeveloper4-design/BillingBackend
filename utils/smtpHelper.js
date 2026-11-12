const SmtpSetting = require('../models/SMTPSetting');
const { decryptString } = require('./cryptoHelper');

/**
 * Normalize SMTP settings regardless of field names
 */
const normalizeSmtpSettings = (settings) => {
    if (!settings) return null;

    const host = settings.host || settings.smtpHost || '';
    const port = settings.port ?? settings.smtpPort ?? 587;
    const encryption = settings.encryption || settings.smtpEncryption || 'tls';
    const username = settings.username || settings.smtpUsername || '';
    const password = settings.password || settings.smtpPassword || '';
    const fromEmail = settings.fromEmail || settings.smtpFromEmail || '';
    const fromName = settings.fromName || settings.smtpFromName || '';

    const secure =
        settings.secure !== undefined
            ? settings.secure
            : encryption === 'ssl' || Number(port) === 465;

    return {
        host,
        port: Number(port),
        encryption,
        username,
        password,
        fromEmail,
        fromName,
        secure,
    };
};

/**
 * Get SMTP settings from database
 */
const getSmtpSettingsFromDb = async () => {
    const settings = await SmtpSetting.findOne();

    if (!settings) {
        return null;
    }

    const normalized = normalizeSmtpSettings(settings.toObject());

    return {
        ...normalized,
        password: decryptString(normalized.password),
    };
};

module.exports = {
    normalizeSmtpSettings,
    getSmtpSettingsFromDb,
};
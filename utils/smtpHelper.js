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

let cachedSmtpSettings = null;

/**
 * Clear cached SMTP settings (call when settings are updated)
 */
const clearSmtpSettingsCache = () => {
    cachedSmtpSettings = null;
};

/**
 * Get SMTP settings from database (with in-memory cache)
 */
const getSmtpSettingsFromDb = async () => {
    if (cachedSmtpSettings) {
        return cachedSmtpSettings;
    }

    const settings = await SmtpSetting.findOne();

    if (!settings) {
        return null;
    }

    const normalized = normalizeSmtpSettings(settings.toObject());

    cachedSmtpSettings = {
        ...normalized,
        password: decryptString(normalized.password),
    };

    return cachedSmtpSettings;
};

module.exports = {
    normalizeSmtpSettings,
    getSmtpSettingsFromDb,
    clearSmtpSettingsCache,
};
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT = 'smtp-settings-salt';

const getEncryptionKey = () => {
    const secret = process.env.SMTP_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('SMTP_SECRET or JWT_SECRET must be configured to encrypt SMTP passwords');
    }
    return crypto.scryptSync(secret, SALT, 32);
};

const encryptString = (text) => {
    if (text === undefined || text === null || text === '') {
        return '';
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptString = (encryptedText) => {
    if (!encryptedText) {
        return '';
    }

    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
        return encryptedText;
    }

    try {
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
        decipher.setAuthTag(authTag);
        return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
    } catch (error) {
        console.error('SMTP password decryption failed:', error.message);
        return encryptedText;
    }
};

module.exports = {
    encryptString,
    decryptString,
};

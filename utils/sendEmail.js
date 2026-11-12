const nodemailer = require('nodemailer');
const { getSmtpSettingsFromDb } = require('./smtpHelper');

const getCcRecipients = (options) => {
  const configuredCc = options.cc || process.env.CC_EMAIL || process.env.EMAIL_CC || process.env.SMTP_CC || process.env.CC;

  if (!configuredCc) return undefined;

  if (Array.isArray(configuredCc)) {
    return configuredCc.filter(Boolean);
  }

  return configuredCc
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
};

/**
 * Real Email Utility using Nodemailer and DB-backed SMTP settings
 */
const sendEmail = async (options) => {
  const smtpSettings = await getSmtpSettingsFromDb();
  if (!smtpSettings || !smtpSettings.username || !smtpSettings.password) {
    throw new Error('SMTP settings are not configured. Please configure SMTP settings first.');
  }

  const isSsl = smtpSettings.encryption === 'ssl';
  const isTls = smtpSettings.encryption === 'tls';

  const transporterOptions = {
    host: smtpSettings.host,
    port: smtpSettings.port,
    auth: {
      user: smtpSettings.username,
      pass: smtpSettings.password,
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

  const fromName = smtpSettings.fromName || 'Billing Manager';
  const authFrom = smtpSettings.username;
  const aliasFrom = smtpSettings.fromEmail && smtpSettings.fromEmail !== smtpSettings.username ? smtpSettings.fromEmail : undefined;
  const replyTo = aliasFrom;
  const ccRecipients = getCcRecipients(options);

  const envelopeToRecipients = Array.isArray(options.email) ? [...options.email] : [options.email];
  if (ccRecipients && ccRecipients.length > 0) {
    envelopeToRecipients.push(...ccRecipients);
  }

  const mailOptions = {
    from: `"${fromName}" <${authFrom}>`,
    to: options.email,
    subject: options.subject,
    html: options.message,
    text: options.text || options.message.replace(/<[^>]+>/g, ''),
    attachments: options.attachments,
    envelope: {
      from: authFrom,
      to: envelopeToRecipients,
    },
    replyTo,
    ...(ccRecipients ? { cc: ccRecipients } : {}),
  };

  console.log(`📧 Sending email via SMTP host=${smtpSettings.host} port=${smtpSettings.port} secure=${transporterOptions.secure}`);
  console.log(`📧 From header: "${fromName}" <${authFrom}>`);
  if (replyTo) {
    console.log(`📧 Reply-To: ${replyTo}`);
  }
  console.log(`📧 Envelope from: ${authFrom}`);
  console.log(`📧 Envelope to: ${Array.isArray(options.email) ? options.email.join(', ') : options.email}`);
  if (ccRecipients) {
    console.log(`📧 CC recipients: ${ccRecipients.join(', ')}`);
  }

  try {
    await transporter.verify();
    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Email sent: ${info.messageId}`);
    console.log('📧 SMTP accepted recipients:', info.accepted);
    console.log('📧 SMTP rejected recipients:', info.rejected);
    return { success: true, info };
  } catch (error) {
    console.error('❌ Email sending failed:', error);
    throw error;
  }
};

module.exports = sendEmail;

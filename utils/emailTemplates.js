/**
 * OTP Email Template
 * @param {string} otp - The 6-digit OTP code
 * @returns {string} - The HTML string for the email body
 */
const otpTemplate = (otp) => {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 10px; padding: 20px;">
      <h2 style="color: #333; text-align: center;">Password Reset Request</h2>
      <p style="font-size: 16px; color: #555;">You requested a password reset for your Billing System account. Please use the following One-Time Password (OTP) to proceed:</p>
      <div style="background-color: #f9f9f9; border-radius: 5px; padding: 15px; text-align: center; margin: 20px 0;">
        <h1 style="color: #004a99; font-size: 36px; letter-spacing: 8px; margin: 0;">${otp}</h1>
      </div>
      <p style="font-size: 14px; color: #888;">This code is valid for 10 minutes. If you did not request this, please ignore this email.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="font-size: 12px; color: #aaa; text-align: center;">&copy; ${new Date().getFullYear()} Billing System. All rights reserved.</p>
    </div>
  `;
};

const convertTextWithHtmlToBr = (str) => {
  if (!str) return '';
  return str.split(/(<table[\s\S]*?<\/table>)/gi).map(part => {
    if (part.toLowerCase().startsWith('<table')) {
      return part;
    }
    return part.replace(/\r?\n/g, '<br />');
  }).join('');
};

const reminderTemplate = (subject, content, type, fullTitle) => {
  let badgeText = 'Renewal Reminder';
  let themeColor = '#004a99';
  let bgColor = 'rgba(0, 74, 153, 0.08)';

  // Determine type from parameter or subject/content analysis
  const resolvedType = type || (
    subject?.toLowerCase().includes('invoice') || content?.toLowerCase().includes('invoice') ? 'Invoice' :
    subject?.toLowerCase().includes('expired') || content?.toLowerCase().includes('expired') ? 'Expired' :
    subject?.toLowerCase().includes('deletion') || content?.toLowerCase().includes('deletion') ? 'Deletion' :
    'Renewal'
  );

  if (resolvedType.toLowerCase() === 'invoice') {
    badgeText = 'Invoice';
    themeColor = '#004a99';
    bgColor = 'rgba(0, 74, 153, 0.08)';
  } else if (resolvedType.toLowerCase() === 'expired') {
    badgeText = 'Expired Service Alert';
    themeColor = '#d32f2f'; // Red
    bgColor = 'rgba(211, 47, 47, 0.08)';
  } else if (resolvedType.toLowerCase() === 'deletion') {
    badgeText = 'Deletion Warning';
    themeColor = '#c62828'; // Darker Red
    bgColor = 'rgba(198, 40, 40, 0.08)';
  }

  const bodyHtml = convertTextWithHtmlToBr(content || '');
  const titleToDisplay = fullTitle || subject;

  return `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 20px auto; border: 1px solid #e2e8f0; border-top: 5px solid ${themeColor}; border-radius: 12px; padding: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 25px;">
        <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.15em; color: ${themeColor}; background-color: ${bgColor}; padding: 5px 12px; border-radius: 30px;">${badgeText}</span>
      </div>
      <h2 style="color: #1e293b; text-align: center; font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 25px; line-height: 1.3;">${titleToDisplay}</h2>
      <div style="font-size: 15px; color: #334155; line-height: 1.6; background-color: #f8fafc; padding: 25px; border-radius: 8px; border: 1px solid #f1f5f9;">${bodyHtml}</div>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;">
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0; line-height: 1.5;">&copy; ${new Date().getFullYear()} Jayam Web Solutions. All rights reserved.</p>
    </div>
  `;
};

const apologyTemplate = (subject, content) => {
  return `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 20px auto; border: 1px solid #e2e8f0; border-top: 5px solid #ffa000; border-radius: 12px; padding: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); background-color: #ffffff;">
      <h2 style="color: #1e293b; text-align: center; font-size: 18px; font-weight: 700; margin-top: 0; margin-bottom: 25px; line-height: 1.3;">${subject}</h2>
      <div style="font-size: 15px; color: #334155; line-height: 1.6; background-color: #f8fafc; padding: 25px; border-radius: 8px; border: 1px solid #f1f5f9;">
        <p style="margin-top: 0;">Dear Sir/Ma'am,</p>
        <p>Greetings from Jayam Web Solutions.</p>
        <p style="font-weight: 600; color: #b45309;">Please disregard the previous email(s) you may have received regarding domain/hosting renewal or service deletion.</p>
        <p>Due to a temporary issue in our notification system, these emails were sent incorrectly. We apologize for any confusion caused.</p>
        <p>If any action is actually required for your services, we will send you a separate and correct notification.</p>
        <p>Thank you for your understanding.</p>
        <p style="margin-bottom: 0; margin-top: 20px; line-height: 1.4;">
          Regards,<br>
          <strong>Team - billing</strong><br>
          Jayam Web Solutions Pvt. Ltd.<br>
          +91 9677876445
        </p>
      </div>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;">
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0; line-height: 1.5;">&copy; ${new Date().getFullYear()} Jayam Web Solutions. All rights reserved.</p>
    </div>
  `;
};

const paymentConfirmationTemplate = (subject, content) => {
  const bodyHtml = convertTextWithHtmlToBr(content || '');
  return `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 20px auto; border: 1px solid #e2e8f0; border-top: 5px solid #2e7d32; border-radius: 12px; padding: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 25px;">
        <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.15em; color: #2e7d32; background-color: rgba(46, 125, 50, 0.08); padding: 5px 12px; border-radius: 30px;">Payment Confirmed</span>
      </div>
      <h2 style="color: #1e293b; text-align: center; font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 25px; line-height: 1.3;">${subject}</h2>
      <div style="font-size: 15px; color: #334155; line-height: 1.6; background-color: #f8fafc; padding: 25px; border-radius: 8px; border: 1px solid #f1f5f9;">${bodyHtml}</div>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;">
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0; line-height: 1.5;">&copy; ${new Date().getFullYear()} Jayam Web Solutions. All rights reserved.</p>
    </div>
  `;
};

const loginOtpTemplate = (otp, validityMinutes = 5) => {
  return `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 20px auto; border: 1px solid #e2e8f0; border-top: 5px solid #004a99; border-radius: 12px; padding: 32px; box-shadow: 0 4px 18px rgba(0,0,0,0.06); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 20px;">
        <span style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.15em; color: #004a99; background-color: rgba(0, 74, 153, 0.08); padding: 5px 12px; border-radius: 30px;">Secure Login Verification</span>
      </div>
      <h2 style="color: #1e293b; text-align: center; font-size: 22px; font-weight: 700; margin: 0 0 10px 0;">Sign in to Billing Manager</h2>
      <p style="font-size: 15px; color: #475569; text-align: center; line-height: 1.6; margin: 0 0 24px 0;">
        Use the one-time verification code below to complete your passwordless login.
      </p>
      <div style="background: linear-gradient(135deg, #f8fafc 0%, #edf2f7 100%); border: 1px dashed #cbd5e1; border-radius: 10px; padding: 22px; text-align: center; margin: 0 0 24px 0;">
        <span style="font-family: 'Courier New', Courier, monospace; color: #004a99; font-size: 38px; font-weight: 800; letter-spacing: 12px; margin-left: 12px;">${otp}</span>
      </div>
      <p style="font-size: 13px; color: #64748b; text-align: center; margin: 0 0 18px 0;">
        ⏳ This code is valid for <strong>${validityMinutes} minutes</strong> and can only be used once.
      </p>
      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">
        If you did not request this login code, please safely disregard this email.
      </p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 28px 0 18px 0;">
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0; line-height: 1.5;">&copy; ${new Date().getFullYear()} Jayam Web Solutions. All rights reserved.</p>
    </div>
  `;
};

module.exports = {
  otpTemplate,
  loginOtpTemplate,
  reminderTemplate,
  apologyTemplate,
  paymentConfirmationTemplate,
};

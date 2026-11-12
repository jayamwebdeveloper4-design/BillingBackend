const Template = require('../models/Template');
// @desc    Get template by name
// @route   GET /api/templates/:name
// @access  Private
const getTemplate = async (req, res) => {
  try {
    const { name } = req.params;
    let template = await Template.findOne({ name });

    let defaultSubject = "Renewal of Domain, Hosting - JAYAM WEB SOLUTIONS";
    let defaultContent = `Dear Sir/Ma’am,

Reg. Renewal of services.

[product table]

Kindly make payment [price]/-INR ([priceWords]) for One year & confirm with payment transaction details.

𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗱𝗲𝘁𝗮𝗶𝗹𝘀:

GPAY : 9677876445

Bank Name : Indian bank
Account Number : 722473240
Account Name : Jayam Web Solutions
Branch : West Tambaram-Chennai
IFSC Code : IDIB000T092
Account Type : Current Account

Let us know if there are any queries.
-- 

Thanks & Regards,
Lakshmi.L 
Jayam Web Solutions 
+91 9677 87 6445 / 98405 99789 
www.jayamwebsolutions.com`;

    if (name.toLowerCase() === 'expired') {
      defaultSubject = "EXPIRED: Renewal of Domain, Hosting - JAYAM WEB SOLUTIONS";
      defaultContent = `Dear Sir/Ma’am,

We would like to inform you that your domain and hosting services have expired.

[product table]

To avoid any interruption to your website and email services (if applicable), we request you to renew the services at the earliest.

Kindly make payment [price]/-INR ([priceWords]) for One year & confirm with payment transaction details.

𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗱𝗲𝘁𝗮𝗶𝗹𝘀:

GPAY : 9677876445

Bank Name : Indian bank
Account Number : 722473240
Account Name : Jayam Web Solutions
Branch : West Tambaram-Chennai
IFSC Code : IDIB000T092
Account Type : Current Account

Let us know if there are any queries.
-- 

Thanks & Regards,
Lakshmi.L 
Jayam Web Solutions 
+91 9677 87 6445 / 98405 99789 
www.jayamwebsolutions.com`;
    } else if (name.toLowerCase() === 'deletion') {
      defaultSubject = "FINAL NOTICE: Service Deletion - JAYAM WEB SOLUTIONS";
      defaultContent = `Dear Sir/Ma’am,

This is a final reminder regarding the renewal of services. Your services have expired and are pending deletion.

[product table]

Despite our previous renewal reminders, we have not yet received the renewal payment or any confirmation from your end. Please note that if payment is not received, the domain may be permanently deleted, and the website, emails, and associated data may no longer be recoverable.

Kindly make payment [price]/-INR ([priceWords]) for One year & confirm with payment transaction details.

𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗱𝗲𝘁𝗮𝗶𝗹𝘀:

GPAY : 9677876445

Bank Name : Indian bank
Account Number : 722473240
Account Name : Jayam Web Solutions
Branch : West Tambaram-Chennai
IFSC Code : IDIB000T092
Account Type : Current Account

Let us know if there are any queries.
-- 

Thanks & Regards,
Lakshmi.L 
Jayam Web Solutions 
+91 9677 87 6445 / 98405 99789 
www.jayamwebsolutions.com`;
    } else if (name.toLowerCase() === 'payment' || name.toLowerCase() === 'paymentconfirmation' || name.toLowerCase() === 'payment confirmation') {
      defaultSubject = "Payment Confirmation – Renewal of [Service Name] – Paid";
      defaultContent = `Jayam Web Solutions

Thank you for your payment.

We are pleased to confirm that the payment for the renewal of [Service Name] has been successfully received.`;
    }

    if (!template) {
      if (name === 'Renewal' || name.toLowerCase() === 'renewal') {
        const reminderTemplate = await Template.findOne({ name: 'Reminder' });
        if (reminderTemplate) {
          template = {
            name,
            subject: reminderTemplate.subject || defaultSubject,
            content: reminderTemplate.content || defaultContent
          };
        }
      }

      if (!template) {
        template = {
          name,
          subject: defaultSubject,
          content: defaultContent
        };
      }
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// @desc    Save or Update template
// @route   POST /api/templates
// @access  Private
const saveTemplate = async (req, res) => {
  try {
    const { name, subject, content } = req.body;
    let template = await Template.findOne({ name });
    if (template) {
      template.subject = subject;
      template.content = content;
      await template.save();
    } else {
      template = await Template.create({ name, subject, content });
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
module.exports = {
  getTemplate,
  saveTemplate
};

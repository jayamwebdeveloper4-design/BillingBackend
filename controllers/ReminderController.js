
const mongoose = require('mongoose');

const CustomerProduct = require('../models/CustomerProduct');
const sendEmail = require('../utils/sendEmail');

const {
  isRenewedStatus,
  getReminderEligibility,
  getReminderMonths,
  isWithinReminderWindow
} = require('../utils/renewalHelpers');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// --------------------------------------------------
// 1. SEND RENEWAL REMINDER
// --------------------------------------------------

exports.sendRenewalReminder = async (req, res) => {
  try {
    const productId =
      req.params.id ||
      req.body.productId ||
      req.body.reminderId ||
      req.body._id;

    const reminderName = (
      req.body.reminderName ||
      req.body.name ||
      'Time1'
    ).trim();

    const nMonths = getReminderMonths(req.body.nMonths);

    if (!isValidId(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID'
      });
    }

    const product = await CustomerProduct.findById(productId)
      .populate('customerId', 'name email phone companyName')
      .populate('orderId', 'domainUrl')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Renewal product not found'
      });
    }

    const currentStatus = (
      product.renewalStatus || 'upcoming'
    ).toLowerCase();

    // Block renewed products
    if (isRenewedStatus(currentStatus)) {
      return res.status(400).json({
        success: false,
        blocked: true,
        message: 'Block All Reminders: This product is already RENEWED or YEARLY RENEWED (PAID). Reminder notification is suppressed.'
      });
    }

    // Reminder window validation
    const isInWindow = isWithinReminderWindow(
      product.endDate,
      nMonths
    );

    if (!isInWindow && req.body.forceManual !== true) {
      return res.status(400).json({
        success: false,
        outsideWindow: true,
        message: `Product is outside the reminder window (${nMonths} months before end date). Reminders suppressed.`
      });
    }

    const customer = product.customerId;
    const recipientEmail =
      req.body.recipientEmail || customer?.email;

    let emailSent = false;
    let emailError = null;

    if (recipientEmail) {
      try {
        const domain =
          product.domainUrl ||
          product.orderId?.domainUrl ||
          '';

        const subject =
          req.body.subject ||
          `Renewal Reminder (${reminderName}) for ${product.product} - ${domain || 'Jayam'}`;

        const content =
          req.body.content ||
          `Dear ${customer?.name || 'Customer'},

This is a renewal reminder regarding your service ${product.product} (${product.variant || ''}).
End Date: ${product.endDate}
Amount: Rs. ${product.price}/-

Please make payment to avoid interruption.

Thank you,
Jayam Web Solutions`;

        await sendEmail({
          to: recipientEmail,
          subject,
          text: content,
          html: content.replace(/\n/g, '<br/>')
        });

        emailSent = true;

      } catch (err) {
        console.warn(
          '[ReminderController] Email dispatch failed:',
          err.message
        );

        emailError = err.message;
      }
    }

    const now = new Date();
    const todayDate = [
      String(now.getDate()).padStart(2, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      now.getFullYear()
    ].join('.');

    let currentCount = 0;
    if (Array.isArray(product.reminder) && product.reminder.length > 0) {
      const last = product.reminder[product.reminder.length - 1];
      currentCount = Number(last?.count) || product.reminder.length;
    } else if (product.reminder && typeof product.reminder === 'object' && product.reminder.count) {
      currentCount = Number(product.reminder.count) || 0;
    }

    const newReminderEntry = {
      reminder: 'send',
      date: todayDate,
      count: currentCount + 1
    };

    if (Array.isArray(product.reminder)) {
      await CustomerProduct.findByIdAndUpdate(
        productId,
        {
          $push: { reminder: newReminderEntry }
        }
      );
    } else {
      await CustomerProduct.findByIdAndUpdate(
        productId,
        {
          $set: { reminder: [newReminderEntry] }
        }
      );
    }

    return res.json({
      success: true,
      message: `Reminder '${reminderName}' successfully processed and recorded.`,
      data: {
        productId,
        reminder: newReminderEntry,
        renewalStatus: currentStatus,
        emailSent,
        emailError: emailError || undefined
      }
    });

  } catch (err) {
    console.error(
      '[ReminderController] sendRenewalReminder error:',
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

// --------------------------------------------------
// 2. GET REMINDER ELIGIBILITY STATUS
// --------------------------------------------------

exports.getReminderEligibility = async (req, res) => {
  try {
    const { id } = req.params;
    const nMonths = getReminderMonths(req.query.nMonths);

    if (!isValidId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID'
      });
    }

    const product = await CustomerProduct.findById(id)
      .select(
        'product variant renewalStatus reminder endDate productType deactive'
      )
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const eligibility = getReminderEligibility(
      product,
      nMonths
    );

    return res.json({
      success: true,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      details: {
        renewalStatus: eligibility.currentStatus,
        lastReminder: product.reminder || 'None',
        isInWindow: eligibility.isInWindow,
        isExpired: eligibility.isExpired,
        endDate: product.endDate
      }
    });

  } catch (err) {
    console.error(
      '[ReminderController] getReminderEligibility error:',
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

// --------------------------------------------------
// 3. BULK DISPATCH REMINDERS
// --------------------------------------------------

exports.bulkSendReminders = async (req, res) => {
  try {
    const reminderName = (
      req.body.reminderName || 'Time1'
    ).trim();

    const nMonths = getReminderMonths(req.body.nMonths);

    const candidates = await CustomerProduct.find({
      productType: 'Renewal',
      deactive: false,
      renewalStatus: {
        $nin: ['renewed', 'yearly renewed', 'renewald']
      }
    })
      .select('_id endDate')
      .lean();

    const eligibleIds = [];

    for (const candidate of candidates) {
      if (
        isWithinReminderWindow(candidate.endDate, nMonths)
      ) {
        eligibleIds.push(candidate._id);
      }
    }

    if (eligibleIds.length === 0) {
      return res.json({
        success: true,
        message: 'No eligible unpaid products currently in reminder window.',
        dispatchedCount: 0
      });
    }

    const now = new Date();
    const todayDate = [
      String(now.getDate()).padStart(2, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      now.getFullYear()
    ].join('.');

    await CustomerProduct.updateMany(
      {
        _id: { $in: eligibleIds }
      },
      {
        $push: {
          reminder: {
            reminder: 'send',
            date: todayDate,
            count: 1
          }
        }
      }
    );

    return res.json({
      success: true,
      message: `Successfully triggered bulk reminders for ${eligibleIds.length} eligible products.`,
      dispatchedCount: eligibleIds.length,
      reminderName
    });

  } catch (err) {
    console.error(
      '[ReminderController] bulkSendReminders error:',
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

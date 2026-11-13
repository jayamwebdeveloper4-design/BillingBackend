const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const Expense = require('../../models/Expenses');

const receiptDirectory = path.join(__dirname, '../../private-uploads/expenses');
const maxPageSize = 100;

const categoryByLabel = Object.freeze({
  Salary: 'salary',
  'Miscellaneous': 'other',
  'Internet bill': 'internet',
  'Office rent': 'officeRent',
  'Office Maintenance': 'officeMaintenance',
  Furniture: 'furniture',
});

const labelByCategory = Object.freeze(
  Object.fromEntries(
    Object.entries(categoryByLabel).map(([label, category]) => [category, label]),
  ),
);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const parseDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
};

const serializeExpense = (expense) => ({
  id: String(expense._id),
  name: expense.description,
  amount: expense.amountPaise / 100,
  date: expense.expenseDate.toISOString().slice(0, 10),
  category: labelByCategory[expense.expenseType],
  paymentStatus: expense.paymentStatus || 'pending',
  receiptPath: expense.billDocument
    ? `/expenses/${expense._id}/receipt`
    : null,
});

const getExpenses = async (req, res) => {
  try {
    const { startDate, endDate, category, cursor, month } = req.query;
    const limit = Number(req.query.limit ?? 50);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) {
      return res.status(400).json({ message: `Limit must be between 1 and ${maxPageSize}.` });
    }

    const filter = {};
    if (startDate || endDate) {
      const start = startDate ? parseDate(startDate) : null;
      const end = endDate ? parseDate(endDate) : null;
      if ((startDate && !start) || (endDate && !end)) {
        return res.status(400).json({ message: 'Dates must use the YYYY-MM-DD format.' });
      }
      if (start && end && start > end) {
        return res.status(400).json({ message: 'Start date must not be after end date.' });
      }

      filter.expenseDate = {};
      if (start) filter.expenseDate.$gte = start;
      if (end) {
        const exclusiveEnd = new Date(end);
        exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
        filter.expenseDate.$lt = exclusiveEnd;
      }
    }
    if (category) {
      const expenseType = hasOwn(categoryByLabel, category)
        ? categoryByLabel[category]
        : (hasOwn(labelByCategory, category) ? category : null);
      if (!expenseType) {
        return res.status(400).json({ message: 'Choose a valid expense category.' });
      }
      filter.expenseType = expenseType;
    }

    if (cursor) {
      if (typeof cursor !== 'string' || !/^[\da-f]{24}$/i.test(cursor)) {
        return res.status(400).json({ message: 'Cursor must be a valid expense ID.' });
      }
      const cursorExpense = await Expense.findById(cursor).select('expenseDate').lean();
      if (!cursorExpense) {
        return res.status(400).json({ message: 'Cursor expense was not found.' });
      }
      filter.$or = [
        { expenseDate: { $lt: cursorExpense.expenseDate } },
        { expenseDate: cursorExpense.expenseDate, _id: { $lt: cursorExpense._id } },
      ];
    }

    const now = new Date();
    let monthStart;
    let nextMonthStart;
    if (month === undefined) {
      monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    } else {
      const monthMatch = typeof month === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
      if (!monthMatch) {
        return res.status(400).json({ message: 'Month must use the YYYY-MM format.' });
      }
      const year = Number(monthMatch[1]);
      const monthIndex = Number(monthMatch[2]) - 1;
      monthStart = new Date(Date.UTC(year, monthIndex, 1));
      nextMonthStart = new Date(Date.UTC(year, monthIndex + 1, 1));
    }
    if (month !== undefined) {
      const currentDateFilter = filter.expenseDate || {};
      filter.expenseDate = {
        ...currentDateFilter,
        $gte: currentDateFilter.$gte && currentDateFilter.$gte > monthStart
          ? currentDateFilter.$gte
          : monthStart,
        $lt: currentDateFilter.$lt && currentDateFilter.$lt < nextMonthStart
          ? currentDateFilter.$lt
          : nextMonthStart,
      };
    }
    const summaryFilter = { ...filter };
    delete summaryFilter.$or;
    const summaryQuery = cursor
      ? Promise.resolve([])
      : Expense.aggregate([
        ...(Object.keys(summaryFilter).length ? [{ $match: summaryFilter }] : []),
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalPaise: { $sum: '$amountPaise' },
            monthlyPaise: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$expenseDate', monthStart] },
                      { $lt: ['$expenseDate', nextMonthStart] },
                    ],
                  },
                  '$amountPaise',
                  0,
                ],
              },
            },
          },
        },
      ]);
    const [results, summaryRows] = await Promise.all([
      Expense.find(filter)
        .select('description expenseType amountPaise expenseDate billDocument paymentStatus')
        .sort({ expenseDate: -1, _id: -1 })
        .limit(limit + 1)
        .lean(),
      summaryQuery,
    ]);
    const hasMore = results.length > limit;
    const expenses = results.slice(0, limit);
    const summary = summaryRows[0] || { count: 0, totalPaise: 0, monthlyPaise: 0 };

    return res.json({
      expenses: expenses.map(serializeExpense),
      nextCursor: hasMore ? String(expenses[expenses.length - 1]._id) : null,
      summary: cursor
        ? null
        : {
          count: summary.count,
          totalAmount: summary.totalPaise / 100,
          monthlyAmount: summary.monthlyPaise / 100,
        },
    });
  } catch (error) {
    console.error('[ExpensesController] getExpenses error:', error);
    return res.status(500).json({ message: 'Failed to fetch expenses.' });
  }
};

const createExpense = async (req, res) => {
  let savedReceiptPath;

  try {
    const { name, amount, category, date } = req.body || {};
    const description = typeof name === 'string' ? name.trim() : '';
    const amountText = typeof amount === 'string'
      ? amount.trim()
      : (typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : '');
    const expenseType = hasOwn(categoryByLabel, category)
      ? categoryByLabel[category]
      : null;
    const expenseDate = parseDate(date);

    if (!description || description.length > 200) {
      return res.status(400).json({ message: 'Description is required and must be 200 characters or fewer.' });
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) {
      return res.status(400).json({ message: 'Amount must be a positive number with up to 2 decimal places.' });
    }
    const amountPaise = Math.round(Number(amountText) * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) {
      return res.status(400).json({ message: 'Amount must be a valid positive amount in rupees.' });
    }
    if (!expenseType) {
      return res.status(400).json({ message: 'Choose a valid expense category.' });
    }
    if (!expenseDate) {
      return res.status(400).json({ message: 'Date must use the YYYY-MM-DD format.' });
    }

    let billDocument;
    if (req.file) {
      const extension = detectReceiptExtension(req.file.buffer);
      if (!extension) {
        return res.status(400).json({ message: 'Receipt must be a valid PDF or supported image.' });
      }

      const fileName = `${crypto.randomUUID()}.${extension}`;
      await fs.mkdir(receiptDirectory, { recursive: true });
      savedReceiptPath = path.join(receiptDirectory, fileName);
      await fs.writeFile(savedReceiptPath, req.file.buffer, { flag: 'wx' });
      billDocument = fileName;
    }

    const expense = await Expense.create({
      description,
      expenseType,
      amountPaise,
      expenseDate,
      billDocument,
    });

    return res.status(201).json({ expense: serializeExpense(expense) });
  } catch (error) {
    if (savedReceiptPath) {
      try {
        await fs.unlink(savedReceiptPath);
      } catch (cleanupError) {
        console.error('[ExpensesController] Failed to remove unlinked receipt:', cleanupError);
      }
    }

    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: 'Expense details are invalid.' });
    }
    console.error('[ExpensesController] createExpense error:', error);
    return res.status(500).json({ message: 'Failed to create expense.' });
  }
};

const updateExpense = async (req, res) => {
  try {
    if (!/^[\da-f]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid expense ID.' });
    }

    const { name, amount, category, date, paymentStatus } = req.body || {};
    const description = typeof name === 'string' ? name.trim() : '';
    const amountText = typeof amount === 'string'
      ? amount.trim()
      : (typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : '');
    const expenseType = hasOwn(categoryByLabel, category)
      ? categoryByLabel[category]
      : null;
    const expenseDate = parseDate(date);

    if (!description || description.length > 200) {
      return res.status(400).json({ message: 'Description is required and must be 200 characters or fewer.' });
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) {
      return res.status(400).json({ message: 'Amount must be a positive number with up to 2 decimal places.' });
    }
    const amountPaise = Math.round(Number(amountText) * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) {
      return res.status(400).json({ message: 'Amount must be a valid positive amount in rupees.' });
    }
    if (!expenseType) {
      return res.status(400).json({ message: 'Choose a valid expense category.' });
    }
    if (!expenseDate) {
      return res.status(400).json({ message: 'Date must use the YYYY-MM-DD format.' });
    }
    if (!['pending', 'paid', 'cancelled'].includes(paymentStatus)) {
      return res.status(400).json({ message: 'Choose a valid payment status.' });
    }

    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found.' });
    }

    expense.description = description;
    expense.expenseType = expenseType;
    expense.amountPaise = amountPaise;
    expense.expenseDate = expenseDate;
    expense.paymentStatus = paymentStatus;
    await expense.save();

    return res.json({ expense: serializeExpense(expense) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: 'Expense details are invalid.' });
    }
    console.error('[ExpensesController] updateExpense error:', error);
    return res.status(500).json({ message: 'Failed to update expense.' });
  }
};

const detectReceiptExtension = (buffer) => {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  return null;
};

const getExpenseReceipt = async (req, res) => {
  try {
    if (!/^[\da-f]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid expense ID.' });
    }

    const expense = await Expense.findById(req.params.id).select('billDocument').lean();
    if (!expense || !expense.billDocument) {
      return res.status(404).json({ message: 'Receipt not found.' });
    }
    if (!/^[\da-f-]{36}\.(pdf|jpg|gif|bmp|webp|png)$/i.test(expense.billDocument)) {
      console.error('[ExpensesController] Invalid stored receipt filename for expense:', req.params.id);
      return res.status(500).json({ message: 'Receipt is unavailable.' });
    }

    const filePath = path.join(receiptDirectory, expense.billDocument);
    const mimeTypeByExtension = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      png: 'image/png',
    };
    res.type(mimeTypeByExtension[path.extname(filePath).slice(1).toLowerCase()]);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', `inline; filename="receipt${path.extname(filePath)}"`);
    return res.sendFile(filePath, (error) => {
      if (error) {
        if (error.code === 'ENOENT' && !res.headersSent) {
          return res.status(404).json({ message: 'Receipt file not found.' });
        }
        console.error('[ExpensesController] getExpenseReceipt error:', error);
        if (!res.headersSent) {
          return res.status(500).json({ message: 'Failed to fetch receipt.' });
        }
      }
      return undefined;
    });
  } catch (error) {
    console.error('[ExpensesController] getExpenseReceipt error:', error);
    return res.status(500).json({ message: 'Failed to fetch receipt.' });
  }
};

module.exports = { getExpenses, createExpense, updateExpense, getExpenseReceipt };

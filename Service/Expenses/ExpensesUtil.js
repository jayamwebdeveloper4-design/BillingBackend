const cron = require('node-cron');
const Expense = require('../../models/Expenses');
const projectDB = require('../../ProjectTool/DBconnection');
const {
  employeeNameProjection,
  getEmployeeDisplayName,
} = require('../../ProjectTool/services/employeeDisplayName');
const {
  parseMonthlySalaryPaise,
  calculateProratedSalaryPaise,
} = require('../../ProjectTool/services/employeePayroll');

const PAYROLL_TIME_ZONE = 'Asia/Kolkata';
const BULK_WRITE_SIZE = 500;

const getMonthRange = (period) => {
  const match = typeof period === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) {
    throw new Error('Payroll period must use the YYYY-MM format.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1));
  return {
    period,
    startDate,
    endDate,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
};

const getMonthParts = (date = new Date()) => {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: PAYROLL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(dateParts.find((part) => part.type === 'year').value),
    month: Number(dateParts.find((part) => part.type === 'month').value),
  };
};

const getCurrentMonthPeriod = (date = new Date()) => {
  const { year, month } = getMonthParts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
};

const getPreviousMonthPeriod = (date = new Date()) => {
  const { year, month } = getMonthParts(date);
  const previousMonth = new Date(Date.UTC(year, month - 2, 1));
  return `${previousMonth.getUTCFullYear()}-${String(previousMonth.getUTCMonth() + 1).padStart(2, '0')}`;
};

const getTimesheetMinutesByEmployee = async (db, employees, startDate, endDate) => {
  const employeeIds = employees.map((employee) => employee._id);
  const employeeIdValues = employeeIds.flatMap((id) => [id, String(id)]);
  const startDateText = startDate.toISOString().slice(0, 10);
  const endDateText = endDate.toISOString().slice(0, 10);
  const summaries = await db.collection('timesheets')
    .aggregate([
      {
        $match: {
          $and: [
            {
              $or: [
                { employeeId: { $in: employeeIdValues } },
                { 'entries.employeeId': { $in: employeeIdValues } },
              ],
            },
            {
              $or: [
                { workDate: { $gte: startDate, $lt: endDate } },
                { date: { $gte: startDate, $lt: endDate } },
                { workDate: { $gte: startDateText, $lt: endDateText } },
                { date: { $gte: startDateText, $lt: endDateText } },
              ],
            },
          ],
        },
      },
      {
        $unwind: {
          path: '$entries',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          employeeId: {
            $convert: {
              input: { $ifNull: ['$employeeId', '$entries.employeeId'] },
              to: 'objectId',
              onError: null,
              onNull: null,
            },
          },
          workDate: {
            $convert: {
              input: { $ifNull: ['$workDate', '$date'] },
              to: 'date',
              onError: null,
              onNull: null,
            },
          },
          minutes: {
            $let: {
              vars: {
                rawMinutes: {
                  $ifNull: [
                    '$entries.totalMinutes',
                    { $cond: [{ $eq: ['$entries', null] }, '$totalMinutes', null] },
                  ],
                },
                rawHours: {
                  $ifNull: [
                    '$entries.totalWorkingHours',
                    { $cond: [{ $eq: ['$entries', null] }, '$totalWorkingHours', null] },
                  ],
                },
              },
              in: {
                $let: {
                  vars: {
                    numericMinutes: {
                      $convert: {
                        input: '$$rawMinutes',
                        to: 'double',
                        onError: null,
                        onNull: null,
                      },
                    },
                    numericHours: {
                      $convert: {
                        input: '$$rawHours',
                        to: 'double',
                        onError: null,
                        onNull: null,
                      },
                    },
                    hoursMatch: {
                      $regexFind: {
                        input: {
                          $convert: {
                            input: '$$rawHours',
                            to: 'string',
                            onError: '',
                            onNull: '',
                          },
                        },
                        regex: /\d+(?:\.\d+)?/,
                      },
                    },
                  },
                  in: {
                    $ifNull: [
                      '$$numericMinutes',
                      {
                        $multiply: [
                          {
                            $ifNull: [
                              '$$numericHours',
                              {
                                $convert: {
                                  input: '$$hoursMatch.match',
                                  to: 'double',
                                  onError: 0,
                                  onNull: 0,
                                },
                              },
                            ],
                          },
                          60,
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      {
        $match: {
          employeeId: { $in: employeeIds },
          workDate: { $gte: startDate, $lt: endDate },
          minutes: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$employeeId',
          totalMinutes: { $sum: '$minutes' },
        },
      },
    ], { allowDiskUse: true, maxTimeMS: 15000 })
    .toArray();

  return new Map(summaries.map((summary) => [String(summary._id), summary.totalMinutes]));
};

const isOnlyDuplicateKeyError = (error) => {
  const writeErrors = typeof error.getWriteErrors === 'function'
    ? error.getWriteErrors()
    : error.writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.every((writeError) => writeError.code === 11000);
  }
  return error.code === 11000;
};

const createMonthlySalaryExpenses = async (period, { finalized = false } = {}) => {
  const { startDate, endDate, daysInMonth } = getMonthRange(period);
  const db = projectDB.connection.db;
  if (!db || projectDB.connection.readyState !== 1) {
    throw new Error('Project database is not connected; salary expenses were not generated.');
  }
  if (Expense.db.readyState !== 1) {
    throw new Error('Billing database is not connected; salary expenses were not generated.');
  }

  const employees = await db.collection('employees')
    .find(
      { salary: { $exists: true, $ne: null } },
      { projection: { ...employeeNameProjection, salary: 1 } },
    )
    .maxTimeMS(10000)
    .toArray();
  if (!employees.length) return { period, updatedExpenses: 0 };

  const minutesByEmployee = await getTimesheetMinutesByEmployee(
    db,
    employees,
    startDate,
    endDate,
  );
  const standardMonthMinutes = daysInMonth * 8 * 60;
  const expenseDate = finalized
    ? new Date(endDate.getTime() - 1)
    : startDate;
  const operations = [];

  employees.forEach((employee) => {
    const totalMinutes = minutesByEmployee.get(String(employee._id));
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return;

    const monthlySalaryPaise = parseMonthlySalaryPaise(employee.salary);
    if (monthlySalaryPaise === null) {
      throw new Error(`Employee ${employee._id} has an invalid monthly salary.`);
    }

    const amountPaise = calculateProratedSalaryPaise(
      monthlySalaryPaise,
      totalMinutes,
      standardMonthMinutes,
    );
    if (!Number.isSafeInteger(amountPaise)) {
      throw new Error(`Calculated salary expense is invalid for employee ${employee._id}.`);
    }
    if (amountPaise < 1) return;

    const employeeName = getEmployeeDisplayName(employee) || String(employee._id);
    operations.push({
      updateOne: {
        filter: {
          expenseType: 'salary',
          employeeId: employee._id,
          payPeriod: period,
          payrollFinalized: { $ne: true },
          paymentStatus: { $nin: ['paid', 'cancelled'] },
        },
        update: {
          $set: {
            description: `Salary - ${employeeName} (${period})`.slice(0, 200),
            expenseType: 'salary',
            employeeId: employee._id,
            payPeriod: period,
            amountPaise,
            expenseDate,
            payrollFinalized: finalized,
          },
        },
        upsert: true,
      },
    });
  });

  if (!operations.length) return { period, updatedExpenses: 0 };
  const existingExpenses = await Expense.find({
    expenseType: 'salary',
    employeeId: { $in: operations.map((operation) => operation.updateOne.filter.employeeId) },
    payPeriod: period,
  })
    .select('employeeId paymentStatus payrollFinalized')
    .lean();
  const existingByEmployeeId = new Map(
    existingExpenses.map((expense) => [String(expense.employeeId), expense]),
  );
  const writableOperations = operations.filter((operation) => {
    const existing = existingByEmployeeId.get(
      String(operation.updateOne.filter.employeeId),
    );
    return !existing
      || (
        existing.paymentStatus !== 'paid'
        && existing.paymentStatus !== 'cancelled'
        && existing.payrollFinalized !== true
      );
  });

  let updatedExpenses = 0;
  for (let index = 0; index < writableOperations.length; index += BULK_WRITE_SIZE) {
    try {
      const result = await Expense.bulkWrite(
        writableOperations.slice(index, index + BULK_WRITE_SIZE),
        { ordered: false },
      );
      updatedExpenses += result.upsertedCount + result.modifiedCount;
    } catch (error) {
      if (!isOnlyDuplicateKeyError(error)) throw error;
      updatedExpenses += error.result?.upsertedCount || 0;
      console.warn(
        `[SalaryExpenses] Locked or concurrent salary records were left unchanged for ${period}.`,
      );
    }
  }

  return { period, updatedExpenses };
};

let salaryScheduleStarted = false;
let salaryGenerationRunning = false;

const runMonthlySalaryGeneration = async () => {
  if (salaryGenerationRunning) return;
  salaryGenerationRunning = true;
  try {
    const previousPeriod = getPreviousMonthPeriod();
    const currentPeriod = getCurrentMonthPeriod();
    const previousResult = await createMonthlySalaryExpenses(
      previousPeriod,
      { finalized: true },
    );
    const currentResult = await createMonthlySalaryExpenses(currentPeriod);
    console.info(`[SalaryExpenses] Updated ${previousResult.updatedExpenses} finalized expense(s) for ${previousPeriod}.`);
    console.info(`[SalaryExpenses] Updated ${currentResult.updatedExpenses} current-month expense(s) for ${currentPeriod}.`);
  } catch (error) {
    console.error('[SalaryExpenses] Monthly generation failed:', error);
  } finally {
    salaryGenerationRunning = false;
  }
};

const startMonthlySalaryExpenseSchedule = () => {
  if (salaryScheduleStarted) return;
  salaryScheduleStarted = true;

  cron.schedule('5 0 * * *', runMonthlySalaryGeneration, {
    timezone: PAYROLL_TIME_ZONE,
  });
  void runMonthlySalaryGeneration();
};

module.exports = {
  createMonthlySalaryExpenses,
  startMonthlySalaryExpenseSchedule,
};
const mongoose = require('mongoose');
const projectDB = require('../DBconnection');
const ProjectTimesheet = require('../Models/ProjectTimesheet');
const ProjectClient = require('../Models/ProjectClient');
const {
  employeeNameProjection,
  getEmployeeDisplayName,
} = require('../services/employeeDisplayName');
const {
  parseMonthlySalaryPaise,
  calculateProratedSalaryPaise,
} = require('../services/employeePayroll');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const parseLimit = (value) => {
  if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    return null;
  }
  const limit = value === undefined ? DEFAULT_LIMIT : Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT
    ? limit
    : null;
};

const parseCursor = (value) => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[\da-f]{24}$/i.test(value)) return false;
  return new mongoose.Types.ObjectId(value);
};

const idQueryValues = (id) => [id, String(id)];

const normalizeObjectId = (value) => {
  const stringValue = value == null ? '' : String(value);
  return /^[\da-f]{24}$/i.test(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
    : null;
};

const getProjectClientsById = async (projects) => {
  const clientIds = [...new Map(
    projects
      .map((project) => normalizeObjectId(project.clientId))
      .filter(Boolean)
      .map((id) => [String(id), id]),
  ).values()];
  const billingCustomerIds = [...new Map(
    projects
      .map((project) => normalizeObjectId(project.billingCustomerId || project.customerId))
      .filter(Boolean)
      .map((id) => [String(id), id]),
  ).values()];
  const clauses = [];
  if (clientIds.length) clauses.push({ _id: { $in: clientIds } });
  if (billingCustomerIds.length) {
    clauses.push({ billingCustomerId: { $in: billingCustomerIds } });
  }
  if (!clauses.length) return { byId: new Map(), byBillingCustomerId: new Map() };

  const clients = await ProjectClient.find({ $or: clauses })
    .select('billingCustomerId clientName phone email')
    .maxTimeMS(5000)
    .lean();
  return {
    byId: new Map(clients.map((client) => [String(client._id), client])),
    byBillingCustomerId: new Map(
      clients
        .filter((client) => client.billingCustomerId)
        .map((client) => [String(client.billingCustomerId), client]),
    ),
  };
};

const withCustomerDetails = (project, clientsById) => {
  const clientId = normalizeObjectId(project.clientId);
  const billingCustomerId = normalizeObjectId(project.billingCustomerId || project.customerId);
  const client = (clientId && clientsById.byId.get(String(clientId)))
    || (billingCustomerId
      && clientsById.byBillingCustomerId.get(String(billingCustomerId)))
    || null;
  return {
    ...project,
    customerName: client?.clientName || project.customerName || '',
    customerPhone: client?.phone?.length
      ? client.phone
      : project.customerPhone || [],
    customerEmail: client?.email?.length
      ? client.email
      : project.customerEmail || [],
  };
};

const parseDate = (value) => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? false
    : date;
};

const parseMonth = (value) => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return false;
  const month = Number(value);
  return month >= 1 && month <= 12 ? month : false;
};

const parseYear = (value) => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return false;
  const year = Number(value);
  return year >= 1000 && year <= 9999 ? year : false;
};

const getTimesheetWorkStages = (entityField, entityIds, dateRange) => {
  const matchingIds = entityIds.flatMap(idQueryValues);
  return [
  {
    $match: entityField === 'projectId'
      ? {
        $or: [
          { projectId: { $in: matchingIds } },
          { 'entries.projectId': { $in: matchingIds } },
        ],
      }
      : { employeeId: { $in: matchingIds } },
  },
  {
    $unwind: {
      path: '$entries',
      preserveNullAndEmptyArrays: true,
    },
  },
  {
    $project: {
      entityId: entityField === 'projectId'
        ? {
          $convert: {
            input: { $ifNull: ['$entries.projectId', '$projectId'] },
            to: 'objectId',
            onError: null,
            onNull: null,
          },
        }
        : {
          $convert: {
            input: '$employeeId',
            to: 'objectId',
            onError: null,
            onNull: null,
          },
        },
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
            numericMinutes: {
              $convert: {
                input: { $ifNull: ['$entries.totalMinutes', '$totalMinutes'] },
                to: 'double',
                onError: null,
                onNull: null,
              },
            },
            numericHours: {
              $convert: {
                input: { $ifNull: ['$entries.totalWorkingHours', '$totalWorkingHours'] },
                to: 'double',
                onError: null,
                onNull: null,
              },
            },
            hoursMatch: {
              $regexFind: {
                input: {
                  $convert: {
                    input: { $ifNull: ['$entries.totalWorkingHours', '$totalWorkingHours'] },
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
  {
    $match: {
      entityId: { $in: entityIds },
      workDate: {
        $ne: null,
        ...(dateRange.startDate ? { $gte: dateRange.startDate } : {}),
        ...(dateRange.endDate ? { $lt: dateRange.endDate } : {}),
      },
    },
  },
  ];
};

const projectWorkSummary = (entityField, entityIds, dateRange) =>
  ProjectTimesheet.aggregate([
  ...getTimesheetWorkStages(entityField, entityIds, dateRange),
  {
    $group: {
      _id: {
        entityId: '$entityId',
        workDate: {
          $dateToString: {
            date: '$workDate',
            format: '%Y-%m-%d',
            timezone: 'UTC',
          },
        },
      },
      minutes: { $sum: '$minutes' },
      employeeIds: { $addToSet: '$employeeId' },
    },
  },
  {
    $group: {
      _id: '$_id.entityId',
      workDays: { $sum: 1 },
      totalHours: { $sum: { $divide: ['$minutes', 60] } },
      employeeIdGroups: { $push: '$employeeIds' },
    },
  },
  {
    $project: {
      workDays: 1,
      totalHours: 1,
      employeeIds: {
        $reduce: {
          input: '$employeeIdGroups',
          initialValue: [],
          in: { $setUnion: ['$$value', '$$this'] },
        },
      },
    },
  },
  ]).option({ allowDiskUse: true, maxTimeMS: 10000 });

const projectEmployeeWorkSummary = (projectIds, dateRange) =>
  ProjectTimesheet.aggregate([
    ...getTimesheetWorkStages('projectId', projectIds, dateRange),
    {
      $match: {
        employeeId: { $ne: null },
        minutes: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: {
          projectId: '$entityId',
          employeeId: '$employeeId',
          period: {
            $dateToString: {
              date: '$workDate',
              format: '%Y-%m',
              timezone: 'UTC',
            },
          },
        },
        totalMinutes: { $sum: '$minutes' },
      },
    },
  ]).option({ allowDiskUse: true, maxTimeMS: 10000 });

const getProjectEmployeeCosts = async (db, projectIds, dateRange) => {
  const employeeWorkRows = await projectEmployeeWorkSummary(projectIds, dateRange);
  const employeeIds = [...new Map(
    employeeWorkRows.map((row) => [
      String(row._id.employeeId),
      row._id.employeeId,
    ]),
  ).values()];
  const employees = employeeIds.length
    ? await db.collection('employees')
      .find(
        { _id: { $in: employeeIds } },
        { projection: { ...employeeNameProjection, salary: 1 } },
      )
      .maxTimeMS(5000)
      .toArray()
    : [];
  const employeeById = new Map(
    employees.map((employee) => [
      String(employee._id),
      {
        name: getEmployeeDisplayName(employee),
        salaryPaise: parseMonthlySalaryPaise(employee.salary),
        hasSalary: employee.salary !== undefined && employee.salary !== null,
      },
    ]),
  );
  const costsByProject = new Map();

  employeeWorkRows.forEach((workRow) => {
    const projectId = String(workRow._id.projectId);
    const employeeId = String(workRow._id.employeeId);
    const employee = employeeById.get(employeeId);
    if (employee?.hasSalary && employee.salaryPaise === null) {
      throw new Error(`Employee ${employeeId} has an invalid monthly salary.`);
    }

    const costs = costsByProject.get(projectId) || new Map();
    const cost = costs.get(employeeId) || {
      employeeId,
      name: employee?.name || 'Unnamed employee',
      totalMinutes: 0,
      amountPaise: employee?.salaryPaise === null || !employee ? null : 0,
    };
    const [year, month] = workRow._id.period.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    cost.totalMinutes += workRow.totalMinutes;
    if (cost.amountPaise !== null && employee) {
      const amountPaise = calculateProratedSalaryPaise(
        employee.salaryPaise,
        workRow.totalMinutes,
        daysInMonth * 8 * 60,
      );
      if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
        throw new Error(`Calculated salary expense is invalid for employee ${employeeId}.`);
      }
      cost.amountPaise += amountPaise;
    }
    costs.set(employeeId, cost);
    costsByProject.set(projectId, costs);
  });

  return new Map(projectIds.map((projectId) => {
    const employeeCosts = [
      ...(costsByProject.get(String(projectId))?.values() || []),
    ]
      .map((cost) => ({
        employeeId: cost.employeeId,
        name: cost.name,
        hours: cost.totalMinutes / 60,
        amount: cost.amountPaise === null ? null : cost.amountPaise / 100,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const expenseAmount = employeeCosts.length > 0
      && employeeCosts.every((cost) => cost.amount !== null)
      ? Math.round(employeeCosts.reduce((total, cost) => total + cost.amount, 0) * 100) / 100
      : null;
    return [String(projectId), { employeeCosts, expenseAmount }];
  }));
};

const getEmployeeView = async (db, limit, cursor, dateRange) => {
  const employeeFilter = { status: 'Active' };
  if (cursor) employeeFilter._id = { $lt: cursor };

  const employees = await db.collection('employees')
    .find(employeeFilter, {
      projection: {
        ...employeeNameProjection,
        email: 1,
        phone: 1,
        salary: 1,
        joiningDate: 1,
        increments: 1,
      },
    })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(5000)
    .toArray();

  const hasMore = employees.length > limit;
  const data = hasMore ? employees.slice(0, limit) : employees;
  const summaries = data.length
    ? await projectWorkSummary('employeeId', data.map((employee) => employee._id), dateRange)
    : [];
  const summaryByEmployee = new Map(
    summaries.map((summary) => [String(summary._id), summary]),
  );

  return {
    data: data.map((employee) => {
      const summary = summaryByEmployee.get(String(employee._id));
      return {
        ...employee,
        name: getEmployeeDisplayName(employee),
        workDays: summary?.workDays || 0,
        totalHours: summary?.totalHours || 0,
      };
    }),
    nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
  };
};

const getProjectView = async (db, limit, cursor, dateRange) => {
  const projectFilter = cursor ? { _id: { $lt: cursor } } : {};
  const projects = await db.collection('projects')
    .find(projectFilter, {
      projection: {
        projectName: 1,
        serviceName: 1,
        clientId: 1,
        billingCustomerId: 1,
        customerId: 1,
        customerName: 1,
        customerPhone: 1,
        customerEmail: 1,
        budget: 1,
      },
    })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(5000)
    .toArray();

  const hasMore = projects.length > limit;
  const data = hasMore ? projects.slice(0, limit) : projects;
  const clientsById = await getProjectClientsById(data);
  const [summaries, employeeCostsByProject] = data.length
    ? await Promise.all([
      projectWorkSummary('projectId', data.map((project) => project._id), dateRange),
      getProjectEmployeeCosts(db, data.map((project) => project._id), dateRange),
    ])
    : [[], new Map()];
  const summaryByProject = new Map(
    summaries.map((summary) => [String(summary._id), summary]),
  );
  const employeeIds = [...new Map(
    summaries.flatMap((summary) =>
      (summary.employeeIds || []).filter(Boolean).map((id) => [String(id), id])),
  ).values()];
  const employees = employeeIds.length
    ? await db.collection('employees')
      .find(
        { _id: { $in: employeeIds } },
        { projection: { ...employeeNameProjection, email: 1 } },
      )
      .maxTimeMS(5000)
      .toArray()
    : [];
  const employeeById = new Map(
    employees.map((employee) => [
      String(employee._id),
      {
        _id: employee._id,
        name: getEmployeeDisplayName(employee),
        email: employee.email,
      },
    ]),
  );

  return {
    data: data.map((project) => {
      const summary = summaryByProject.get(String(project._id));
      const costs = employeeCostsByProject.get(String(project._id))
        || { employeeCosts: [], expenseAmount: null };
      return {
        ...withCustomerDetails(project, clientsById),
        workDays: summary?.workDays || 0,
        totalHours: summary?.totalHours || 0,
        employees: (summary?.employeeIds || [])
          .map((id) => employeeById.get(String(id)))
          .filter(Boolean)
          .map(({ _id, name, email }) => ({ _id, name, email })),
        ...costs,
      };
    }),
    nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
  };
};

const getTimesheetDetails = async (db, entityField, entityId, limit, cursor, dateRange) => {
  const matchingIds = idQueryValues(entityId);
  const clauses = [
    entityField === 'projectId'
      ? {
        $or: [
          { projectId: { $in: matchingIds } },
          { 'entries.projectId': { $in: matchingIds } },
        ],
      }
      : { employeeId: { $in: matchingIds } },
  ];
  if (cursor) clauses.push({ _id: { $lt: cursor } });
  if (dateRange.startDate || dateRange.endDate) {
    const workDate = {
      $convert: {
        input: { $ifNull: ['$workDate', '$date'] },
        to: 'date',
        onError: null,
        onNull: null,
      },
    };
    clauses.push({
      $expr: {
        $and: [
          ...(dateRange.startDate ? [{ $gte: [workDate, dateRange.startDate] }] : []),
          ...(dateRange.endDate ? [{ $lt: [workDate, dateRange.endDate] }] : []),
        ],
      },
    });
  }
  const filter = clauses.length === 1 ? clauses[0] : { $and: clauses };

  const records = await db.collection('timesheets')
    .find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(5000)
    .toArray();
  const hasMore = records.length > limit;
  const selectedRecords = hasMore ? records.slice(0, limit) : records;
  const data = selectedRecords.flatMap((record) => {
    const entries = Array.isArray(record.entries) && record.entries.length
      ? record.entries
      : [record];
    return entries.flatMap((entry, index) => {
      const rawProjectId = entry.projectId || record.projectId || null;
      const projectId = normalizeObjectId(rawProjectId) || rawProjectId;
      if (entityField === 'projectId' && String(projectId) !== String(entityId)) return [];
      const rawEmployeeId = record.employeeId || entry.employeeId || null;
      const employeeId = normalizeObjectId(rawEmployeeId) || rawEmployeeId;

      const normalized = { ...record, ...entry };
      delete normalized.entries;
      return [{
        ...normalized,
        _id: String(entry._id || `${record._id}-${index}`),
        employeeId,
        projectId,
        date: record.workDate || record.date || entry.startTime || null,
        workDate: record.workDate || record.date || null,
        totalMinutes: entry.totalMinutes
          ?? (record.entries?.length ? null : record.totalMinutes),
        startTime: entry.startTime || null,
        endTime: entry.endTime || null,
      }];
    });
  });
  const employeeIds = [...new Map(
    data.filter((record) => record.employeeId)
      .map((record) => [String(record.employeeId), record.employeeId]),
  ).values()];
  const projectIds = [...new Map(
    data.filter((record) => record.projectId)
      .map((record) => [String(record.projectId), record.projectId]),
  ).values()];

  const [employees, projects] = await Promise.all([
    employeeIds.length
      ? db.collection('employees')
        .find(
          { _id: { $in: employeeIds } },
          { projection: { ...employeeNameProjection, email: 1 } },
        )
        .maxTimeMS(5000)
        .toArray()
      : [],
    projectIds.length
      ? db.collection('projects')
        .find(
          { _id: { $in: projectIds } },
          {
            projection: {
              projectName: 1,
              clientId: 1,
              billingCustomerId: 1,
              customerId: 1,
              customerName: 1,
              customerPhone: 1,
              customerEmail: 1,
              serviceName: 1,
            },
          },
        )
        .maxTimeMS(5000)
        .toArray()
      : [],
  ]);
  const employeeById = new Map(
    employees.map((employee) => [
      String(employee._id),
      { _id: employee._id, name: getEmployeeDisplayName(employee), email: employee.email },
    ]),
  );
  const clientsById = await getProjectClientsById(projects);
  const projectById = new Map(
    projects.map((project) => [
      String(project._id),
      withCustomerDetails(project, clientsById),
    ]),
  );
  const projectCosts = entityField === 'projectId'
    ? await getProjectEmployeeCosts(db, [entityId], dateRange)
    : null;

  return {
    data: data.map((record) => ({
      ...record,
      employee: employeeById.get(String(record.employeeId)) || null,
      project: projectById.get(String(record.projectId)) || null,
    })),
    nextCursor: hasMore ? String(selectedRecords[selectedRecords.length - 1]._id) : null,
    ...(projectCosts ? projectCosts.get(String(entityId)) : {}),
  };
};

const getProjectTimesheet = async (req, res, next) => {
  try {
    const connection = projectDB.connection;
    const db = connection.db;

    if (!db || connection.readyState !== 1) {
      return res.status(503).json({ message: 'Project database is not connected.' });
    }

    const limit = parseLimit(req.query.limit);
    if (!limit) {
      return res.status(400).json({
        message: `Limit must be between 1 and ${MAX_LIMIT}.`,
      });
    }

    const cursor = parseCursor(req.query.cursor);
    if (cursor === false) {
      return res.status(400).json({ message: 'Cursor must be a valid record ID.' });
    }

    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);
    if (startDate === false || endDate === false) {
      return res.status(400).json({ message: 'Dates must be valid calendar dates in YYYY-MM-DD format.' });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ message: 'Start date must not be after end date.' });
    }
    const month = parseMonth(req.query.month);
    const year = parseYear(req.query.year);
    if (month === false || year === false) {
      return res.status(400).json({ message: 'Month or year is invalid.' });
    }
    if (Boolean(month) !== Boolean(year)) {
      return res.status(400).json({ message: 'Month and year must be selected together.' });
    }
    const dateRange = {
      startDate,
      endDate: endDate ? new Date(endDate.getTime() + 24 * 60 * 60 * 1000) : null,
    };
    if (month && year) {
      const monthStart = new Date(Date.UTC(year, month - 1, 1));
      const monthEnd = new Date(Date.UTC(year, month, 1));
      if (!dateRange.startDate || monthStart > dateRange.startDate) {
        dateRange.startDate = monthStart;
      }
      if (!dateRange.endDate || monthEnd < dateRange.endDate) {
        dateRange.endDate = monthEnd;
      }
    }

    const { view } = req.query;
    if (view === 'employees') {
      const result = await getEmployeeView(db, limit, cursor, dateRange);
      return res.status(200).json({ ...result, limit });
    }
    if (view === 'projects') {
      const result = await getProjectView(db, limit, cursor, dateRange);
      return res.status(200).json({ ...result, limit });
    }
    if (view === 'details') {
      const employeeId = parseCursor(req.query.employeeId);
      const projectId = parseCursor(req.query.projectId);
      if (
        employeeId === false
        || projectId === false
        || Boolean(employeeId) === Boolean(projectId)
      ) {
        return res.status(400).json({
          message: 'Provide exactly one valid employeeId or projectId.',
        });
      }

      const result = await getTimesheetDetails(
        db,
        employeeId ? 'employeeId' : 'projectId',
        employeeId || projectId,
        limit,
        cursor,
        dateRange,
      );
      return res.status(200).json({ ...result, limit });
    }
    if (view !== undefined) {
      return res.status(400).json({ message: 'View must be employees, projects, or details.' });
    }

    const filter = cursor ? { _id: { $lt: cursor } } : {};
    const rows = await db.collection('timesheets')
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .toArray();
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return res.status(200).json({
      data,
      limit,
      nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = { getProjectTimesheet };
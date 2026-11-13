const connectProjectDB = require('../DBconnection');
const {
    employeeNameProjection,
    getEmployeeDisplayName,
} = require('../services/employeeDisplayName');



const getActiveEmployees = async (req, res, next) => {
    try {
        const db = connectProjectDB.connection.db;

        if (!db || connectProjectDB.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Project database is not connected' });
        }

        // pagination (never return an unbounded list)
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const skip = (page - 1) * limit;

        const filter = { status: 'Active' };
        const collection = db.collection('employees');

        const [employees, total] = await Promise.all([
            collection
                .find(filter, {
                    projection: {
                        _id: 0,
                        ...employeeNameProjection,
                        email: 1,
                        phone: 1,
                        salary: 1,
                        joiningDate: 1,
                        increments: 1,
                    },
                })
                .sort({ name: 1 })
                .skip(skip)
                .limit(limit)
                .maxTimeMS(5000)
                .toArray(),
            collection.countDocuments(filter),
        ]);

        return res.status(200).json({
            data: employees.map((employee) => ({
                ...employee,
                name: getEmployeeDisplayName(employee),
            })),
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        return next(error);
    }
};

const getActiveEmployeeAttendance = async (req, res, next) => {
    try {
        const db = connectProjectDB.connection.db;

        if (!db || connectProjectDB.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Project database is not connected' });
        }


        const attendance = await db.collection('dailyattendances')
            .aggregate(
                [
                    {
                        $project: {
                            date: 1,
                            'records.employeeId': 1,
                            'records.loginTime': 1,
                            'records.autoLoggedOut': 1,
                            'records.status': 1,
                        },
                    },
                    { $unwind: '$records' },
                    {
                        $lookup: {
                            from: 'employees',
                            let: { employeeId: '$records.employeeId' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $and: [
                                                { $eq: ['$_id', '$$employeeId'] },
                                                { $eq: ['$status', 'Active'] },
                                            ],
                                        },
                                    },
                                },
                                {
                                    $project: {
                                        _id: 0,
                                            ...employeeNameProjection,
                                        email: 1,
                                        phone: 1,
                                        salary: 1,
                                        joiningDate: 1,
                                        increments: 1,
                                    },
                                },
                            ],
                            as: 'employee',
                        },
                    },
                    { $unwind: '$employee' },
                    { $sort: { date: -1, 'records.employeeId': 1 } },
                    {
                        $project: {
                            _id: 0,
                            date: 1,
                            employeeId: '$records.employeeId',
                            name: '$employee.name',
                            employeeName: '$employee.employeeName',
                            fullName: '$employee.fullName',
                            employee_name: '$employee.employee_name',
                            displayName: '$employee.displayName',
                            username: '$employee.username',
                            firstName: '$employee.firstName',
                            lastName: '$employee.lastName',
                            first_name: '$employee.first_name',
                            last_name: '$employee.last_name',
                            salary: '$employee.salary',
                            joiningDate: '$employee.joiningDate',
                            increments: '$employee.increments',
                            loginTime: '$records.loginTime',
                            autoLoggedOut: '$records.autoLoggedOut',
                            status: '$records.status',
                        },
                    },
                ],
                { allowDiskUse: true }
            )
            .toArray();

        const data = attendance.map((record) => {
            const {
                name,
                employeeName,
                fullName,
                employee_name,
                displayName,
                username,
                firstName,
                lastName,
                first_name,
                last_name,
                ...details
            } = record;
            return {
                ...details,
                name: getEmployeeDisplayName({
                    name,
                    employeeName,
                    fullName,
                    employee_name,
                    displayName,
                    username,
                    firstName,
                    lastName,
                    first_name,
                    last_name,
                }),
            };
        });
        return res.status(200).json({ data, total: data.length });
    } catch (error) {
        return next(error);
    }
};



module.exports = { 
    getActiveEmployees,
    getActiveEmployeeAttendance

};


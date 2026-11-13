const mongoose = require('mongoose');
const projectDB = require('../DBconnection');

const projectTimesheetSchema = new mongoose.Schema(
  {
    employeeId: mongoose.Schema.Types.ObjectId,
    projectId: mongoose.Schema.Types.ObjectId,
    date: Date,
  },
  {
    collection: 'timesheets',
    strict: false,
    versionKey: false,
  },
);

projectTimesheetSchema.index({ employeeId: 1, date: -1 });
projectTimesheetSchema.index({ projectId: 1, date: -1 });

module.exports =
  projectDB.connection.models.ProjectTimesheet
  || projectDB.connection.model('ProjectTimesheet', projectTimesheetSchema);

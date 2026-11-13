const employeeNameProjection = {
  name: 1,
  employeeName: 1,
  fullName: 1,
  employee_name: 1,
  displayName: 1,
  username: 1,
  firstName: 1,
  lastName: 1,
  first_name: 1,
  last_name: 1,
};

const getEmployeeDisplayName = (employee) => {
  const directName = [
    employee.name,
    employee.employeeName,
    employee.fullName,
    employee.employee_name,
    employee.displayName,
    employee.username,
  ].find((value) => typeof value === 'string' && value.trim());

  if (directName) return directName.trim();

  const firstName = employee.firstName || employee.first_name;
  const lastName = employee.lastName || employee.last_name;
  return [firstName, lastName]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join(' ');
};

module.exports = { employeeNameProjection, getEmployeeDisplayName };

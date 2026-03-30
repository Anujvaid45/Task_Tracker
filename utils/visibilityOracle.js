const { ROLE } = require("./roles");

function buildVisibilityOracle(user, query = {}) {
  const { role, id } = user || {};
  const { ltId, altId, managerId, tlId, applicationId } = query || {};

  const whereClauses = [];
  const binds = {};

  // Optional application-level filter

if (applicationId && String(applicationId).trim() !== "" && applicationId !== "all") {
  whereClauses.push(`
    EXISTS (
      SELECT 1
      FROM employee_applications ea
      WHERE ea.employee_id = e.id
        AND ea.application_id = :appId
    )
  `);

  binds.appId = Number(applicationId);
}


  // Role-based hierarchy visibility
  switch (role) {
    case ROLE.HEAD_LT:
      whereClauses.push(`
        e.id IN (
          SELECT id FROM employees
          START WITH reporting_manager = :__userRootId
          CONNECT BY PRIOR id = reporting_manager
          UNION SELECT :__userRootId FROM dual
        )
      `);
      binds.__userRootId = id;
      break;

case ROLE.LT:
  whereClauses.push(`
    e.id IN (
      SELECT id FROM employees
      START WITH reporting_manager = :USERROOTIDSTART
      CONNECT BY PRIOR id = reporting_manager
      UNION SELECT :USERROOTIDSELF FROM dual
    )
  `);

  binds.USERROOTIDSTART = id;
  binds.USERROOTIDSELF = id;
  break;


case ROLE.ALT: 
  whereClauses.push(`
    e.id IN (
      SELECT id
      FROM employees
      START WITH reporting_manager = :userRootId
      CONNECT BY PRIOR id = reporting_manager
      UNION
      SELECT :userRootId FROM dual
    )
  `);

  binds.userRootId = id;
  break;

    case ROLE.MANAGER:
      if (tlId) {
        whereClauses.push("(e.reporting_manager = :tlId OR e.id = :tlId)");
        binds.tlId = tlId;
      } else {
        whereClauses.push(`
  (e.manager_id = :managerId OR e.id = :managerId)
`);

        binds.managerId = id;
      }
      break;

    case ROLE.ADMIN:
      whereClauses.push("(e.reporting_manager = :tlId OR e.id = :tlId)");
      binds.tlId = tlId || id;
      break;

    case ROLE.EMPLOYEE:
      whereClauses.push("e.id = :empId");
      binds.empId = id;
      break;

    default:
      break;
  }

  // Additional frontend narrowing filters
const addSubtreeFilter = (paramValue, bindName) => {
  // Prevent empty or invalid values
  if (
    paramValue === undefined ||
    paramValue === null ||
    paramValue === "" ||
    isNaN(Number(paramValue))
  ) {
    return;
  }

  whereClauses.push(`
    e.id IN (
      SELECT id FROM employees
      START WITH id = :${bindName}
      CONNECT BY PRIOR id = reporting_manager
    )
  `);

  binds[bindName] = paramValue;
};

  addSubtreeFilter(ltId, "filterLtId");
  addSubtreeFilter(altId, "filterAltId");
  addSubtreeFilter(managerId, "filterManagerId");
  addSubtreeFilter(tlId, "filterTlId");

  // Final WHERE clause assembly
  const sqlCondition =
    whereClauses.length > 0 ? " AND " + whereClauses.join(" AND ") : "";

  return { sqlCondition, binds };
}

module.exports = { buildVisibilityOracle };

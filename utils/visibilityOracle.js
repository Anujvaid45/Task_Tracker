// buildVisibilityOracle.js
const { ROLE } = require("./roles");

/**
 * Builds a dynamic Oracle WHERE clause and bind parameters
 * for hierarchical visibility + optional application filter.
 */
function buildVisibilityOracle(user, query = {}) {
  const { role, id } = user || {};
  const { ltId, altId, managerId, tlId, applicationName } = query || {};

  const whereClauses = [];
  const binds = {};

  // ----------------------------------------------------------
  // Optional application-level filter
  // ----------------------------------------------------------
  if (applicationName && String(applicationName).trim() !== "") {
    whereClauses.push("UPPER(e.application_name) = UPPER(:appName)");
    binds.appName = String(applicationName).trim();
  }

  // ----------------------------------------------------------
  // Role-based hierarchy visibility
  // ----------------------------------------------------------
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
          SELECT id FROM employees
          START WITH reporting_manager = :__userRootId
          CONNECT BY PRIOR id = reporting_manager
          UNION SELECT :__userRootId FROM dual
        )
      `);
      binds.__userRootId = id;
      break;

    case ROLE.MANAGER:
      if (tlId) {
        whereClauses.push("(e.reporting_manager = :tlId OR e.id = :tlId)");
        binds.tlId = tlId;
      } else {
        whereClauses.push("e.manager_id = :managerId");
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

  // ----------------------------------------------------------
  // Additional frontend narrowing filters
  // ----------------------------------------------------------
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

  // ----------------------------------------------------------
  // Final WHERE clause assembly
  // ----------------------------------------------------------
  const sqlCondition =
    whereClauses.length > 0 ? " AND " + whereClauses.join(" AND ") : "";

  return { sqlCondition, binds };
}

module.exports = { buildVisibilityOracle };

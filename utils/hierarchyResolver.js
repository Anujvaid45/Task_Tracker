const oracledb = require("oracledb");

async function resolveHierarchyChain(connection, reportingManagerId) {
  if (!reportingManagerId) return {};

  const result = await connection.execute(
    `SELECT id, role, reporting_manager, head_lt_id, lt_id, alt_id 
     FROM employees WHERE id = :id`,
    { id: reportingManagerId },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );

  if (!result.rows.length) return {};

  const m = result.rows[0];
  const chain = {};

  switch (m.ROLE?.toLowerCase()) {
    case "head_lt":
      chain.head_lt_id = m.ID;
      break;

    case "lt":
      chain.lt_id = m.ID;
      chain.head_lt_id = m.HEAD_LT_ID || m.REPORTING_MANAGER || null;
      break;

    case "alt":
      chain.alt_id = m.ID;
      chain.lt_id = m.LT_ID || m.REPORTING_MANAGER || null;
      chain.head_lt_id = m.HEAD_LT_ID || null;
      break;

    case "manager":
      chain.manager_id = m.ID;
      chain.alt_id = m.ALT_ID || m.REPORTING_MANAGER || null;
      chain.lt_id = m.LT_ID || null;
      chain.head_lt_id = m.HEAD_LT_ID || null;
      break;

    case "tl":
      chain.tl_id = m.ID;
      chain.manager_id = m.REPORTING_MANAGER || null;
      chain.alt_id = m.ALT_ID || null;
      chain.lt_id = m.LT_ID || null;
      chain.head_lt_id = m.HEAD_LT_ID || null;
      break;

    default:
      break;
  }

  return chain;
}

module.exports = { resolveHierarchyChain };

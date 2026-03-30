const oracledb = require("oracledb");
const {buildVisibilityOracle} = require('../utils/visibilityOracle')
// Helper to execute queries
async function executeQuery(query, binds = {}, options = {}) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(query, binds, { autoCommit: true, ...options });
    return result;
  } finally {
    if (connection) await connection.close();
  }
}

// Create a new Module
exports.createModule = async (req, res) => {
  try {
    const managerId =
      req.user.role === "manager" ? req.user.id : req.user.managerId;

    if (!managerId) {
      return res.status(400).json({ error: "Manager ID not found" });
    }

    const { name, description, applicationId } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Module name is required" });
    }

    if (!applicationId) {
      return res.status(400).json({ error: "Application is required" });
    }

    /* ----------------------------------------------------
       1️⃣ Validate manager belongs to the application
    ---------------------------------------------------- */
    const validation = await executeQuery(
      `
      SELECT 1
      FROM employee_applications
      WHERE employee_id = :managerId
        AND application_id = :applicationId
      `,
      { managerId, applicationId }
    );

    if (!validation.rows || validation.rows.length === 0) {
      return res.status(403).json({
        error: "Manager is not mapped to the selected application",
      });
    }

    /* ----------------------------------------------------
       2️⃣ Insert module with application_id
    ---------------------------------------------------- */
    const result = await executeQuery(
      `
      INSERT INTO modules (
        id,
        name,
        description,
        manager_id,
        application_id
      )
      VALUES (
        modules_seq.NEXTVAL,
        :name,
        :description,
        :managerId,
        :applicationId
      )
      RETURNING
        id,
        name,
        description,
        manager_id,
        application_id
      INTO
        :outId,
        :outName,
        :outDesc,
        :outMgr,
        :outApp
      `,
      {
        name,
        description,
        managerId,
        applicationId,
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        outName: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        outDesc: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        outMgr: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        outApp: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    /* ----------------------------------------------------
       3️⃣ Response
    ---------------------------------------------------- */
    res.status(201).json({
      id: result.outBinds.outId,
      name: result.outBinds.outName,
      description: result.outBinds.outDesc,
      managerId: result.outBinds.outMgr,
      applicationId: result.outBinds.outApp,
    });
  } catch (err) {
    console.error("Failed to create module:", err);
    res.status(500).json({ error: err.message });
  }
};

// Get all Modules for manager/admin
exports.getModules = async (req, res) => {
  try {
    const user = req.user;

    // 🔹 Build employee visibility condition
    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

    // 🎯 Optional application filter
    const { applicationId } = req.query;
    let appFilter = "";

    if (applicationId) {
      appFilter = "AND m.application_id = :applicationId";
      binds.applicationId = Number(applicationId);
    }
let visibilityWhere = "";
let finalBinds = {};

if (req.user.role === "admin" || req.user.role ==="employee") {
  // TL → show modules of his manager
  visibilityWhere = `
    m.manager_id = (
      SELECT manager_id
      FROM employees
      WHERE id = :currentUserId
    )
  `;

  finalBinds.currentUserId = req.user.id;

} else {
  // Normal hierarchy visibility
  visibilityWhere = `
    m.manager_id IN (
      SELECT e.id
      FROM employees e
      WHERE 1=1
      ${sqlCondition}
    )
  `;

  finalBinds = { ...binds }; // use only oracle visibility binds
}
    const query = `
  SELECT
    m.id,
    m.name,
    m.description,
    m.manager_id,
    m.application_id,
    a.name AS application_name,
    COUNT(p.id) AS project_count
  FROM modules m
  JOIN applications a
    ON a.id = m.application_id
  LEFT JOIN projects p
    ON p.module_id = m.id
  WHERE ${visibilityWhere}
  ${appFilter}
  GROUP BY
    m.id,
    m.name,
    m.description,
    m.manager_id,
    m.application_id,
    a.name
  ORDER BY m.name
`;

    const result = await executeQuery(query, finalBinds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    const modules = result.rows.map(row => ({
      id: row.ID,
      name: row.NAME,
      description: row.DESCRIPTION,
      managerId: row.MANAGER_ID,
      applicationId: row.APPLICATION_ID,
      applicationName: row.APPLICATION_NAME,
      projects: Number(row.PROJECT_COUNT),
    }));
    res.json(modules);
  } catch (err) {
    console.error("Failed to fetch modules:", err);
    res.status(500).json({ error: err.message });
  }
};

// Get single Module by ID
exports.getModuleById = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

    binds.moduleId = Number(id);

    const query = `
      SELECT m.id, m.name, m.description, m.manager_id, m.application_id
      FROM modules m
      WHERE m.id = :moduleId
      AND m.manager_id IN (
        SELECT e.id
        FROM employees e
        WHERE 1=1
        ${sqlCondition}
      )
    `;

    const result = await executeQuery(query, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    if (!result.rows.length) {
      return res.status(404).json({ error: "Module not found or access denied" });
    }

    const row = result.rows[0];

    res.json({
      id: row.ID,
      name: row.NAME,
      description: row.DESCRIPTION,
      managerId: row.MANAGER_ID,
      applicationId: row.APPLICATION_ID,
    });
  } catch (err) {
    console.error("Failed to fetch module:", err);
    res.status(500).json({ error: err.message });
  }
};

// -----------------------------
// Update Module
exports.updateModule = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const { name, description, applicationId } = req.body;

    // 🔹 Basic validation
    if (!name) {
      return res.status(400).json({ error: "Module name is required" });
    }

    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

    binds.moduleId = Number(id);

    /* ---------------------------------------------------------
       1️⃣ Check module visibility + get manager_id
    --------------------------------------------------------- */
    const existing = await executeQuery(
      `
      SELECT m.manager_id, m.application_id
      FROM modules m
      WHERE m.id = :moduleId
      AND m.manager_id IN (
        SELECT e.id
        FROM employees e
        WHERE 1=1
        ${sqlCondition}
      )
      `,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        error: "Module not found or access denied",
      });
    }

    const managerId = existing.rows[0].MANAGER_ID;
    const currentAppId = existing.rows[0].APPLICATION_ID;

    /* ---------------------------------------------------------
       2️⃣ Validate new application (if changing)
    --------------------------------------------------------- */
    let newApplicationId = currentAppId;

    if (
      applicationId &&
      applicationId !== "all" &&
      Number(applicationId) !== currentAppId
    ) {
      const validation = await executeQuery(
        `
        SELECT 1
        FROM employee_applications
        WHERE employee_id = :managerId
          AND application_id = :applicationId
        `,
        {
          managerId,
          applicationId: Number(applicationId),
        }
      );

      if (!validation.rows.length) {
        return res.status(403).json({
          error: "Manager is not mapped to the selected application",
        });
      }

      newApplicationId = Number(applicationId);
    }

    /* ---------------------------------------------------------
       3️⃣ Build dynamic SET clause safely
    --------------------------------------------------------- */
    const updateBinds = {
      moduleId: Number(id),
      name,
      description,
      outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      outName: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
      outDesc: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
      outMgr: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      outApp: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    };

    let setClause = `
      m.name = :name,
      m.description = :description
    `;

    if (newApplicationId !== currentAppId) {
      setClause += `, m.application_id = :applicationId`;
      updateBinds.applicationId = newApplicationId;
    }

    const updateQuery = `
      UPDATE modules m
      SET ${setClause}
      WHERE m.id = :moduleId
      RETURNING
        m.id,
        m.name,
        m.description,
        m.manager_id,
        m.application_id
      INTO
        :outId,
        :outName,
        :outDesc,
        :outMgr,
        :outApp
    `;

    const result = await executeQuery(updateQuery, updateBinds);

    res.json({
      id: result.outBinds.outId,
      name: result.outBinds.outName,
      description: result.outBinds.outDesc,
      managerId: result.outBinds.outMgr,
      applicationId: result.outBinds.outApp,
    });

  } catch (err) {
    console.error("Failed to update module:", err);
    res.status(500).json({ error: err.message });
  }
};

// -----------------------------
// Delete Module
exports.deleteModule = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

    binds.moduleId = Number(id);

    const query = `
      DELETE FROM modules m
      WHERE m.id = :moduleId
      AND m.manager_id IN (
        SELECT e.id
        FROM employees e
        WHERE 1=1
        ${sqlCondition}
      )
      RETURNING m.id INTO :outId
    `;

    binds.outId = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };

    const result = await executeQuery(query, binds);

    if (!result.outBinds || !result.outBinds.outId) {
      return res.status(404).json({ error: "Module not found or access denied" });
    }

    // Delete related projects safely
    await executeQuery(
      `DELETE FROM projects WHERE module_id = :moduleId`,
      { moduleId: Number(id) }
    );

    res.json({ message: "Module deleted successfully" });
  } catch (err) {
    console.error("Failed to delete module:", err);
    res.status(500).json({ error: err.message });
  }
};

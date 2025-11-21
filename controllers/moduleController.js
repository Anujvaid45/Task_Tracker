// const Module = require("../models/Module");
// const Project = require("../models/Project");

// // Create a new Module
// exports.createModule = async (req, res) => {
//   try {
//     const managerId =
//       req.user.role === "manager" ? req.user.id : req.user.managerId;

//     if (!managerId) {
//       return res.status(400).json({ error: "Manager ID not found" });
//     }

//     const module = new Module({
//       ...req.body,
//       managerId, // link module to the manager
//     });

//     await module.save();
//     res.status(201).json(module);
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

// // Get all Modules (isolated by manager/admin)
// exports.getModules = async (req, res) => {
//   try {
//     const managerId =
//       req.user.role === "manager" ? req.user.id : req.user.managerId;

//     if (!managerId) {
//       return res.status(400).json({ error: "Manager ID not found" });
//     }

//     const modules = await Module.find({ managerId }).populate("projects");
//     res.json(modules);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

// // Get single Module by ID (check manager/admin access)
// exports.getModuleById = async (req, res) => {
//   try {
//     const managerId =
//       req.user.role === "manager" ? req.user.id : req.user.managerId;

//     const module = await Module.findOne({
//       _id: req.params.id,
//       managerId,
//     }).populate("projects");

//     if (!module)
//       return res.status(404).json({ error: "Module not found or access denied" });

//     res.json(module);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

// // Update Module (only manager/admin of that module)
// exports.updateModule = async (req, res) => {
//   try {
//     const managerId =
//       req.user.role === "manager" ? req.user.id : req.user.managerId;

//     const module = await Module.findOneAndUpdate(
//       { _id: req.params.id, managerId },
//       req.body,
//       { new: true }
//     );

//     if (!module)
//       return res.status(404).json({ error: "Module not found or access denied" });

//     res.json(module);
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

// // Delete Module (only manager/admin of that module)
// exports.deleteModule = async (req, res) => {
//   try {
//     const managerId =
//       req.user.role === "manager" ? req.user.id : req.user.managerId;

//     const module = await Module.findOneAndDelete({
//       _id: req.params.id,
//       managerId,
//     });

//     if (!module)
//       return res.status(404).json({ error: "Module not found or access denied" });

//     // Delete related projects
//     await Project.deleteMany({ moduleId: module._id });

//     res.json({ message: "Module deleted successfully" });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };


//this is oracle db routes


const oracledb = require("oracledb");

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

// -----------------------------
// Create a new Module
exports.createModule = async (req, res) => {
  try {
    const managerId = req.user.role === "manager" ? req.user.id : req.user.managerId;
    if (!managerId) return res.status(400).json({ error: "Manager ID not found" });

    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Module name is required" });

    const result = await executeQuery(
      `INSERT INTO modules (id, name, description, manager_id) 
       VALUES (modules_seq.NEXTVAL, :name, :description, :managerId) 
       RETURNING id, name, description, manager_id INTO :outId, :outName, :outDesc, :outMgr`,
      {
        name,
        description,
        managerId,
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        outName: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        outDesc: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        outMgr: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    res.status(201).json({
      id: result.outBinds.outId,
      name: result.outBinds.outName,
      description: result.outBinds.outDesc,
      managerId: result.outBinds.outMgr,
    });
  } catch (err) {
    console.error("Failed to create module:", err);
    res.status(500).json({ error: err.message });
  }
};

// -----------------------------
// Get all Modules for manager/admin
exports.getModules = async (req, res) => {
  try {
    const managerId = req.user.role === "manager" ? req.user.id : req.user.managerId;
    if (!managerId) return res.status(400).json({ error: "Manager ID not found" });

    // Fetch modules with project count
    const modulesResult = await executeQuery(
      `SELECT 
          m.id,
          m.name,
          m.description,
          m.manager_id,
          COUNT(p.id) AS project_count
       FROM modules m
       LEFT JOIN projects p ON p.module_id = m.id
       WHERE m.manager_id = :managerId
       GROUP BY m.id, m.name, m.description, m.manager_id
       ORDER BY m.name`,
      { managerId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT } // <-- this is important

    );
    // Map result to frontend-friendly structure
    const modules = modulesResult.rows.map(row => ({
      id: row.ID,
      name: row.NAME,
      description: row.DESCRIPTION,
      managerId: row.MANAGER_ID,
      projects: Number(row.PROJECT_COUNT) // for frontend mapping (length = project count)
    }));
    
    res.json(modules);
  } catch (err) {
    console.error("Failed to fetch modules:", err);
    res.status(500).json({ error: err.message });
  }
};


// -----------------------------
// Get single Module by ID
exports.getModuleById = async (req, res) => {
  try {
    const managerId = req.user.role === "manager" ? req.user.id : req.user.managerId;
    const { id } = req.params;

    const result = await executeQuery(
      `SELECT id, name, description, manager_id FROM modules WHERE id = :id AND manager_id = :managerId`,
      { id: Number(id), managerId }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Module not found or access denied" });
    }

    const row = result.rows[0];
    res.json({ id: row[0], name: row[1], description: row[2], managerId: row[3] });
  } catch (err) {
    console.error("Failed to fetch module:", err);
    res.status(500).json({ error: err.message });
  }
};

// -----------------------------
// Update Module
exports.updateModule = async (req, res) => {
  try {
    const managerId = req.user.role === "manager" ? req.user.id : req.user.managerId;
    const { id } = req.params;
    const { name, description } = req.body;

    const result = await executeQuery(
      `UPDATE modules SET name = :name, description = :description 
       WHERE id = :id AND manager_id = :managerId 
       RETURNING id, name, description, manager_id INTO :outId, :outName, :outDesc, :outMgr`,
      {
        id: Number(id),
        managerId,
        name,
        description,
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        outName: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        outDesc: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
        outMgr: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    if (!result.outBinds || !result.outBinds.outId) {
      return res.status(404).json({ error: "Module not found or access denied" });
    }

    res.json({
      id: result.outBinds.outId,
      name: result.outBinds.outName,
      description: result.outBinds.outDesc,
      managerId: result.outBinds.outMgr,
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
    const managerId = req.user.role === "manager" ? req.user.id : req.user.managerId;
    const { id } = req.params;

    const result = await executeQuery(
      `DELETE FROM modules WHERE id = :id AND manager_id = :managerId RETURNING id INTO :outId`,
      {
        id: Number(id),
        managerId,
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    if (!result.outBinds || !result.outBinds.outId) {
      return res.status(404).json({ error: "Module not found or access denied" });
    }

    // Delete related projects
    await executeQuery(`DELETE FROM projects WHERE module_id = :moduleId`, { moduleId: Number(id) });

    res.json({ message: "Module deleted successfully" });
  } catch (err) {
    console.error("Failed to delete module:", err);
    res.status(500).json({ error: err.message });
  }
};

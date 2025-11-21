// const express = require("express");
// const EffortMapping = require("../models/effortMapping");
// const router = express.Router();

// // Get all mappings
// router.get("/", async (req, res) => {
//   const mappings = await EffortMapping.find();  
//   res.json(mappings);
// });

// // Update one mapping
// router.put("/:type", async (req, res) => {
//   const { type } = req.params;
//   const { values } = req.body; // { Simple: 1, Medium: 2, ... }

//   const updated = await EffortMapping.findOneAndUpdate(
//     { type },
//     { $set: { values } },
//     { new: true }
//   );
//   res.json(updated);
// });

// // POST /effort-mapping
// router.post("/", async (req, res) => {
//   const { type, values } = req.body; 
//   // type = "No_of_new_feature"
//   // values = { Simple: 1, Medium: 2, Complex: 3, Very_Complex: 4 }

//   // Check if type already exists
//   const exists = await EffortMapping.findOne({ type });
//   if (exists) return res.status(400).json({ error: "Type already exists" });

//   const newMapping = new EffortMapping({ type, values });
//   await newMapping.save();

//   res.status(201).json(newMapping);
// });

// // DELETE /effort-mapping/:type
// router.delete("/:type", async (req, res) => {
//   const { type } = req.params;
//   const deleted = await EffortMapping.findOneAndDelete({ type });
//   if (!deleted) return res.status(404).json({ error: "Type not found" });
//   res.json({ message: `${type} deleted` });
// });

// module.exports = router;


//this is oracle db code

const express = require("express");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];
const authMiddleware = require("../middleware/auth.js");

const router = express.Router();

async function executeQuery(query, binds = {}, options = {}) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(query, binds, {
      autoCommit: true,
      ...options,
    });
    return result;
  } finally {
    if (connection) await connection.close();
  }
}

// 🔹 Get all mappings
router.get("/", authMiddleware(["admin", "manager","employee"]), async (req, res) => {
  try {
    const result = await executeQuery(
      "SELECT TYPE, VALUES_JSON FROM EFFORT_MAPPING",
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const mappings = result.rows.map((row) => ({
      type: row.TYPE,
      values: JSON.parse(row.VALUES_JSON),
    }));

    res.json(mappings);
  } catch (err) {
    console.error("Fetch effort mapping error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Update one mapping
router.put("/:type", authMiddleware(["manager"]), async (req, res) => {
  try {
    const { type } = req.params; // old type name
    const { newType, values } = req.body; // newType is the updated name

    if (!newType || !values) {
      return res.status(400).json({ error: "newType and values are required" });
    }

    const valuesJson = JSON.stringify(values);

    const result = await executeQuery(
      `UPDATE EFFORT_MAPPING
       SET TYPE = :newType, VALUES_JSON = :valuesJson
       WHERE TYPE = :type`,
      { type, newType, valuesJson }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "Type not found" });
    }

    res.json({ message: `Type "${type}" updated successfully to "${newType}"` });
  } catch (err) {
    console.error("Update mapping error:", err);
    res.status(500).json({ error: err.message });
  }
});


// 🔹 Create a new mapping
router.post("/", authMiddleware(["manager"]), async (req, res) => {
  try {
    const { type, values } = req.body;
    const valuesJson = JSON.stringify(values);

    // Check if type already exists
    const exists = await executeQuery(
      "SELECT 1 FROM EFFORT_MAPPING WHERE TYPE = :type",
      { type }
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "Type already exists" });
    }

    await executeQuery(
      `INSERT INTO EFFORT_MAPPING (TYPE, VALUES_JSON)
       VALUES (:type, :valuesJson)`,
      { type, valuesJson }
    );

    res.status(201).json({ message: "Effort mapping created successfully" });
  } catch (err) {
    console.error("Create mapping error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Delete mapping by type
router.delete("/:type", authMiddleware(["manager"]), async (req, res) => {
  try {
    const { type } = req.params;

    const result = await executeQuery(
      "DELETE FROM EFFORT_MAPPING WHERE TYPE = :type",
      { type }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "Type not found" });
    }

    res.json({ message: `${type} deleted successfully` });
  } catch (err) {
    console.error("Delete mapping error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

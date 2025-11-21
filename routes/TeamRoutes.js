const express = require("express");
const router = express.Router();
const oracledb = require("oracledb");
const authMiddleware = require("../middleware/auth"); // make sure you have auth middleware

// -----------------------------
// Helper: Execute Oracle queries
async function executeQuery(query, binds = [], options = {}) {
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
// GET all teams
router.get("/", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
  try {
    const result = await executeQuery(`SELECT id, name FROM teams ORDER BY name`);
    const teams = result.rows.map(row => ({ id: row[0], name: row[1] }));
    res.json(teams);
  } catch (err) {
    console.error("Failed to fetch teams:", err);
    res.status(500).json({ error: "Failed to fetch teams" });
  }
});

// -----------------------------
// POST add new team
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Team name is required" });

    // Check duplicates
    const existing = await executeQuery(`SELECT id FROM teams WHERE name = :name`, [name]);
    if (existing.rows.length > 0) return res.status(400).json({ error: "Team already exists" });

    // Insert new team
    const result = await executeQuery(
      `INSERT INTO teams (id, name) VALUES (teams_seq.NEXTVAL, :name) RETURNING id, name INTO :id, :outName`,
      {
        name,
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        outName: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
      }
    );

    res.json({ id: result.outBinds.id, name: result.outBinds.outName });
  } catch (err) {
    console.error("Failed to add team:", err);
    res.status(500).json({ error: "Failed to add team" });
  }
});

// -----------------------------
// PUT update a team name by id
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "New team name is required" });

    // Check duplicate name
    const duplicate = await executeQuery(`SELECT id FROM teams WHERE name = :name AND id != :id`, [name, id]);
    if (duplicate.rows.length > 0) return res.status(400).json({ error: "Team name already exists" });

    const result = await executeQuery(
      `UPDATE teams SET name = :name WHERE id = :id RETURNING id, name INTO :outId, :outName`,
      {
        name,
        id: Number(id),
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        outName: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
      }
    );

    if (!result.outBinds || !result.outBinds.outId) return res.status(404).json({ error: "Team not found" });

    res.json({ id: result.outBinds.outId, name: result.outBinds.outName });
  } catch (err) {
    console.error("Failed to update team:", err);
    res.status(500).json({ error: "Failed to update team" });
  }
});

// -----------------------------
// DELETE a team by id
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await executeQuery(
      `DELETE FROM teams WHERE id = :id RETURNING id INTO :outId`,
      {
        id: Number(id),
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    if (!result.outBinds || !result.outBinds.outId) return res.status(404).json({ error: "Team not found" });

    res.json({ message: "Team deleted successfully" });
  } catch (err) {
    console.error("Failed to delete team:", err);
    res.status(500).json({ error: "Failed to delete team" });
  }
});

module.exports = router;

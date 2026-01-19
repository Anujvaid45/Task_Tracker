require('dotenv').config();
const express = require('express');
const cors = require('cors');
const oracledb = require('oracledb');
const path = require("path");

oracledb.fetchAsString = [ oracledb.DATE ];

// Import routes
const employeeRoutes = require('./routes/employeeRoutes.js');
const taskRoutes = require('./routes/taskRoutes.js');
const dashboardRoutes = require('./routes/dashboardRoutes.js');
const authRoutes = require('./routes/authRoutes.js');
const attendanceRoutes = require('./routes/attendanceRoutes.js');
const moduleRoutes = require('./routes/moduleRoutes.js');
const projectRoutes = require('./routes/projectRoutes.js');
const componentsRoutes = require('./routes/componentsRoutes.js');
const teamRoutes = require('./routes/TeamRoutes.js');
const docRoutes = require('./routes/docLib.js')

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/employees", employeeRoutes);
app.use("/api/modules", moduleRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/components", componentsRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/documents", docRoutes);

// ✅ OracleDB Initialization
async function initOracle() {
  try {
    await oracledb.createPool({
      user: process.env.DB_USER,           // e.g. hr
      password: process.env.DB_PASS,       // e.g. hr
      connectString: process.env.DB_CONNECT, // e.g. localhost/XEPDB1
        poolMin: 2,
  poolMax: 200,   // Increase
  poolIncrement: 2,
  queueTimeout: 100000
    });
    console.log("✅ OracleDB connected");
  } catch (err) {
    console.error("❌ OracleDB connection failed:", err);
    process.exit(1);
  }
}
initOracle();
setInterval(() => {
  try {
    const p = oracledb.getPool();
    console.log("[POOL]",
      "open:", p.connectionsOpen,
      "inUse:", p.connectionsInUse,
      "queue:", p.queueSize
    );
  } catch {}
}, 3000);

// Test route
app.use(express.static(path.join(__dirname, "dist")));

// ✅ For any non-API route, send back index.html (so React Router works)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT,"0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));

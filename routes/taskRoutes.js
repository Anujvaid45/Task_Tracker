const express = require("express");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];

const authMiddleware = require('../middleware/auth.js');
const { buildVisibilityOracle } = require("../utils/visibilityOracle");
const { safeRoute } = require("../utils/dbWrapper");

const router = express.Router();
// Helpers
function formatDateForDisplay(date) 
{
 if (!date) return null; 
const d = new Date(date); 
const day = String(d.getDate()).padStart(2, "0"); 
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; 
const month = monthNames[d.getMonth()]; const year = d.getFullYear(); 
return `${day}-${month}-${year}`; 
}

function formatTaskDates(task) {
  return {
    ...task,
    dueDateRaw: task.dueDate,
    createdAtRaw: task.createdAt,
    updatedAtRaw: task.updatedAt,
    completedAtRaw: task.completedAt,
    dueDate: formatDateForDisplay(task.dueDate),
    createdAt: formatDateForDisplay(task.createdAt),
    updatedAt: formatDateForDisplay(task.updatedAt),
    completedAt: formatDateForDisplay(task.completedAt),
  };
}

function getMonthDateRange(month, year) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

function formatHoursToHHMM(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

// Calculate workload
async function calculateWorkload(components = [], connection) {
  // 1️⃣ Fetch all mappings
  const result = await connection.execute(
    `SELECT type, values_json FROM effort_mapping`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );

  // 2️⃣ Parse the JSON into a usable object
  const effortMapping = {};
  for (const row of result.rows) {
    // row.VALUES_JSON is now a string if you used oracledb.fetchAsString = [oracledb.CLOB]
    const values = JSON.parse(row.VALUES_JSON);
    effortMapping[row.TYPE] = values; // { Simple: 0.5, Medium: 1, ... }
  }

  // 3️⃣ Calculate workload
  let workloadHours = 0;
  const processedComponents = components.map((comp) => {
    // Map complexity to hours
    const hoursPerItem = effortMapping[comp.type]?.[comp.complexity] || 0;
    const totalCompHours = (comp.count || 1) * hoursPerItem;
    workloadHours += totalCompHours;

    return {
      ...comp,
      hoursPerItem,
      totalCompHours,
      fileRequired: comp.fileRequired || false,
      fileType: comp.fileRequired ? comp.fileType : null,
    };
  });

  return { workloadHours, processedComponents };
}

//create a new task 
router.post(
  "/",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {

      conn.autoCommit = false;

      const {
        applicationName,
        moduleId,
        projectId,
        employeeId,
        title,
        description,
        dueDate,
        components = [],
        priority,
        status = "Pending",
        notes,
        attachments,
      } = req.body;

      // ------------------------------------------------------------
      // 1️⃣ VISIBILITY CHECK
      // ------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.body);
      binds.employeeId = employeeId;

      const visibilityQuery = `
        SELECT e.id 
        FROM employees e
        WHERE e.id = :employeeId
        ${sqlCondition}
      `;

      const vis = await conn.execute(visibilityQuery, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (!vis.rows.length) {
        await conn.rollback();
        return res.status(403).json({
          error: "You are not authorized to assign this employee.",
        });
      }

      // ------------------------------------------------------------
      // 2️⃣ MANAGER + WORKLOAD
      // ------------------------------------------------------------
      const managerId =
        req.user.role === "admin" ? req.user.managerId : req.user.id;

      let workloadHours = 0;
      let processedComponents = [];

      if (components.length > 0) {
        const r = await calculateWorkload(components, conn);
        workloadHours = r.workloadHours;
        processedComponents = r.processedComponents;
      }

      const completedStatuses = ["Live", "Preprod_Signoff", "Completed"];
      const completedAt = completedStatuses.includes(status)
        ? new Date()
        : null;

        let finalApplicationName = applicationName;
        if (Number(applicationName) && applicationName !== "all") {
          const appRes = await conn.execute(
            `SELECT name FROM applications WHERE id = :id`,
            { id: Number(applicationName) },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
        
          if (appRes.rows.length > 0) {
            finalApplicationName = appRes.rows[0].NAME;
          }
        }
      // ------------------------------------------------------------
      // 3️⃣ INSERT TASK USING SEQ_TASK
      // ------------------------------------------------------------
      const insertTaskSql = `
        INSERT INTO TASKS
          (TASK_ID, APPLICATION_NAME, MODULE_ID, PROJECT_ID, E_ID, MANAGER_ID, TITLE, DESCRIPTION,
           DUE_DATE, PRIORITY, STATUS, WORKLOAD_HOURS, COMPLETED_AT,
           CREATED_AT, UPDATED_AT)
        VALUES
          (SEQ_TASK.NEXTVAL, :finalApplicationName, :moduleId, :projectId, :employeeId, :managerId,
           :title, :description, TO_DATE(:dueDate,'YYYY-MM-DD'),
           :priority, :status, :workloadHours, :completedAt,
           SYSTIMESTAMP, SYSTIMESTAMP)
        RETURNING TASK_ID INTO :taskId
      `;

      const taskInsertResult = await conn.execute(
        insertTaskSql,
        {
          finalApplicationName: finalApplicationName,
          moduleId: Number(moduleId),
          projectId: Number(projectId),
          employeeId: Number(employeeId),
          managerId: Number(managerId),
          title,
          description,
          dueDate,
          priority: priority || "Medium",
          status,
          workloadHours,
          completedAt,
          taskId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        }
      );

      const taskId = taskInsertResult.outBinds.taskId[0];

      // ------------------------------------------------------------
      // 4️⃣ INSERT COMPONENTS USING SEQ_TASK_COMPONENT
      // ------------------------------------------------------------
      for (const c of processedComponents) {
        await conn.execute(
          `
          INSERT INTO TASK_COMPONENTS
            (TASK_COMPONENT_ID, TASK_ID, TYPE, COMPLEXITY, COUNT,
             HOURS_PER_ITEM, TOTAL_COMP_HOURS, FILE_REQUIRED, FILE_TYPE)
          VALUES
            (SEQ_TASK_COMPONENT.NEXTVAL, :taskId, :type, :complexity,
             :count, :hoursPerItem, :totalCompHours, :fileRequired, :fileType)
        `,
          {
            taskId,
            type: c.type,
            complexity: c.complexity,
            count: c.count,
            hoursPerItem: c.hoursPerItem,
            totalCompHours: c.totalCompHours,
            fileRequired: c.fileRequired || null,
            fileType: c.fileType || null,
          }
        );
      }

      // ------------------------------------------------------------
      // 5️⃣ INSERT NOTES USING SEQ_TASK_NOTE
      // ------------------------------------------------------------
      if (notes && notes.length > 0) {
        for (const n of notes) {
          await conn.execute(
            `
            INSERT INTO TASK_NOTES
              (TASK_NOTE_ID, TASK_ID, CONTENT, CREATED_BY, CREATED_AT)
            VALUES
              (SEQ_TASK_NOTE.NEXTVAL, :taskId, :content, :createdBy, SYSTIMESTAMP)
          `,
            {
              taskId,
              content: n.content,
              createdBy: req.user.id,
            }
          );
        }
      }

      // ------------------------------------------------------------
      // 6️⃣ INSERT ATTACHMENTS USING SEQ_TASK_ATTACHMENT
      // ------------------------------------------------------------
      if (attachments && attachments.length > 0) {
        for (const file of attachments) {
          await conn.execute(
            `
            INSERT INTO TASK_ATTACHMENTS
              (TASK_ATTACHMENT_ID, TASK_ID, FILENAME, ORIGINAL_NAME, PATH, UPLOADED_AT)
            VALUES
              (SEQ_TASK_ATTACHMENT.NEXTVAL, :taskId, :filename, :originalName, :path, SYSTIMESTAMP)
          `,
            {
              taskId,
              filename: file.filename,
              originalName: file.originalName,
              path: file.path,
            }
          );
        }
      }

      // ------------------------------------------------------------
      // 7️⃣ COMMIT
      // ------------------------------------------------------------
      await conn.commit();

      // ------------------------------------------------------------
      // 8️⃣ RETURN TASK
      // ------------------------------------------------------------
      const fetchTaskSql = `
        SELECT 
          t.*,
          e.NAME AS EMPLOYEE_NAME,
          e.DESIGNATION AS EMPLOYEE_DESIGNATION,
          e.EMAIL AS EMPLOYEE_EMAIL,
          m.NAME AS MODULE_NAME,
          p.NAME AS PROJECT_NAME
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        LEFT JOIN MODULES m ON t.MODULE_ID = m.ID
        LEFT JOIN PROJECTS p ON t.PROJECT_ID = p.ID
        WHERE t.TASK_ID = :taskId
      `;

      const taskResult = await conn.execute(
        fetchTaskSql,
        { taskId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return res.json(formatTaskDates(taskResult.rows[0]));
    });
  }
);

// POST /api/tasks/components/:id/log --> create a new worklog for a task for an employee
router.post(
  "/components/:id/log",
  authMiddleware(["employee", "manager", "admin","alt", "lt", "head_lt"]),async (req, res) => {
    return safeRoute(req, res, async (connection) => {
   
      const componentId = Number(req.params.id);
      const user = req.user;
      const { hoursLogged, logDate, notes } = req.body; // Example: { hoursLogged: 4, logDate: '2025-11-08' }

      // Basic input validation
      if (!hoursLogged || hoursLogged <= 0 || !logDate) {
        return res.status(400).json({ error: "Hours logged and log date are required." });
      }


      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Fetch component and related employee details
      // -------------------------------------------------------------------------
      const compQuery = `
        SELECT 
          c.TASK_COMPONENT_ID, 
          c.TOTAL_COMP_HOURS, 
          c.STATUS, 
          c.TASK_ID, 
          t.E_ID AS EMPLOYEE_ID,
          e.MANAGER_ID,
          e.REPORTING_MANAGER
        FROM TASK_COMPONENTS c
        JOIN TASKS t ON c.TASK_ID = t.TASK_ID
        JOIN EMPLOYEES e ON t.E_ID = e.ID
        WHERE c.TASK_COMPONENT_ID = :componentId
      `;
      const compResult = await connection.execute(compQuery, { componentId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });

      if (compResult.rows.length === 0)
        return res.status(404).json({ error: "Component not found." });

      const component = compResult.rows[0];

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Role-based permission validation
      // -------------------------------------------------------------------------
      let allowed = false;

      if (user.role === "employee") {
        allowed = Number(component.EMPLOYEE_ID) === Number(user.id);
      } else if (user.role === "manager") {
        allowed =
          Number(component.MANAGER_ID) === Number(user.id) ||
          Number(component.EMPLOYEE_ID) === Number(user.id);
      } else if (user.role === "admin") {
        allowed =
          Number(component.REPORTING_MANAGER) === Number(user.id) ||
          Number(component.EMPLOYEE_ID) === Number(user.id);
      } else if (["alt","lt", "head_lt"].includes(user.role.toLowerCase())) {
        const { sqlCondition, binds } = buildVisibilityOracle(user, {});
        const checkQuery = `
          SELECT 1 
          FROM EMPLOYEES e 
          WHERE e.ID = :empId ${sqlCondition ? sqlCondition.replace(/^ AND /, " AND ") : ""}
        `;
        const checkRes = await connection.execute(checkQuery, { ...binds, empId: component.EMPLOYEE_ID });
        allowed = checkRes.rows.length > 0;
      }

      if (!allowed) {
        return res.status(403).json({ error: "Access denied. You are not authorized to log hours for this component." });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Validate no over-logging
      // -------------------------------------------------------------------------
      const loggedResult = await connection.execute(
        `SELECT NVL(SUM(HOURS_LOGGED), 0) AS TOTAL_LOGGED 
         FROM COMPONENT_WORKLOGS 
         WHERE TASK_COMPONENT_ID = :componentId`,
        { componentId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const totalLogged = loggedResult.rows[0].TOTAL_LOGGED || 0;
      const remaining = Number(component.TOTAL_COMP_HOURS) - totalLogged;

      if (hoursLogged > remaining) {
        return res.status(400).json({ error: `Cannot log more than remaining ${remaining} hours.` });
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Insert new worklog
      // -------------------------------------------------------------------------
      await connection.execute(
        `INSERT INTO COMPONENT_WORKLOGS 
          (TASK_COMPONENT_ID, EMPLOYEE_ID, HOURS_LOGGED, LOG_DATE, NOTES)
         VALUES 
          (:componentId, :userId, :hoursLogged, TO_DATE(:logDate, 'YYYY-MM-DD'), :notes)`,
        { componentId, userId: user.id, hoursLogged, logDate, notes },
        { autoCommit: false }
      );

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Auto-complete component if fully logged
      // -------------------------------------------------------------------------
      const newTotal = totalLogged + Number(hoursLogged);
      if (newTotal >= Number(component.TOTAL_COMP_HOURS)) {
        await connection.execute(
          `UPDATE TASK_COMPONENTS
           SET STATUS = 'Live', COMPLETED_AT = SYSTIMESTAMP
           WHERE TASK_COMPONENT_ID = :componentId`,
          { componentId },
          { autoCommit: false }
        );

        // Check if all components of the task are complete
        const allCompStatus = await connection.execute(
          `SELECT COUNT(*) AS TOTAL, 
                  SUM(CASE WHEN STATUS = 'Live' THEN 1 ELSE 0 END) AS COMPLETED
           FROM TASK_COMPONENTS
           WHERE TASK_ID = :taskId`,
          { taskId: component.TASK_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const total = allCompStatus.rows[0].TOTAL;
        const completed = allCompStatus.rows[0].COMPLETED;

        if (total > 0 && total === completed) {
          await connection.execute(
            `UPDATE TASKS 
             SET STATUS = 'Completed', COMPLETED_AT = SYSTIMESTAMP 
             WHERE TASK_ID = :taskId`,
            { taskId: component.TASK_ID },
            { autoCommit: false }
          );
        }
      }

      await connection.commit();
      res.status(201).json({ message: "Work logged successfully." });

    });
});

// GET --> fetch all logs of the employee for a task component
router.get(
  "/components/:id/logs",
  authMiddleware(["employee", "admin", "manager","lt","alt","head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const componentId = req.params.id;

      const result = await connection.execute(
        `SELECT wl.WORKLOG_ID,
                wl.HOURS_LOGGED,
                TO_CHAR(wl.LOG_DATE, 'YYYY-MM-DD') AS LOG_DATE,
                wl.NOTES,
                e.NAME AS EMPLOYEE_NAME
         FROM COMPONENT_WORKLOGS wl
         JOIN EMPLOYEES e ON wl.EMPLOYEE_ID = e.ID
         WHERE wl.TASK_COMPONENT_ID = :componentId
         ORDER BY wl.LOG_DATE DESC`,
        { componentId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const formattedLogs = formatLogsDates(result.rows);
      res.json(formattedLogs);

   
  });
});

// 🗓️ Helper to format date like "21-Oct-2025"
function formatDateForDisplay(date) {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// 🧾 Format an array of work logs
function formatLogsDates(logs) {
  return logs.map(log => ({
    ...log,
    LOG_DATE: formatDateForDisplay(log.LOG_DATE)
  }));
}

//update a log for an employee for a task component
router.put(
  "/components/log/:logId",
  authMiddleware(["employee", "admin", "manager", "lt", "alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const logId = Number(req.params.logId);
      const { hoursLogged, logDate, notes } = req.body;
      const userId = req.user.id;

      if (hoursLogged === undefined || !logDate) {
        return res.status(400).json({ error: "Hours and log date required" });
      }

      // ------------------------------------------------------------------
      // 1️⃣ Fetch log + component + task
      // ------------------------------------------------------------------
      const logRes = await connection.execute(
        `
        SELECT
          wl.WORKLOG_ID,
          wl.TASK_COMPONENT_ID,
          wl.HOURS_LOGGED AS OLD_HOURS,
          c.TOTAL_COMP_HOURS,
          c.STATUS AS COMPONENT_STATUS,
          t.TASK_ID,
          t.STATUS AS TASK_STATUS,
          t.E_ID
        FROM COMPONENT_WORKLOGS wl
        JOIN TASK_COMPONENTS c ON wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
        JOIN TASKS t ON c.TASK_ID = t.TASK_ID
        WHERE wl.WORKLOG_ID = :logId
        `,
        { logId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!logRes.rows.length)
        return res.status(404).json({ error: "Log not found" });

      const log = logRes.rows[0];

      if (Number(log.E_ID) !== Number(userId))
        return res.status(403).json({ error: "Unauthorized" });

      // ------------------------------------------------------------------
      // 2️⃣ Lock completed components
      // ------------------------------------------------------------------
      if (log.COMPONENT_STATUS === "Completed") {
        return res.status(400).json({
          error:
            "This component is already completed. Logs cannot be edited.",
        });
      }

      // ------------------------------------------------------------------
      // 3️⃣ Calculate remaining hours safely
      // ------------------------------------------------------------------
      const sumRes = await connection.execute(
        `
        SELECT NVL(SUM(HOURS_LOGGED),0) AS TOTAL
        FROM COMPONENT_WORKLOGS
        WHERE TASK_COMPONENT_ID = :cid
          AND WORKLOG_ID != :logId
        `,
        {
          cid: log.TASK_COMPONENT_ID,
          logId,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const alreadyLogged = sumRes.rows[0].TOTAL || 0;
      const remaining = log.TOTAL_COMP_HOURS - alreadyLogged;

      // ❌ Cannot exceed remaining
      if (hoursLogged > remaining) {
        return res.status(400).json({
          error: `Only ${remaining} hours remaining. Mark component as Completed to finish.`,
        });
      }

      // ❌ Cannot exactly finish via edit
      if (hoursLogged === remaining) {
        return res.status(400).json({
          error:
            "You cannot complete a component via log edit. Use the status dropdown to mark it Completed.",
        });
      }

      // ------------------------------------------------------------------
      // 4️⃣ Update log
      // ------------------------------------------------------------------
      await connection.execute(
        `
        UPDATE COMPONENT_WORKLOGS
        SET
          HOURS_LOGGED = :hours,
          LOG_DATE = TO_DATE(:logDate,'YYYY-MM-DD'),
          NOTES = :notes
        WHERE WORKLOG_ID = :logId
        `,
        {
          hours: hoursLogged,
          logDate,
          notes,
          logId,
        }
      );

      // ------------------------------------------------------------------
      // 5️⃣ Recalculate component & task status
      // ------------------------------------------------------------------

      // Component status
      let newCompStatus = "Pending";
      if (alreadyLogged + hoursLogged > 0) newCompStatus = "Under_Development";

      await connection.execute(
        `
        UPDATE TASK_COMPONENTS
        SET STATUS = :status
        WHERE TASK_COMPONENT_ID = :cid
        `,
        {
          status: newCompStatus,
          cid: log.TASK_COMPONENT_ID,
        }
      );

      // Task status recalculation
      const taskCompRes = await connection.execute(
        `
        SELECT STATUS FROM TASK_COMPONENTS
        WHERE TASK_ID = :taskId
        `,
        { taskId: log.TASK_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const statuses = taskCompRes.rows.map(r => r.STATUS);
      let taskStatus = "Pending";

      if (statuses.every(s => s === "Completed")) taskStatus = "Completed";
      else if (statuses.some(s => s !== "Pending")) taskStatus = "Under_Development";

      await connection.execute(
        `
        UPDATE TASKS
        SET STATUS = :status
        WHERE TASK_ID = :taskId
        `,
        {
          status: taskStatus,
          taskId: log.TASK_ID,
        }
      );

      await connection.commit();

      res.json({ message: "Worklog updated successfully." });
    });
  }
);

//delete a log for an employee for a task component
router.delete(
  "/components/log/:logId",
  authMiddleware(["employee", "admin", "manager", "lt", "alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const logId = Number(req.params.logId);
      const userId = req.user.id;

      // ------------------------------------------------------------------
      // 1️⃣ Fetch ownership + component + task details
      // ------------------------------------------------------------------
      const logRes = await connection.execute(
        `
        SELECT
          wl.TASK_COMPONENT_ID,
          c.TASK_ID,
          c.TOTAL_COMP_HOURS,
          t.E_ID
        FROM COMPONENT_WORKLOGS wl
        JOIN TASK_COMPONENTS c
          ON wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
        JOIN TASKS t
          ON c.TASK_ID = t.TASK_ID
        WHERE wl.WORKLOG_ID = :logId
        `,
        { logId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!logRes.rows.length)
        return res.status(404).json({ error: "Log not found" });

      const log = logRes.rows[0];

      if (Number(log.E_ID) !== Number(userId))
        return res.status(403).json({ error: "Unauthorized" });

      // ------------------------------------------------------------------
      // 2️⃣ Delete the worklog
      // ------------------------------------------------------------------
      await connection.execute(
        `DELETE FROM COMPONENT_WORKLOGS WHERE WORKLOG_ID = :logId`,
        { logId }
      );

      // ------------------------------------------------------------------
      // 3️⃣ Recalculate total logged hours for component
      // ------------------------------------------------------------------
      const sumRes = await connection.execute(
        `
        SELECT NVL(SUM(HOURS_LOGGED),0) AS TOTAL
        FROM COMPONENT_WORKLOGS
        WHERE TASK_COMPONENT_ID = :cid
        `,
        { cid: log.TASK_COMPONENT_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const totalLogged = sumRes.rows[0].TOTAL || 0;

      // ------------------------------------------------------------------
      // 4️⃣ Update component status
      // ------------------------------------------------------------------
      let componentStatus = "Pending";

      if (totalLogged > 0 && totalLogged < log.TOTAL_COMP_HOURS)
        componentStatus = "Under_Development";
      else if (totalLogged === log.TOTAL_COMP_HOURS)
        componentStatus = "Completed";

      await connection.execute(
        `
        UPDATE TASK_COMPONENTS
        SET STATUS = :status
        WHERE TASK_COMPONENT_ID = :cid
        `,
        {
          status: componentStatus,
          cid: log.TASK_COMPONENT_ID,
        }
      );

      // ------------------------------------------------------------------
      // 5️⃣ Recalculate task status
      // ------------------------------------------------------------------
      const taskCompRes = await connection.execute(
        `
        SELECT STATUS
        FROM TASK_COMPONENTS
        WHERE TASK_ID = :taskId
        `,
        { taskId: log.TASK_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const statuses = taskCompRes.rows.map(r => r.STATUS);
      let taskStatus = "Pending";

      if (statuses.every(s => s === "Completed"))
        taskStatus = "Completed";
      else if (statuses.some(s => s !== "Pending"))
        taskStatus = "Under_Development";

      await connection.execute(
        `
        UPDATE TASKS
        SET STATUS = :status
        WHERE TASK_ID = :taskId
        `,
        {
          status: taskStatus,
          taskId: log.TASK_ID,
        }
      );

      // ------------------------------------------------------------------
      // 6️⃣ Commit
      // ------------------------------------------------------------------
      await connection.commit();

      res.json({
        message: "Worklog deleted and component/task statuses updated successfully.",
      });
    });
  }
);

// GET all tasks (with filters)
// ==========================
router.get(
  "/",
  authMiddleware(["admin", "manager", "lt","alt", "head_lt"]),async (req, res) => {
    return safeRoute(req, res, async (connection) => {


      const completedStatuses = ["Live", "Preprod_Signoff", "Completed"];
      const {
        status,
        priority,
        employeeId,
        moduleId,
        projectId,
        month,
        year,
        sortBy,
      } = req.query;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Apply centralized visibility + hierarchy filter
      // -------------------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);
      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Dynamic filters
      // -------------------------------------------------------------------------
      const whereClauses = [];

      if (status && status !== "all") {
        whereClauses.push("t.STATUS = :status");
        binds.status = status;
      }
      if (priority && priority !== "all") {
        whereClauses.push("t.PRIORITY = :priority");
        binds.priority = priority;
      }
      if (employeeId) {
        whereClauses.push("t.E_ID = :employeeId");
        binds.employeeId = Number(employeeId);
      }
      if (moduleId) {
        whereClauses.push("t.MODULE_ID = :moduleId");
        binds.moduleId = Number(moduleId);
      }
      if (projectId) {
        whereClauses.push("t.PROJECT_ID = :projectId");
        binds.projectId = Number(projectId);
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Month/year filter (due date or worklog activity)
      // -------------------------------------------------------------------------
      if (month && year) {
  const { start, end } = getMonthDateRange(Number(month), Number(year));

  whereClauses.push(`
    (
      (
        t.STATUS NOT IN ('Live', 'Preprod_Signoff', 'Completed')
        AND t.DUE_DATE < :startDate
      )
      OR t.DUE_DATE BETWEEN :startDate AND :endDate
	  OR t.TASK_ID IN (
              SELECT DISTINCT tc.TASK_ID
              FROM COMPONENT_WORKLOGS wl
              JOIN TASK_COMPONENTS tc ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID
              WHERE wl.LOG_DATE BETWEEN :startDate AND :endDate
            )
      OR (
     t.STATUS NOT IN ('Live', 'Preprod_Signoff', 'Completed')
    AND EXISTS (
        SELECT 1
        FROM COMPONENT_WORKLOGS wl
        JOIN TASK_COMPONENTS tc
          ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID
        WHERE tc.TASK_ID = t.TASK_ID
    )
)

    )
  `);

  binds.startDate = start;
  binds.endDate = end;
}


      // Append centralized condition
      if (sqlCondition) whereClauses.push(sqlCondition.replace(/^ AND /, ""));

      const whereSQL = whereClauses.length
        ? "WHERE " + whereClauses.join(" AND ")
        : "";

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Sorting
      // -------------------------------------------------------------------------
      let orderBy = "ORDER BY t.CREATED_AT DESC";
      if (sortBy === "dueDateAsc") orderBy = "ORDER BY t.DUE_DATE ASC";
      else if (sortBy === "dueDateDesc") orderBy = "ORDER BY t.DUE_DATE DESC";
      else if (sortBy === "createdAtAsc") orderBy = "ORDER BY t.CREATED_AT ASC";
      else if (sortBy === "createdAtDesc") orderBy = "ORDER BY t.CREATED_AT DESC";

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Main task query
      // -------------------------------------------------------------------------
      const sql = `
        SELECT 
          t.*, 
          e.NAME AS EMPLOYEE_NAME, 
          e.DESIGNATION AS EMPLOYEE_DESIGNATION, 
          e.EMAIL AS EMPLOYEE_EMAIL,
          m.NAME AS MODULE_NAME, 
          p.NAME AS PROJECT_NAME
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        LEFT JOIN MODULES m ON t.MODULE_ID = m.ID
        LEFT JOIN PROJECTS p ON t.PROJECT_ID = p.ID
        ${whereSQL}
        ${orderBy}
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Map tasks
      // -------------------------------------------------------------------------
      let tasks = result.rows.map((row) => {
        const task = {
          taskId: row.TASK_ID,
          applicationName: row.APPLICATION_NAME,
          title: row.TITLE,
          description: row.DESCRIPTION,
          status: row.STATUS,
          priority: row.PRIORITY,
          workloadHours: row.WORKLOAD_HOURS,
          workloadHoursHHMM: formatHoursToHHMM(row.WORKLOAD_HOURS),
          eId: row.E_ID,
          moduleId: row.MODULE_ID,
          projectId: row.PROJECT_ID,
          dueDate: row.DUE_DATE,
          createdAt: row.CREATED_AT,
          updatedAt: row.UPDATED_AT,
          completedAt: row.COMPLETED_AT,
          employeeName: row.EMPLOYEE_NAME,
          employeeDesignation: row.EMPLOYEE_DESIGNATION,
          employeeEmail: row.EMPLOYEE_EMAIL,
          moduleName: row.MODULE_NAME,
          projectName: row.PROJECT_NAME,
        };
        return formatTaskDates(task);
      });

      // ✅ EARLY SAFE EXIT (no tasks found)
      if (!tasks || tasks.length === 0) {
        return res.json([]);
      }

      // -------------------------------------------------------------------------
      // STEP 7️⃣ — Overdue / completed logic
      // -------------------------------------------------------------------------
      tasks.forEach((task) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dueDate = new Date(task.dueDate);
        dueDate.setHours(0, 0, 0, 0);

        task.isOverdue =
          !completedStatuses.includes(task.status) && dueDate < today;

        if (completedStatuses.includes(task.status) && !task.completedAt) {
          task.completedAt = task.updatedAt || task.dueDate;
        }
      });

      // -------------------------------------------------------------------------
      // STEP 8️⃣ — Fetch components (with optional log filter)
      // -------------------------------------------------------------------------
      const taskIds = tasks.map((t) => t.taskId);

      // ✅ Prevent Oracle "IN ()" errors
      if (taskIds.length === 0) {
        return res.json([]);
      }

const compQuery = `
  SELECT
    c.TASK_COMPONENT_ID,
    c.TYPE,
    c.TASK_ID,
    c.COMPLEXITY,
    c.COUNT,
    c.HOURS_PER_ITEM,
    c.TOTAL_COMP_HOURS,
    c.STATUS,

    -- 🟢 Lifetime logged hours (ALL TIME)
    (
      SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
      FROM COMPONENT_WORKLOGS wl
      WHERE wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
    ) AS CUMULATIVE_LOGGED_HOURS,

    -- 🔵 Month-specific logged hours (OPTIONAL, UI only)
    (
      SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
      FROM COMPONENT_WORKLOGS wl
      WHERE wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
      ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
    ) AS LOGGED_HOURS

  FROM TASK_COMPONENTS c
  WHERE c.TASK_ID IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
`;


      const compBinds = taskIds.reduce(
        (acc, id, i) => ({ ...acc, [`tid${i}`]: id }),
        {}
      );

      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        compBinds.startDate = start;
        compBinds.endDate = end;
      }

      const compResult = await connection.execute(compQuery, compBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const components = compResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 9️⃣ — Fetch worklogs safely
      // -------------------------------------------------------------------------
      if (taskIds.length === 0) {
        return res.json([]);
      }

      const worklogsQuery = `
        SELECT
          wl.TASK_COMPONENT_ID,
          wl.LOG_DATE,
          wl.HOURS_LOGGED,
          wl.NOTES
        FROM COMPONENT_WORKLOGS wl
        WHERE wl.TASK_COMPONENT_ID IN (
          SELECT TASK_COMPONENT_ID 
          FROM TASK_COMPONENTS 
          WHERE TASK_ID IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
        )
        ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
        ORDER BY wl.TASK_COMPONENT_ID, wl.LOG_DATE DESC
      `;

      const worklogsBinds = taskIds.reduce(
        (acc, id, i) => ({ ...acc, [`tid${i}`]: id }),
        {}
      );

      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        worklogsBinds.startDate = start;
        worklogsBinds.endDate = end;
      }

      const worklogsResult = await connection.execute(worklogsQuery, worklogsBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const worklogs = worklogsResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 🔟 — Attach components & worklogs
      // -------------------------------------------------------------------------
      tasks = tasks.map((task) => {
        const taskComps = components.filter((c) => c.TASK_ID === task.taskId);
        task.components = taskComps.map((c) => {
          const componentWorklogs = worklogs
            .filter((wl) => wl.TASK_COMPONENT_ID === c.TASK_COMPONENT_ID)
            .map((wl) => ({
              logDate: wl.LOG_DATE,
              hoursLogged: wl.HOURS_LOGGED,
              hoursLoggedHHMM: formatHoursToHHMM(wl.HOURS_LOGGED),
              notes: wl.NOTES,
            }));

          return {
  id: c.TASK_COMPONENT_ID,
  type: c.TYPE,
  complexity: c.COMPLEXITY,
  count: c.COUNT,
  status: c.STATUS,
  hoursPerItem: c.HOURS_PER_ITEM,
  totalCompHours: c.TOTAL_COMP_HOURS,

  // 🔵 current month
  loggedHours: c.LOGGED_HOURS || 0,

  // 🟢 lifetime (THIS is what analytics must use)
  cumulativeLoggedHours: c.CUMULATIVE_LOGGED_HOURS || 0,

  hoursPerItemHHMM: formatHoursToHHMM(c.HOURS_PER_ITEM),
  totalCompHoursHHMM: formatHoursToHHMM(c.TOTAL_COMP_HOURS),
  worklogs: componentWorklogs,
};

        });
        return task;
      });

      // -------------------------------------------------------------------------
      // ✅ Final Response
      // -------------------------------------------------------------------------
      res.json(tasks);
    });
});

// GET tasks by employee
router.get(
  "/employee/:id",
  authMiddleware(["employee", "admin", "manager","alt", "lt", "head_lt"]),async (req, res) => {
    return safeRoute(req, res, async (connection) => {

      const completedStatuses = ["Completed", "Live", "Preprod_Signoff"];
      const { status, month, year, sortBy } = req.query;
      const empId = Number(req.params.id);
      const user = req.user;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Role-based access control
      // -------------------------------------------------------------------------
      if (user.role.toLowerCase() === "employee" && empId !== user.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Centralized visibility (multi-level hierarchy)
      // -------------------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);
      const whereClauses = ["t.E_ID = :empId"];
      binds.empId = empId;

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — High-level status group filter
      // -------------------------------------------------------------------------
      const statusGroups = {
        Pending: ["BRS_Discussion", "Approach_Preparation", "Approach_Finalization", "Pending"],
        WIP: ["Under_Development", "Under_QA", "Under_UAT", "Under_Preprod", "WIP", "UAT_Signoff"],
        Completed: ["Live", "Preprod_Signoff", "Completed"],
        Hold: ["Hold", "Dropped"],
      };

      if (status && status !== "all" && statusGroups[status]) {
        whereClauses.push(
          `t.STATUS IN (${statusGroups[status].map((_, i) => `:s${i}`).join(",")})`
        );
        statusGroups[status].forEach((s, i) => (binds[`s${i}`] = s));
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Month/year filter (due date OR worklog activity)
      // -------------------------------------------------------------------------
      if (month && year) {
  const { start, end } = getMonthDateRange(Number(month), Number(year));

  whereClauses.push(`
    (
      (
        t.STATUS NOT IN ('Live', 'Preprod_Signoff', 'Completed')
        AND t.DUE_DATE < :startDate
      )
      OR t.DUE_DATE BETWEEN :startDate AND :endDate
	  OR t.TASK_ID IN (
              SELECT DISTINCT tc.TASK_ID
              FROM COMPONENT_WORKLOGS wl
              JOIN TASK_COMPONENTS tc ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID
              WHERE wl.LOG_DATE BETWEEN :startDate AND :endDate
            )
      OR (
     t.STATUS NOT IN ('Live', 'Preprod_Signoff', 'Completed')
    AND EXISTS (
        SELECT 1
        FROM COMPONENT_WORKLOGS wl
        JOIN TASK_COMPONENTS tc
          ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID
        WHERE tc.TASK_ID = t.TASK_ID
    )
)
    )
  `);

  binds.startDate = start;
  binds.endDate = end;
}


      // Append multi-level visibility condition
      if (sqlCondition) whereClauses.push(sqlCondition.replace(/^ AND /, ""));

      const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Sorting
      // -------------------------------------------------------------------------
      let orderBy = "ORDER BY t.CREATED_AT DESC";
      if (sortBy === "dueDateAsc") orderBy = "ORDER BY t.DUE_DATE ASC";
      else if (sortBy === "dueDateDesc") orderBy = "ORDER BY t.DUE_DATE DESC";
      else if (sortBy === "createdAtAsc") orderBy = "ORDER BY t.CREATED_AT ASC";
      else if (sortBy === "createdAtDesc") orderBy = "ORDER BY t.CREATED_AT DESC";

      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Fetch tasks
      // -------------------------------------------------------------------------
      const sql = `
        SELECT 
          t.*, 
          e.NAME AS EMPLOYEE_NAME, 
          e.DESIGNATION AS EMPLOYEE_DESIGNATION, 
          e.EMAIL AS EMPLOYEE_EMAIL,
          m.NAME AS MODULE_NAME, 
          p.NAME AS PROJECT_NAME
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        LEFT JOIN MODULES m ON t.MODULE_ID = m.ID
        LEFT JOIN PROJECTS p ON t.PROJECT_ID = p.ID
        ${whereSQL}
        ${orderBy}
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // -------------------------------------------------------------------------
      // STEP 7️⃣ — Map & format tasks
      // -------------------------------------------------------------------------
      let tasks = result.rows.map((row) => {
        const task = {
          taskId: row.TASK_ID,
          title: row.TITLE,
          applicationName: row.APPLICATION_NAME,
          description: row.DESCRIPTION,
          status: row.STATUS,
          priority: row.PRIORITY,
          workloadHours: row.WORKLOAD_HOURS,
          workloadHoursHHMM: formatHoursToHHMM(row.WORKLOAD_HOURS),
          eId: row.E_ID,
          moduleId: row.MODULE_ID,
          projectId: row.PROJECT_ID,
          dueDate: row.DUE_DATE,
          createdAt: row.CREATED_AT,
          updatedAt: row.UPDATED_AT,
          completedAt: row.COMPLETED_AT,
          employeeName: row.EMPLOYEE_NAME,
          employeeDesignation: row.EMPLOYEE_DESIGNATION,
          employeeEmail: row.EMPLOYEE_EMAIL,
          moduleName: row.MODULE_NAME,
          projectName: row.PROJECT_NAME,
        };
        return formatTaskDates(task);
      });

      // ✅ Safe exit if no tasks — prevents Oracle errors downstream
      if (!tasks || tasks.length === 0) {
        return res.json([]);
      }

      // -------------------------------------------------------------------------
      // STEP 8️⃣ — Overdue & completion logic
      // -------------------------------------------------------------------------
      tasks.forEach((task) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dueDate = new Date(task.dueDate);
        dueDate.setHours(0, 0, 0, 0);

        task.isOverdue = !completedStatuses.includes(task.status) && dueDate < today;

        if (completedStatuses.includes(task.status) && !task.completedAt) {
          task.completedAt = task.updatedAt || task.dueDate;
        }
      });

      // -------------------------------------------------------------------------
      // STEP 9️⃣ — Fetch task components safely
      // -------------------------------------------------------------------------
      const taskIds = tasks.map((t) => t.taskId);
      if (taskIds.length === 0) {
        return res.json([]);
      }

      const compQuery = `
  SELECT
    c.TASK_COMPONENT_ID,
    c.TYPE,
    c.TASK_ID,
    c.COMPLEXITY,
    c.COUNT,
    c.HOURS_PER_ITEM,
    c.TOTAL_COMP_HOURS,
    c.STATUS,

    -- 🟢 Lifetime logged hours (ALL TIME)
    (
      SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
      FROM COMPONENT_WORKLOGS wl
      WHERE wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
    ) AS CUMULATIVE_LOGGED_HOURS,

    -- 🔵 Monthly logged hours (optional)
    (
      SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
      FROM COMPONENT_WORKLOGS wl
      WHERE wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
      ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
    ) AS LOGGED_HOURS

  FROM TASK_COMPONENTS c
  WHERE c.TASK_ID IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
`;

const compBinds = taskIds.reduce(
  (acc, id, i) => ({ ...acc, [`tid${i}`]: id }),
  {}
);

if (month && year) {
  const { start, end } = getMonthDateRange(Number(month), Number(year));
  compBinds.startDate = start;
  compBinds.endDate = end;
}

const compResult = await connection.execute(compQuery, compBinds, {
  outFormat: oracledb.OUT_FORMAT_OBJECT,
});

const components = compResult.rows || [];


      // -------------------------------------------------------------------------
      // STEP 🔟 — Fetch worklogs safely
      // -------------------------------------------------------------------------
      if (taskIds.length === 0) {
        return res.json([]);
      }

      const worklogsQuery = `
        SELECT
          wl.TASK_COMPONENT_ID,
          wl.LOG_DATE,
          wl.HOURS_LOGGED,
          wl.NOTES
        FROM COMPONENT_WORKLOGS wl
        WHERE wl.TASK_COMPONENT_ID IN (
          SELECT TASK_COMPONENT_ID 
          FROM TASK_COMPONENTS 
          WHERE TASK_ID IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
        )
        ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
        ORDER BY wl.TASK_COMPONENT_ID, wl.LOG_DATE DESC
      `;

      const worklogsBinds = taskIds.reduce(
        (acc, id, i) => ({ ...acc, [`tid${i}`]: id }),
        {}
      );

      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        worklogsBinds.startDate = start;
        worklogsBinds.endDate = end;
      }

      const worklogsResult = await connection.execute(worklogsQuery, worklogsBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const worklogs = worklogsResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 1️⃣1️⃣ — Attach components + worklogs to tasks
      // -------------------------------------------------------------------------
     tasks = tasks.map((task) => {
  const taskComps = components.filter((c) => c.TASK_ID === task.taskId);

  task.components = taskComps.map((c) => {
    const componentWorklogs = worklogs
      .filter((wl) => wl.TASK_COMPONENT_ID === c.TASK_COMPONENT_ID)
      .map((wl) => ({
        logDate: wl.LOG_DATE,
        hoursLogged: wl.HOURS_LOGGED,
        hoursLoggedHHMM: formatHoursToHHMM(wl.HOURS_LOGGED),
        notes: wl.NOTES,
      }));

    return {
      id: c.TASK_COMPONENT_ID,
      type: c.TYPE,
      complexity: c.COMPLEXITY,
      count: c.COUNT,
      status: c.STATUS,
      hoursPerItem: c.HOURS_PER_ITEM,
      totalCompHours: c.TOTAL_COMP_HOURS,

      // 🔵 current month (UI only)
      loggedHours: c.LOGGED_HOURS || 0,

      // 🟢 lifetime (analytics MUST use this)
      cumulativeLoggedHours: c.CUMULATIVE_LOGGED_HOURS || 0,

      hoursPerItemHHMM: formatHoursToHHMM(c.HOURS_PER_ITEM),
      totalCompHoursHHMM: formatHoursToHHMM(c.TOTAL_COMP_HOURS),
      worklogs: componentWorklogs,
    };
  });

  return task;
});
 

      // -------------------------------------------------------------------------
      // ✅ Final Safe Response
      // -------------------------------------------------------------------------
      return res.json(tasks);
     });
});

// PATCH task (update)
router.patch(
  "/:id",
  authMiddleware(["admin", "manager", "employee", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const user = req.user;
      const taskId = Number(req.params.id);

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Fetch existing task and validate existence
      // -------------------------------------------------------------------------
      const taskResult = await connection.execute(
        `SELECT * FROM TASKS WHERE TASK_ID = :id`,
        { id: taskId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!taskResult.rows.length) {
        return res.status(404).json({ error: "Task not found" });
      }

      const task = taskResult.rows[0];

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Role-based access check
      // -------------------------------------------------------------------------
      const empResult = await connection.execute(
        `SELECT MANAGER_ID, ROLE FROM EMPLOYEES WHERE ID = :eid`,
        { eid: task.E_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const emp = empResult.rows[0];
      const isManagerOfTask = emp?.MANAGER_ID === user.id;
      const isTaskOwner = task.E_ID === user.id;

      if (user.role === "employee" && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "manager" && !isManagerOfTask && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "admin" && emp?.MANAGER_ID !== user.managerId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Prepare update payload
      // -------------------------------------------------------------------------
      let updateData = { ...req.body };
      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Handle component updates
      // -------------------------------------------------------------------------
      if (Array.isArray(req.body.components)) {
        const { workloadHours, processedComponents } =
          await calculateWorkload(req.body.components, connection);

        updateData.WORKLOAD_HOURS = workloadHours;

        const existingCompsResult = await connection.execute(
          `SELECT TASK_COMPONENT_ID FROM TASK_COMPONENTS WHERE TASK_ID = :taskId`,
          { taskId },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const existingCompIds = existingCompsResult.rows.map((r) =>
          r.TASK_COMPONENT_ID.toString()
        );

        const incomingCompIds = [];

        for (const comp of processedComponents) {
          const compId = comp.id || comp.TASK_COMPONENT_ID || null;

          const bindData = {
            taskId,
            type: comp.type,
            complexity: comp.complexity,
            count: comp.count,
            hoursPerItem: comp.hoursPerItem,
            totalCompHours: comp.totalCompHours,
            fileRequired: comp.fileRequired ? 1 : 0,
            fileType: comp.fileType || null,
          };

          if (compId && existingCompIds.includes(compId.toString())) {
            incomingCompIds.push(compId.toString());

            await connection.execute(
              `
              UPDATE TASK_COMPONENTS SET
                TYPE = :type,
                COMPLEXITY = :complexity,
                COUNT = :count,
                HOURS_PER_ITEM = :hoursPerItem,
                TOTAL_COMP_HOURS = :totalCompHours,
                FILE_REQUIRED = :fileRequired,
                FILE_TYPE = :fileType,
                UPDATED_AT = SYSTIMESTAMP
              WHERE TASK_COMPONENT_ID = :compId
                AND TASK_ID = :taskId
              `,
              { ...bindData, compId },
              { autoCommit: false }
            );
          } else {
            await connection.execute(
              `
              INSERT INTO TASK_COMPONENTS
                (TASK_COMPONENT_ID, TASK_ID, TYPE, COMPLEXITY, COUNT,
                 HOURS_PER_ITEM, TOTAL_COMP_HOURS, FILE_REQUIRED, FILE_TYPE)
              VALUES
                (SEQ_TASK_COMPONENT.NEXTVAL, :taskId, :type, :complexity,
                 :count, :hoursPerItem, :totalCompHours, :fileRequired, :fileType)
              `,
              bindData,
              { autoCommit: false }
            );
          }
        }

        const compIdsToDelete = existingCompIds.filter(
          (id) => !incomingCompIds.includes(id)
        );

        if (compIdsToDelete.length) {

  const deleteBinds = {};

const placeholders = compIdsToDelete.map((id, i) => {
  deleteBinds[`id${i}`] = id;
  return `:id${i}`;
});

// ---------------------------------------------------------
// ✅ Delete associated worklogs first
// ---------------------------------------------------------
await connection.execute(
  `
  DELETE FROM COMPONENT_WORKLOGS
  WHERE TASK_COMPONENT_ID IN (${placeholders.join(",")})
  `,
  deleteBinds,
  { autoCommit: false }
);

// ---------------------------------------------------------
// ✅ Delete components
// ---------------------------------------------------------
await connection.execute(
  `
  DELETE FROM TASK_COMPONENTS
  WHERE TASK_ID = :taskId
    AND TASK_COMPONENT_ID IN (${placeholders.join(",")})
  `,
  {
    ...deleteBinds,
    taskId,
  },
  { autoCommit: false }
);
}

        await connection.commit();
      }
      // -------------------------------------------------------------------------
// ✅ STEP 4.5 — Recalculate task lifecycle from components
// -------------------------------------------------------------------------

const taskCompStatusRes = await connection.execute(
  `
  SELECT STATUS, COMPLETED_AT
  FROM TASK_COMPONENTS
  WHERE TASK_ID = :taskId
  `,
  { taskId },
  { outFormat: oracledb.OUT_FORMAT_OBJECT }
);

const rows = taskCompStatusRes.rows || [];

const completedStatuses = ["Live", "Preprod_Signoff"];

const wipStatuses = [
  "Under_Development",
  "Under_QA",
  "Under_UAT",
  "UAT_Signoff",
  "Under_Preprod",
];

let recalculatedTaskStatus = "Pending";
let recalculatedCompletedAt = null;

if (rows.length) {

  const allCompleted = rows.every((r) =>
    completedStatuses.includes(r.STATUS)
  );

  const anyWip = rows.some((r) =>
    wipStatuses.includes(r.STATUS)
  );

  const anyPending = rows.some((r) =>
    r.STATUS === "Pending"
  );

  if (allCompleted) {

    recalculatedTaskStatus = "Completed";

    recalculatedCompletedAt =
      rows
        .map((r) => r.COMPLETED_AT)
        .filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a))[0] ||
      new Date();

  } else if (anyWip || anyPending) {

    recalculatedTaskStatus = "WIP";
    recalculatedCompletedAt = null;

  }
}

// ✅ Persist recalculated values
await connection.execute(
  `
  UPDATE TASKS
  SET
    STATUS = :status,
    COMPLETED_AT = :completedAt,
    UPDATED_AT = SYSTIMESTAMP
  WHERE TASK_ID = :taskId
  `,
  {
    status: recalculatedTaskStatus,
    completedAt: recalculatedCompletedAt,
    taskId,
  },
  { autoCommit: false }
);

      const fieldMap = {
  employeeId: "E_ID",
  projectId: "PROJECT_ID",
  moduleId: "MODULE_ID",
  title: "TITLE",
  description: "DESCRIPTION",
  dueDate: "DUE_DATE",
  priority: "PRIORITY",
  status: "STATUS",
  WORKLOAD_HOURS: "WORKLOAD_HOURS",
  completedAt: "COMPLETED_AT",
};

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — FIXED normal task update (this was the bug)
      // -------------------------------------------------------------------------
      const setClauses = [];
const binds = { taskId };

// normalize dates
if (updateData.dueDate) {
  updateData.dueDate = new Date(updateData.dueDate);
}
if (updateData.completedAt) {
  updateData.completedAt = new Date(updateData.completedAt);
}
if (Array.isArray(req.body.components)) {

  // ✅ prevent stale frontend overwrite
  delete updateData.WORKLOAD_HOURS;
  delete updateData.status;
  delete updateData.completedAt;

}

Object.entries(updateData).forEach(([key, value]) => {
  const dbColumn = fieldMap[key] || fieldMap[key.toUpperCase()];
  if (!dbColumn) return;

  setClauses.push(`${dbColumn} = :${key}`);
  binds[key] = value;
});

setClauses.push("UPDATED_AT = SYSTIMESTAMP");

if (setClauses.length === 1) {
  return res.status(400).json({ error: "No valid task fields to update" });
}

const updateSQL = `
  UPDATE TASKS
  SET ${setClauses.join(", ")}
  WHERE TASK_ID = :taskId
`;

await connection.execute(updateSQL, binds, { autoCommit: true });


      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Fetch updated task
      // -------------------------------------------------------------------------
      const updatedTaskResult = await connection.execute(
        `
        SELECT 
          t.*, 
          e.NAME AS EMPLOYEE_NAME,
          e.DESIGNATION AS EMPLOYEE_DESIGNATION,
          m.NAME AS MODULE_NAME,
          p.NAME AS PROJECT_NAME
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        LEFT JOIN MODULES m ON t.MODULE_ID = m.ID
        LEFT JOIN PROJECTS p ON t.PROJECT_ID = p.ID
        WHERE t.TASK_ID = :taskId
        `,
        { taskId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      res.json(formatTaskDates(updatedTaskResult.rows[0]));
    });
  }
);

//update status of the task
router.patch(
  "/:id/status",
  authMiddleware(["admin", "manager", "employee", "alt","lt", "head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const user = req.user;
      const { id } = req.params; // componentId
      const { status, type } = req.body;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Validate request type
      // -------------------------------------------------------------------------
      if (type !== "component") {
        return res
          .status(400)
          .json({ error: "Task-level status updates are not allowed" });
      }

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Fetch component & related entities
      // -------------------------------------------------------------------------
      const compResult = await connection.execute(
        `SELECT 
            c.*, 
            t.TASK_ID, 
            t.E_ID, 
            e.MANAGER_ID, 
            c.TOTAL_COMP_HOURS, 
            c.COMPLETED_AT
         FROM TASK_COMPONENTS c
         LEFT JOIN TASKS t ON c.TASK_ID = t.TASK_ID
         LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
         WHERE c.TASK_COMPONENT_ID = :id`,
        { id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!compResult.rows.length) {
        return res.status(404).json({ error: "Component not found" });
      }

      const comp = compResult.rows[0];

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Role-based access verification
      // -------------------------------------------------------------------------
      const isTaskOwner = comp.E_ID?.toString() === user.id?.toString();
      const isTaskManager = comp.MANAGER_ID?.toString() === user.id?.toString();

      if (user.role === "employee" && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "manager" && !isTaskManager && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "admin" && comp.MANAGER_ID !== user.managerId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Update component status
      // -------------------------------------------------------------------------
      const completedStatuses = ["Live", "Preprod_Signoff"];
      const binds = { status, updatedAt: new Date(), id };
      let completedAtClause = "";

      if (completedStatuses.includes(status)) {
        completedAtClause = ", COMPLETED_AT = :completedAt";
        binds.completedAt = new Date();
      } else {
        completedAtClause = ", COMPLETED_AT = NULL";
      }

      await connection.execute(
        `UPDATE TASK_COMPONENTS
         SET STATUS = :status,
             UPDATED_AT = :updatedAt
             ${completedAtClause}
         WHERE TASK_COMPONENT_ID = :id`,
        binds,
        { autoCommit: false }
      );

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Auto-log / remove worklogs
      // -------------------------------------------------------------------------
      if (completedStatuses.includes(status)) {
        // Log missing hours if incomplete
        const logResult = await connection.execute(
          `SELECT NVL(SUM(HOURS_LOGGED), 0) AS LOGGEDHOURS
           FROM COMPONENT_WORKLOGS
           WHERE TASK_COMPONENT_ID = :componentId`,
          { componentId: comp.TASK_COMPONENT_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const loggedHours = logResult.rows[0]?.LOGGEDHOURS || 0;
        const remainingHours = comp.TOTAL_COMP_HOURS - loggedHours;

        if (remainingHours > 0) {
          await connection.execute(
            `INSERT INTO COMPONENT_WORKLOGS 
               (EMPLOYEE_ID, TASK_COMPONENT_ID, HOURS_LOGGED, LOG_DATE)
             VALUES (:employeeId, :componentId, :hours, SYSDATE)`,
            {
              employeeId: comp.E_ID,
              componentId: comp.TASK_COMPONENT_ID,
              hours: remainingHours,
            },
            { autoCommit: false }
          );
        }
      } else {
        // Reset worklogs only if reverting back
        await connection.execute(
          `DELETE FROM COMPONENT_WORKLOGS WHERE TASK_COMPONENT_ID = :componentId`,
          { componentId: comp.TASK_COMPONENT_ID },
          { autoCommit: false }
        );
      }

      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Recompute task status from all components
      // -------------------------------------------------------------------------
      const taskComponents = await connection.execute(
        `SELECT STATUS, COMPLETED_AT
           FROM TASK_COMPONENTS
           WHERE TASK_ID = :taskId`,
        { taskId: comp.TASK_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const rows = taskComponents.rows || [];
      let taskStatus = "Pending";
      let taskCompletedAt = null;

      const wipStatuses = [
        "Under_Development",
        "Under_QA",
        "Under_UAT",
        "UAT_Signoff",
        "Under_Preprod",
      ];
      const pendingStatuses = [
        "BRS_Discussion",
        "Approach_Preparation",
        "Approach_Finalization",
      ];

      if (rows.length) {
        const allCompleted = rows.every((r) =>
          completedStatuses.includes(r.STATUS)
        );
        const anyWip = rows.some((r) => wipStatuses.includes(r.STATUS));
        const anyHold = rows.some((r) => r.STATUS === "Hold");
        const allDropped = rows.every((r) => r.STATUS === "Dropped");

        if (allCompleted) {
          taskStatus = "Completed";
          taskCompletedAt =
            rows
              .map((r) => r.COMPLETED_AT)
              .filter(Boolean)
              .sort((a, b) => new Date(b) - new Date(a))[0] || new Date();
        } else if (anyWip) {
          taskStatus = "WIP";
        } else if (anyHold) {
          taskStatus = "Hold";
        } else if (allDropped) {
          taskStatus = "Dropped";
        } else {
          taskStatus = "Pending";
        }
      }

      if (taskStatus !== "Completed") taskCompletedAt = null;

      await connection.execute(
        `UPDATE TASKS
         SET STATUS = :status,
             COMPLETED_AT = :completedAt,
             UPDATED_AT = SYSTIMESTAMP
         WHERE TASK_ID = :taskId`,
        { status: taskStatus, completedAt: taskCompletedAt, taskId: comp.TASK_ID },
        { autoCommit: false }
      );

      // Commit all updates
      await connection.commit();

      // -------------------------------------------------------------------------
      // STEP 7️⃣ — Fetch updated task details
      // -------------------------------------------------------------------------
      const updatedTaskResult = await connection.execute(
        `SELECT 
            t.*, 
            e.NAME AS EMPLOYEE_NAME, 
            e.DESIGNATION AS EMPLOYEE_DESIGNATION,
            m.NAME AS MODULE_NAME, 
            p.NAME AS PROJECT_NAME,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                'id' VALUE c.TASK_COMPONENT_ID,
                'type' VALUE c.TYPE,
                'status' VALUE c.STATUS,
                'count' VALUE c.COUNT,
                'hoursPerItemHHMM' VALUE c.HOURS_PER_ITEM,
                'totalCompHours' VALUE c.TOTAL_COMP_HOURS
              ))
             FROM TASK_COMPONENTS c WHERE c.TASK_ID = t.TASK_ID) AS COMPONENTS
         FROM TASKS t
         LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
         LEFT JOIN MODULES m ON t.MODULE_ID = m.ID
         LEFT JOIN PROJECTS p ON t.PROJECT_ID = p.ID
         WHERE t.TASK_ID = :taskId`,
        { taskId: comp.TASK_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const updatedTask = updatedTaskResult.rows?.[0] || null;
      if (!updatedTask) {
        return res.json({ message: "Component status updated successfully" });
      }

      // -------------------------------------------------------------------------
      // ✅ Final Response
      // -------------------------------------------------------------------------
      return res.json(formatTaskDates(updatedTask));
    });
});

// Delete task
router.delete(
  "/:id",
  authMiddleware(["admin", "manager", "lt", "alt","head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const user = req.user;
      const taskId = Number(req.params.id);

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Fetch the task with employee hierarchy data
      // -------------------------------------------------------------------------
      const result = await connection.execute(
        `
        SELECT 
          t.TASK_ID, 
          t.E_ID, 
          t.PROJECT_ID, 
          e.MANAGER_ID, 
          e.REPORTING_MANAGER, 
          e.ROLE
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        WHERE t.TASK_ID = :taskId
        `,
        { taskId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Task not found" });
      }

      const task = result.rows[0];

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Role-based permission validation
      // -------------------------------------------------------------------------
      const isTaskOwner = task.E_ID?.toString() === user.id?.toString();
      const isTaskManager = task.MANAGER_ID?.toString() === user.id?.toString();
      const isTaskAdminManager =
        task.MANAGER_ID?.toString() === user.managerId?.toString();

      if (user.role === "manager" && !isTaskManager && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "admin" && !isTaskAdminManager) {
        return res.status(403).json({ error: "Access denied" });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Begin transaction
      // -------------------------------------------------------------------------
      await connection.execute("SAVEPOINT before_task_delete");

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Delete related data (safe sequence)
      // -------------------------------------------------------------------------
      // Delete Worklogs
      await connection.execute(
        `
        DELETE FROM COMPONENT_WORKLOGS 
        WHERE TASK_COMPONENT_ID IN (
          SELECT TASK_COMPONENT_ID FROM TASK_COMPONENTS WHERE TASK_ID = :taskId
        )
        `,
        { taskId }
      );

      // Delete Notes
      await connection.execute(
        `DELETE FROM TASK_NOTES WHERE TASK_ID = :taskId`,
        { taskId }
      );

      // Delete Attachments
      await connection.execute(
        `DELETE FROM TASK_ATTACHMENTS WHERE TASK_ID = :taskId`,
        { taskId }
      );

      // Delete Components
      await connection.execute(
        `DELETE FROM TASK_COMPONENTS WHERE TASK_ID = :taskId`,
        { taskId }
      );

      // Delete Main Task
      const deleteTaskResult = await connection.execute(
        `DELETE FROM TASKS WHERE TASK_ID = :taskId`,
        { taskId }
      );

      if (deleteTaskResult.rowsAffected === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Task not found or already deleted" });
      }

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Commit the transaction
      // -------------------------------------------------------------------------
      await connection.commit();

      // -------------------------------------------------------------------------
      // ✅ STEP 6️⃣ — Final response
      // -------------------------------------------------------------------------
      res.json({
        message: "Task and all related records deleted successfully",
        taskId,
      });
    });
});

// Dashboard statistics
router.get(
  "/stats/overview",
  authMiddleware(["employee", "manager", "admin","alt", "lt", "head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const user = req.user;
      const { employeeId, moduleId, projectId } = req.query;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Centralized visibility + hierarchy filter
      // -------------------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Dynamic filters
      // -------------------------------------------------------------------------
      const whereClauses = [];
      if (sqlCondition) whereClauses.push(sqlCondition.replace(/^ AND /, ""));

      if (employeeId) {
        whereClauses.push("t.E_ID = :employeeId");
        binds.employeeId = Number(employeeId);
      }
      if (moduleId) {
        whereClauses.push("t.MODULE_ID = :moduleId");
        binds.moduleId = Number(moduleId);
      }
      if (projectId) {
        whereClauses.push("t.PROJECT_ID = :projectId");
        binds.projectId = Number(projectId);
      }

      const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Status breakdown by task status
      // -------------------------------------------------------------------------
      const statsSQL = `
        SELECT 
          t.STATUS,
          COUNT(*) AS COUNT,
          SUM(NVL(t.WORKLOAD_HOURS, 0)) AS TOTAL_HOURS
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        ${whereSQL}
        GROUP BY t.STATUS
      `;

      const statsResult = await connection.execute(statsSQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Total task count
      // -------------------------------------------------------------------------
      const totalSQL = `
        SELECT COUNT(*) AS TOTAL
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        ${whereSQL}
      `;

      const totalResult = await connection.execute(totalSQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const totalTasks = totalResult.rows?.[0]?.TOTAL || 0;

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Overdue tasks (not completed)
      // -------------------------------------------------------------------------
      const completedStatuses = ["Live", "Preprod_Signoff", "Completed"];

      const overdueSQL = `
        SELECT COUNT(*) AS OVERDUE
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        ${whereSQL}
          AND t.DUE_DATE < :now
          AND t.STATUS NOT IN (${completedStatuses.map((_, i) => `:st${i}`).join(",")})
      `;

      completedStatuses.forEach((st, i) => (binds[`st${i}`] = st));
      binds.now = new Date();

      const overdueResult = await connection.execute(overdueSQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const overdueTasks = overdueResult.rows?.[0]?.OVERDUE || 0;

      // -------------------------------------------------------------------------
      // ✅ STEP 6️⃣ — Build consistent response
      // -------------------------------------------------------------------------
      res.json({
        totalTasks,
        overdueTasks,
        statusBreakdown: statsResult.rows || [],
      });
     });
});

// Monthly worklog for an employee
router.get(
  "/employee/:id/worklog",
  authMiddleware(["employee", "manager", "admin","alt", "lt", "head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const { month } = req.query;
      const user = req.user;
      const empId = Number(req.params.id);

      if (!month)
        return res.status(400).json({ error: "Month is required (YYYY-MM)" });

      const [year, monthNum] = month.split("-").map(Number);
      const startDate = new Date(year, monthNum - 1, 1);
      const endDate = new Date(year, monthNum, 0, 23, 59, 59);
      const daysInMonth = endDate.getDate();


      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Visibility & role validation
      // -------------------------------------------------------------------------
      if (user.role === "employee" && user.id !== empId) {
        return res
          .status(403)
          .json({ error: "Employees can only view their own worklogs" });
      }

      // Use centralized visibility builder for manager/admin roles
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);
      binds.empId = empId;

      const visibilityCheckSQL = `
        SELECT 1
        FROM EMPLOYEES e
        WHERE e.ID = :empId
        ${sqlCondition ? sqlCondition : ""}
      `;

      const visible = await connection.execute(visibilityCheckSQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (!visible.rows.length) {
        return res
          .status(403)
          .json({ error: "You are not authorized to view this employee’s worklog" });
      }

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Fetch all worklogs in the month
      // -------------------------------------------------------------------------
      const worklogSQL = `
        SELECT 
          wl.HOURS_LOGGED, 
          wl.LOG_DATE
        FROM COMPONENT_WORKLOGS wl
LEFT JOIN TASK_COMPONENTS tc
  ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID

LEFT JOIN TASKS t
  ON tc.TASK_ID = t.TASK_ID

LEFT JOIN LIVE_ISSUE_COMPONENTS lic
  ON wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID

LEFT JOIN LIVE_ISSUES li
  ON lic.LIVE_ISSUE_ID = li.ID

        LEFT JOIN EMPLOYEES e ON wl.EMPLOYEE_ID = e.ID
        WHERE wl.EMPLOYEE_ID = :empId
          AND wl.LOG_DATE BETWEEN :startDate AND :endDate
          ${sqlCondition ? sqlCondition.replace(/^ AND /, " AND ") : ""}
      `;

      const worklogResult = await connection.execute(
        worklogSQL,
        { ...binds, startDate, endDate },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const rows = worklogResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Initialize all dates in the month
      // -------------------------------------------------------------------------
      const dailyLog = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const day = String(d).padStart(2, "0");
        const monthStr = String(monthNum).padStart(2, "0");
        const dateKey = `${day}-${monthStr}-${year}`;
        dailyLog[dateKey] = 0;
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Accumulate logged hours per day
      // -------------------------------------------------------------------------
      rows.forEach((log) => {
        if (!log.LOG_DATE) return;
        const date = new Date(log.LOG_DATE);
        const key = `${String(date.getDate()).padStart(2, "0")}-${String(
          date.getMonth() + 1
        ).padStart(2, "0")}-${date.getFullYear()}`;
        dailyLog[key] += Number(log.HOURS_LOGGED) || 0;
      });

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Convert to sorted response format
      // -------------------------------------------------------------------------
      const result = Object.entries(dailyLog)
        .map(([date, hours]) => ({ date, hours }))
        .sort(
          (a, b) =>
            new Date(a.date.split("-").reverse().join("-")) -
            new Date(b.date.split("-").reverse().join("-"))
        );

      const totalHours = result.reduce((sum, d) => sum + d.hours, 0);

      // -------------------------------------------------------------------------
      // ✅ STEP 6️⃣ — Response
      // -------------------------------------------------------------------------
      res.json({
        employeeId: empId,
        month,
        totalHours,
        daily: result,
      });
     });
});

// Daily worklog for an employee
router.get(
  "/employee/:id/worklog/:date",
  authMiddleware(["employee", "manager", "admin", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {

      const { id, date } = req.params;
      const user = req.user;
      const empId = Number(id);

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Validate date
      // -------------------------------------------------------------------------
      if (!/^\d{2}-\d{2}-\d{4}$/.test(date)) {
        return res.status(400).json({ error: "Date must be DD-MM-YYYY" });
      }

      if (user.role === "employee" && user.id !== empId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Visibility (UNCHANGED)
      // -------------------------------------------------------------------------
      const visible = await connection.execute(
        `SELECT 1 FROM EMPLOYEES WHERE ID = :empId`,
        { empId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!visible.rows.length) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Worklog query (UNCHANGED)
      // -------------------------------------------------------------------------
      const worklogSQL = `
        SELECT
          wl.TASK_COMPONENT_ID      AS COMPONENT_ID,
          tc.TYPE                  AS COMPONENT_TITLE,
          tc.COMPLEXITY,
          tc.STATUS,
          tc.COMPLETED_AT,
          t.TASK_ID                AS PARENT_ID,
          t.TITLE                  AS PARENT_TITLE,
          SUM(wl.HOURS_LOGGED)     AS HOURS_LOGGED,
          MIN(wl.LOG_DATE)         AS LOG_DATE
        FROM COMPONENT_WORKLOGS wl
        JOIN TASK_COMPONENTS tc
          ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID
        JOIN TASKS t
          ON tc.TASK_ID = t.TASK_ID
        WHERE wl.EMPLOYEE_ID = :empId
          AND TRUNC(wl.LOG_DATE) = TO_DATE(:logDate, 'DD-MM-YYYY')
        GROUP BY
          wl.TASK_COMPONENT_ID,
          tc.TYPE,
          tc.COMPLEXITY,
          tc.STATUS,
          tc.COMPLETED_AT,
          t.TASK_ID,
          t.TITLE

        UNION ALL

        SELECT
          wl.TASK_COMPONENT_ID      AS COMPONENT_ID,
          lic.TYPE                 AS COMPONENT_TITLE,
          lic.COMPLEXITY           AS COMPLEXITY,
          lic.STATUS,
          lic.COMPLETED_AT         AS COMPLETED_AT,
          li.ID                    AS PARENT_ID,
          li.SHORT_DESCRIPTION     AS PARENT_TITLE,
          SUM(wl.HOURS_LOGGED)     AS HOURS_LOGGED,
          MIN(wl.LOG_DATE)         AS LOG_DATE
        FROM COMPONENT_WORKLOGS wl
        JOIN LIVE_ISSUE_COMPONENTS lic
          ON wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
        JOIN LIVE_ISSUES li
          ON lic.LIVE_ISSUE_ID = li.ID
        WHERE wl.EMPLOYEE_ID = :empId
          AND TRUNC(wl.LOG_DATE) = TO_DATE(:logDate, 'DD-MM-YYYY')
        GROUP BY
          wl.TASK_COMPONENT_ID,
          lic.TYPE,
          lic.COMPLEXITY,
          lic.STATUS,
          lic.COMPLETED_AT,
          li.ID,
          li.SHORT_DESCRIPTION
      `;

      const result = await connection.execute(
        worklogSQL,
        { empId, logDate: date },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Group results (ONLY DATE FORMATTING ADDED)
      // -------------------------------------------------------------------------
      const parentMap = {};
      let totalHours = 0;

      result.rows.forEach((row) => {

        if (!parentMap[row.PARENT_ID]) {
          parentMap[row.PARENT_ID] = {
            taskId: row.PARENT_ID,
            title: row.PARENT_TITLE,
            components: [],
          };
        }

        const formatted = formatTaskDates({
          createdAt: row.LOG_DATE,
          updatedAt: row.LOG_DATE,
          completedAt: row.COMPLETED_AT,
          dueDate: null,
        });

        parentMap[row.PARENT_ID].components.push({
          componentId: row.COMPONENT_ID,
          title: row.COMPONENT_TITLE,
          complexity: row.COMPLEXITY,
          status: row.STATUS,
          loggedAt: formatted.createdAt,
          completedAt: formatted.completedAt,
          hours: Number(row.HOURS_LOGGED) || 0,
        });

        totalHours += Number(row.HOURS_LOGGED) || 0;
      });

      // -------------------------------------------------------------------------
      // ✅ Final response (UNCHANGED)
      // -------------------------------------------------------------------------
      res.json({
        employeeId: empId,
        date,
        totalHours,
        tasks: Object.values(parentMap),
      });
    });
  }
);

// Team Worklog (Manager/Admin)
router.get(
  "/team/worklog",
  authMiddleware(["manager", "admin", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {

      const { month } = req.query;
      const user = req.user;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Validate month
      // -------------------------------------------------------------------------
      if (!month) {
        return res.status(400).json({ error: "Month is required (YYYY-MM)" });
      }

      const [year, monthNum] = month.split("-").map(Number);
      const startDate = new Date(year, monthNum - 1, 1);
      const endDate = new Date(year, monthNum, 0, 23, 59, 59);

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Centralized hierarchy filter
      // -------------------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Fetch team members
      // -------------------------------------------------------------------------
      const teamSQL = `
        SELECT e.ID AS EMPLOYEE_ID, e.NAME AS EMPLOYEE_NAME
        FROM EMPLOYEES e
        WHERE 1=1
        ${sqlCondition ? sqlCondition.replace(/^ AND /, " AND ") : ""}
        ORDER BY e.NAME
      `;

      const teamResult = await connection.execute(teamSQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (!teamResult.rows.length) return res.json([]);

      const employees = teamResult.rows;

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Total logged hours (TASK + LIVE ISSUE)
      // -------------------------------------------------------------------------
      const worklogSQL = `
        SELECT
          e.ID AS EMPLOYEE_ID,
          NVL(SUM(wl.HOURS_LOGGED), 0) AS TOTAL_HOURS
        FROM EMPLOYEES e

        LEFT JOIN COMPONENT_WORKLOGS wl
          ON wl.EMPLOYEE_ID = e.ID
         AND wl.LOG_DATE BETWEEN :startDate AND :endDate

        LEFT JOIN TASK_COMPONENTS tc
          ON wl.TASK_COMPONENT_ID = tc.TASK_COMPONENT_ID
        LEFT JOIN TASKS t
          ON tc.TASK_ID = t.TASK_ID

        LEFT JOIN LIVE_ISSUE_COMPONENTS lic
          ON wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
        LEFT JOIN LIVE_ISSUES li
          ON lic.LIVE_ISSUE_ID = li.ID

        WHERE 1=1
        ${sqlCondition ? sqlCondition.replace(/^ AND /, " AND ") : ""}
        GROUP BY e.ID
      `;

      const worklogResult = await connection.execute(
        worklogSQL,
        { ...binds, startDate, endDate },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const worklogs = worklogResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Merge (show 0-hour employees also)
      // -------------------------------------------------------------------------
      const final = employees.map((emp) => {
        const record = worklogs.find(
          (w) => w.EMPLOYEE_ID.toString() === emp.EMPLOYEE_ID.toString()
        );

        return {
          id: emp.EMPLOYEE_ID,
          name: emp.EMPLOYEE_NAME,
          totalHours: record ? Number(record.TOTAL_HOURS) : 0,
        };
      });

      res.json(final);
    });
  }
);

// Self Task Progress (Employee)
router.get(
  "/tasks-progress/self",
  authMiddleware(["employee", "manager", "admin","alt", "lt", "head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const { month, year } = req.query;
      const user = req.user;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Validate parameters
      // -------------------------------------------------------------------------
      if (!month || !year)
        return res.status(400).json({ error: "Month and year required" });

      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);


      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Apply centralized multi-level hierarchy filter
      // -------------------------------------------------------------------------
      const visibility = buildVisibilityOracle(user, req.query);
      let sqlCondition = visibility.sqlCondition;
      const binds = visibility.binds;

      // If employee → only their own stats
      if (user.role.toLowerCase() === "employee") {
        sqlCondition += " AND t.E_ID = :empId";
        binds.empId = user.id;
      }

      binds.startDate = startDate;
      binds.endDate = endDate;

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Fetch tasks including partial progress
      // -------------------------------------------------------------------------
      const sql = `
        SELECT 
          t.STATUS,
          COUNT(DISTINCT t.TASK_ID) AS COUNT
        FROM TASKS t
        LEFT JOIN EMPLOYEES e ON t.E_ID = e.ID
        WHERE 1=1
          ${sqlCondition ? sqlCondition.replace(/^ AND /, " AND ") : ""}
          AND (
            t.DUE_DATE BETWEEN :startDate AND :endDate
            OR EXISTS (
              SELECT 1
              FROM COMPONENT_WORKLOGS wl
              JOIN TASK_COMPONENTS c ON wl.TASK_COMPONENT_ID = c.TASK_COMPONENT_ID
              WHERE c.TASK_ID = t.TASK_ID
                AND wl.LOG_DATE BETWEEN :startDate AND :endDate
            )
          )
        GROUP BY t.STATUS
      `;

      const statusResult = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Fetch employee name
      // -------------------------------------------------------------------------
      const empSQL = `
        SELECT NAME 
        FROM EMPLOYEES e
        WHERE e.ID = :empId
      `;
      const empResult = await connection.execute(
        empSQL,
        { empId: user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const employeeName = empResult.rows[0]?.NAME || "N/A";

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Format output safely
      // -------------------------------------------------------------------------
      const statuses =
        statusResult.rows.length > 0
          ? statusResult.rows.map((r) => ({
              status: r.STATUS,
              count: Number(r.COUNT),
            }))
          : [];

      res.json({
        employeeId: user.id,
        name: employeeName,
        statuses,
      });
     });
});

module.exports = router;
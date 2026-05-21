const oracledb = require("oracledb");
const {buildVisibilityOracle} = require('../utils/visibilityOracle')

// Helper for UI date formatting
const formatDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`; // or any format you want
};

const formatProjectDates = (project) => {
  return {
    ...project,
    startDateDisplay: formatDate(project.startDate),
    plannedEndDateDisplay: formatDate(project.plannedEndDate),
    sprintStartDateDisplay: formatDate(project.sprintStartDate),
    sprintEndDateDisplay: formatDate(project.sprintEndDate),
    createdAtDisplay: formatDate(project.createdAt),
    updatedAtDisplay: formatDate(project.updatedAt),
    uatReleaseDateDisplay: formatDate(project.uatReleaseDate),
    goLiveEndDateDisplay: formatDate(project.goLiveEndDate)
  };
};

// Utility to calculate man-days (excluding weekends)
async function calculateManDays(start, end) {
  if (!start || !end) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  
  let count = 0;
  const currentDate = new Date(startDate);
  
  while (currentDate <= endDate) {
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Exclude Sunday (0) and Saturday (6)
      count++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return count > 0 ? count : 0;
}

// Auto-update project tracking status
async function updateTrackingStatus(project) {
  const today = new Date();
  const updates = {};

  // Define stages in order
  const stages = [
    "BRS_Discussion",
    "Approach_Preparation",
    "Approach_Finalization",
    "Under_Development",
    "Under_QA",
    "Under_UAT",
    "UAT_Signoff",
    "Under_Preprod",
    "Preprod_Signoff",
    "Live"
  ];

  const stageIndex = stages.indexOf(project.projectStage);

  // ------------------- On Track Status -------------------
  if (project.startDate && project.plannedEndDate) {
    const daysRemaining = calculateManDays(today, new Date(project.plannedEndDate));
    updates.onTrackStatus = daysRemaining <= 0 ? "Delayed" : "On Track";
  }

  // ------------------- Sprint Dates -------------------
  const devIndex = stages.indexOf("Under_Development");
  if (stageIndex === devIndex && !project.sprintStartDate) {
    updates.sprintStartDate = today;
    updates.sprintEndDate = null; // will complete when leaving development
  } else if (stageIndex > devIndex && project.sprintStartDate && !project.sprintEndDate) {
    // Leaving development → set sprint end
    updates.sprintEndDate = today;
  } else if (stageIndex < devIndex) {
    // Rolling back before development → clear sprint dates
    updates.sprintStartDate = null;
    updates.sprintEndDate = null;
  }

  // ------------------- UAT Release Date -------------------
  const uatIndex = stages.indexOf("UAT_Signoff");
  if (stageIndex === uatIndex && !project.uatReleaseDate) {
    updates.uatReleaseDate = today; // first time entering UAT_Signoff
  } else if (stageIndex < uatIndex) {
    updates.uatReleaseDate = null; // rollback
  }
  // stageIndex > uatIndex → keep existing UAT date (forward-safe)

  // ------------------- Go Live Date -------------------
  const liveIndex = stages.indexOf("Live");
  if (stageIndex === liveIndex && !project.goLiveEndDate) {
    updates.goLiveEndDate = today; // first time entering Live
  } else if (stageIndex < liveIndex) {
    updates.goLiveEndDate = null; // rollback
  }
  // stageIndex > liveIndex → keep existing Go Live date

  // ------------------- Man Days -------------------
  if (project.startDate && project.plannedEndDate) {
    updates.manDays = calculateManDays(project.startDate, project.plannedEndDate);
  }

  return updates;
}

exports.createProject = async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();
    
    const {
      moduleId,applicationName, name, description, startDate,
      plannedEndDate, priority, projectStage = "BRS_Discussion",
      days, dependencyOn, bsgRemarks, techFprTl,
      businessFprTl, bsgFpr, platform, crNumbers,
      roi, brsFilename, projectCost, remarks, team
    } = req.body;

    const managerId = req.user.managerId || req.user.id;

    // ------------------ Date Helpers ------------------
    const parseDate = (d) => {
      if (!d) return null;
      const dateObj = new Date(d);
      if (isNaN(dateObj.getTime())) return null;
      
      // Create a clean Date object at midnight UTC to avoid timezone issues
      return new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
    };

    const validStart = parseDate(startDate);
    const validEnd = parseDate(plannedEndDate);

    // Use current date if no start date provided
    const finalStartDate = validStart || new Date(Date.UTC(
      new Date().getFullYear(), 
      new Date().getMonth(), 
      new Date().getDate()
    ));

    // ------------------ Man-days ------------------
    let manDaysValue = days ?? (finalStartDate && validEnd ? await calculateManDays(finalStartDate, validEnd) : null);

    // ------------------ On Track Status ------------------
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let onTrackStatus = "On Track";
    if (validEnd && validEnd < today) {
      onTrackStatus = "Delayed";
    }

    // ------------------ Sprint Dates ------------------
    let sprintStartDate = null;
    let sprintEndDate = null;
    if (projectStage === "Under_Development") {
      sprintStartDate = new Date(Date.UTC(
        today.getFullYear(), 
        today.getMonth(), 
        today.getDate()
      ));
      sprintEndDate = null;
      manDaysValue = manDaysValue || (validEnd ? await calculateManDays(sprintStartDate, validEnd) : null);
    }
    let finalApplicationName = applicationName;
            if (Number(applicationName) && applicationName !== "all") {
              const appRes = await connection.execute(
                `SELECT name FROM applications WHERE id = :id`,
                { id: Number(applicationName) },
                { outFormat: oracledb.OUT_FORMAT_OBJECT }
              );
            
              if (appRes.rows.length > 0) {
                finalApplicationName = appRes.rows[0].NAME;
              }
            }
    // ------------------ Bind Variables ------------------
    const binds = {
      moduleId: moduleId || null,
      applicationName: finalApplicationName || null,
      name: name || null,
      description: description || null,
      startDate: finalStartDate,
      plannedEndDate: validEnd,
      managerId: managerId,
      priority: priority || null,
      projectStage: projectStage,
      dependencyOn: dependencyOn || null,
      bsgRemarks: bsgRemarks || null,
      techFprTl: techFprTl || null,
      businessFprTl: businessFprTl || null,
      bsgFpr: bsgFpr || null,
      platform: platform || null,
      crNumbers: Array.isArray(crNumbers) ? crNumbers.join(",") : (crNumbers || null),
      roi: roi || null,
      brsFilename: brsFilename || null,
      projectCost: projectCost || null,
      sprintStartDate: sprintStartDate,
      sprintEndDate: sprintEndDate,
      manDays: manDaysValue,
      onTrackStatus: onTrackStatus,
      remarks: remarks || null,
      team: team || null,
      newId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
    };

    // ------------------ Insert Project ------------------
    const insertQuery = `
      INSERT INTO projects (
        id, module_id, application_name, name, description, start_date, planned_end_date, manager_id,
        priority, project_stage, dependency_on, bsg_remarks, tech_fpr_tl,
        business_fpr_tl, bsg_fpr, platform, cr_numbers, roi, brs_filename,
        project_cost, sprint_start_date, sprint_end_date, man_days,
        on_track_status, remarks, team
      ) VALUES (
        projects_seq.NEXTVAL, :moduleId, :applicationName, :name, :description, :startDate, :plannedEndDate, :managerId,
        :priority, :projectStage, :dependencyOn, :bsgRemarks, :techFprTl,
        :businessFprTl, :bsgFpr, :platform, :crNumbers, :roi, :brsFilename,
        :projectCost, :sprintStartDate, :sprintEndDate, :manDays,
        :onTrackStatus, :remarks, :team
      ) RETURNING id INTO :newId
    `;

    const result = await connection.execute(insertQuery, binds, { autoCommit: true });
    const projectId = result.outBinds.newId[0];

    res.status(201).json({
      message: "Project created successfully",
      project: {
        id: projectId,
        moduleId,applicationName, name, description,
        startDate: finalStartDate,
        plannedEndDate: validEnd,
        sprintStartDate, sprintEndDate,
        manDays: manDaysValue,
        onTrackStatus, priority, projectStage, dependencyOn, bsgRemarks, techFprTl,
        businessFprTl, bsgFpr, platform, crNumbers, roi, brsFilename, projectCost,
        remarks, team
      }
    });

  } catch (err) {
    console.error("Failed to create project:", err);
    res.status(400).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error(err); }
    }
  }
};

// GET all projects with analytics
const toCamelCase = (obj) => {
  if (!obj) return obj;
  return Object.keys(obj).reduce((acc, key) => {
    const camelKey = key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    acc[camelKey] = obj[key];
    return acc;
  }, {});
};

exports.getProjects = async (req, res) => {
  let connection;

  try {
    connection = await oracledb.getConnection();

    const user = req.user;
    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);
    const filters = {
      moduleId: req.query.moduleId,
      priority: req.query.priority,
      projectStage: req.query.projectStage,
      onTrackStatus: req.query.onTrackStatus,
      startDateFrom: req.query.startDateFrom,
      startDateTo: req.query.startDateTo,
      applicationId: req.query.applicationId
    };

/* ---------------------------------------------------------
   1️⃣ Build visibility WHERE clause
--------------------------------------------------------- */

let where = "";
let finalBinds = { ...binds }; // start with visibility binds

if (req.user.role === "admin" || req.user.role === "employee") {
  // TL → show projects of his manager's modules
  where = `
    WHERE m.manager_id = (
      SELECT manager_id
      FROM employees
      WHERE id = :currentUserId
    )
  `;
  finalBinds = {
    currentUserId: req.user.id
  };
} else {
  // Normal hierarchy visibility
  where = `
    WHERE m.manager_id IN (
      SELECT e.id
      FROM employees e
      WHERE 1=1
      ${sqlCondition}
    )
  `;
}

   if (filters.moduleId) {
  where += ` AND p.module_id = :moduleId`;
  finalBinds.moduleId = Number(filters.moduleId);
}

if (filters.applicationId && filters.applicationId !== "all") {
  where += ` AND m.application_id = :applicationId`;
  finalBinds.applicationId = Number(filters.applicationId);
}

if (filters.priority) {
  where += ` AND p.priority = :priority`;
  finalBinds.priority = filters.priority;
}

if (filters.projectStage) {
  where += ` AND p.project_stage = :projectStage`;
  finalBinds.projectStage = filters.projectStage;
}

if (filters.onTrackStatus) {
  where += ` AND p.on_track_status = :onTrackStatus`;
  finalBinds.onTrackStatus = filters.onTrackStatus;
}

if (filters.startDateFrom) {
  where += ` AND p.start_date >= TO_DATE(:startDateFrom, 'YYYY-MM-DD')`;
  finalBinds.startDateFrom = filters.startDateFrom;
}

if (filters.startDateTo) {
  where += ` AND p.start_date <= TO_DATE(:startDateTo, 'YYYY-MM-DD')`;
  finalBinds.startDateTo = filters.startDateTo;
}

    /* ---------------------------------------------------------
       2️⃣ Fetch Projects
    --------------------------------------------------------- */

    const query = `
  SELECT
    p.*,
    m.name AS module_name,
    e.name AS tech_tl_name,
    m.application_id
  FROM projects p
  JOIN modules m ON m.id = p.module_id
  LEFT JOIN employees e ON p.tech_fpr_tl = e.id
  ${where}
  ORDER BY p.created_at DESC
`;

const result = await connection.execute(
  query,
  finalBinds,
  { outFormat: oracledb.OUT_FORMAT_OBJECT }
);



    let projects = result.rows.map(toCamelCase);

    /* ---------------------------------------------------------
       3️⃣ Real-Time Status Calculation
    --------------------------------------------------------- */

    const today = new Date();
    today.setHours(0, 0, 0, 0);

const computeOnTrackStatus = (
  plannedEnd,
  projectStage,
  storedStatus,
  goLiveDate
) => {

  if (!plannedEnd) return "On Track";

  const planned = new Date(plannedEnd);

  if (isNaN(planned.getTime()))
    return "On Track";

  planned.setHours(0, 0, 0, 0);

  // --------------------------------------------------
  // ✅ LIVE projects → compare actual live date
  // --------------------------------------------------
  if (projectStage === "Live") {

    if (!goLiveDate)
      return storedStatus || "On Track";

    const live = new Date(goLiveDate);

    if (isNaN(live.getTime()))
      return storedStatus || "On Track";

    live.setHours(0, 0, 0, 0);

    return live > planned
      ? "Delayed"
      : "On Track";
  }

  // --------------------------------------------------
  // Active projects → compare current date
  // --------------------------------------------------
  return today > planned
    ? "Delayed"
    : "On Track";
};

    const updatedProjects = [];

    for (let project of projects) {
      const storedStatus = project.onTrackStatus;
const computedStatus = computeOnTrackStatus(
  project.plannedEndDate,
  project.projectStage,
  project.onTrackStatus,
  project.goLiveEndDate
);

      // Always return real-time value
      project.onTrackStatus = computedStatus;

      // Sync DB only if mismatch
      if (storedStatus !== computedStatus) {
        await connection.execute(
          `
          UPDATE projects
          SET on_track_status = :status
          WHERE id = :projectId
          `,
          {
            status: computedStatus,
            projectId: project.id
          },
          { autoCommit: true }
        );
      }

      updatedProjects.push(await formatProjectDates(project));
    }

    /* ---------------------------------------------------------
       4️⃣ Analytics
    --------------------------------------------------------- */

    const analytics = {
      total: updatedProjects.length,
      live: updatedProjects.filter(p => p.projectStage === "Live").length,
      byStatus: {
        onTrack: updatedProjects.filter(p => p.onTrackStatus === "On Track").length,
        delayed: updatedProjects.filter(p => p.onTrackStatus === "Delayed").length
      },
      byPriority: {
        high: updatedProjects.filter(p => p.priority === "High").length,
        medium: updatedProjects.filter(p => p.priority === "Medium").length,
        low: updatedProjects.filter(p => p.priority === "Low").length,
        regulatory: updatedProjects.filter(p => p.priority === "Regulatory").length
      },
      byStage: updatedProjects.reduce((acc, project) => {
        acc[project.projectStage] = (acc[project.projectStage] || 0) + 1;
        return acc;
      }, {})
    };

    res.json({
      projects: updatedProjects,
      analytics,
      filters: req.query
    });

  } catch (err) {
    console.error("Failed to fetch projects:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};


// ---------------------------
// GET project names only
exports.getProjectNames = async (req, res) => {
  let connection;

  try {
    connection = await oracledb.getConnection();

    const user = req.user;
    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

    const { applicationId, moduleId } = req.query;

    /* ---------------------------------------------------------
       1️⃣ Build visibility WHERE clause
    --------------------------------------------------------- */

    let where = "";
    let finalBinds = {};

    if (user.role === "admin" || user.role === "employee") {
      // TL → show projects of his manager's modules
      where = `
        WHERE m.manager_id = (
          SELECT manager_id
          FROM employees
          WHERE id = :currentUserId
        )
      `;

      finalBinds.currentUserId = user.id;

    } else {
      // Normal hierarchy visibility
      where = `
        WHERE m.manager_id IN (
          SELECT e.id
          FROM employees e
          WHERE 1=1
          ${sqlCondition}
        )
      `;

      finalBinds = { ...binds };
    }

    /* ---------------------------------------------------------
       2️⃣ Optional Filters
    --------------------------------------------------------- */

    if (applicationId && applicationId !== "all") {
      where += ` AND m.application_id = :applicationId`;
      finalBinds.applicationId = Number(applicationId);
    }

    if (moduleId) {
      where += ` AND p.module_id = :moduleId`;
      finalBinds.moduleId = Number(moduleId);
    }

    /* ---------------------------------------------------------
       3️⃣ Execute Query
    --------------------------------------------------------- */

    const query = `
      SELECT
        p.id,
        p.module_id,
        p.name
      FROM projects p
      JOIN modules m ON m.id = p.module_id
      ${where}
      ORDER BY p.created_at DESC
    `;

    const result = await connection.execute(
      query,
      finalBinds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const projects = result.rows.map(row => ({
      id: row.ID,
      moduleId: row.MODULE_ID,
      name: row.NAME
    }));

    res.json(projects);

  } catch (err) {
    console.error("Failed to fetch project names:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); }
      catch (err) { console.error(err); }
    }
  }
};


// ---------------------------
// GET single project with recommendations
exports.getProjectById = async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const managerId = req.user.managerId || req.user.id;
    const projectId = req.params.id;

    const result = await connection.execute(
      `SELECT p.*, m.name AS module_name
       FROM projects p
       LEFT JOIN modules m ON p.module_id = m.id
       WHERE p.id = :projectId AND p.manager_id = :managerId`,
      { projectId, managerId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const project = result.rows[0];
    if (!project) return res.status(404).json({ error: "Project not found or access denied" });

    // Auto-update tracking status
    const updates = updateTrackingStatus(project);
    if (Object.keys(updates).length > 0) {
      const updateQuery = `
        UPDATE projects
        SET ${Object.keys(updates).map(k => `${k} = :${k}`).join(", ")}
        WHERE id = :projectId
      `;
      await connection.execute(updateQuery, { ...updates, projectId: project.ID }, { autoCommit: true });
      Object.assign(project, updates);
    }

    // Generate recommendations
    const recommendations = [];
    if (project.onTrackStatus === "Delayed") {
      recommendations.push({ type: "warning", message: "Project is delayed. Consider reviewing timeline and resources." });
    }
    if (!project.dependencyOn && project.priority === "High") {
      recommendations.push({ type: "info", message: "High priority project with no dependencies listed. Verify if there are implicit dependencies." });
    }
    if (project.manDays && project.manDays > 100) {
      recommendations.push({ type: "suggestion", message: "Large project detected. Consider breaking into smaller modules or phases." });
    }

    res.json({
      project: formatProjectDates(project),
      recommendations,
      autoUpdated: Object.keys(updates).length > 0 ? updates : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// Update Project with enhanced automation (OracleDB)
exports.updateProject = async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();

    const managerId = req.user.managerId || req.user.id;
    const projectId = req.params.id;

    // --------------------------------------------------
    // Fetch updater name
    // --------------------------------------------------
    const userResult = await connection.execute(
      `SELECT name FROM employees WHERE id = :id`,
      { id: req.user.id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const updatedBy = userResult.rows[0]?.NAME || `User-${req.user.id}`;

    // --------------------------------------------------
    // Fetch existing project
    // --------------------------------------------------
    const projectResult = await connection.execute(
      `SELECT * FROM projects WHERE id = :id AND manager_id = :managerId`,
      { id: projectId, managerId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!projectResult.rows?.length) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    const currentProject = projectResult.rows[0];

    // --------------------------------------------------
    // Utilities
    // --------------------------------------------------
    const parseDate = (d) => {
      if (!d) return null;
      const date = new Date(d);
      if (isNaN(date.getTime())) return null;
      date.setHours(0, 0, 0, 0);
      return date;
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

// const computeOnTrackStatus = (plannedEnd, projectStage, currentOnTrackStatus) => {
//   // Only preserve Delayed permanently if project is already Live
//   if (projectStage === "Live" && currentOnTrackStatus === "Delayed") return "Delayed";

//   // Active project — always recompute fresh from the date
//   if (!plannedEnd) return "On Track";
//   const planned = new Date(plannedEnd);
//   planned.setHours(0, 0, 0, 0);
//   return today > planned ? "Delayed" : "On Track";
// };

const computeOnTrackStatus = (
  plannedEnd,
  projectStage,
  currentOnTrackStatus,
  goLiveDate
) => {

  if (!plannedEnd) return "On Track";

  const planned = new Date(plannedEnd);
  planned.setHours(0, 0, 0, 0);

  // --------------------------------------------------
  // ✅ If project is LIVE, compare actual live date
  // --------------------------------------------------
  if (projectStage === "Live") {

    if (!goLiveDate) return "On Track";

    const live = new Date(goLiveDate);
    live.setHours(0, 0, 0, 0);

    return live > planned ? "Delayed" : "On Track";
  }

  // --------------------------------------------------
  // Active project → compare today
  // --------------------------------------------------
  return today > planned ? "Delayed" : "On Track";
};

    const parseClobJson = async (clob) => {
  if (!clob) return [];
  try {
    if (clob instanceof oracledb.Lob) {
      let data = "";
      clob.setEncoding("utf8");
      for await (const chunk of clob) data += chunk;
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === "object" && parsed !== null) return Object.values(parsed); // 👈 recover object data
      return [];
    }
    const parsed = JSON.parse(clob);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) return Object.values(parsed); // 👈 recover object data
    return [];
  } catch {
    return [];
  }
};

    // --------------------------------------------------
    // Allowed fields
    // --------------------------------------------------
    const allowedFields = {
      module_id: req.body.moduleId ?? currentProject.MODULE_ID,
      name: req.body.name ?? currentProject.NAME,
      description: req.body.description ?? currentProject.DESCRIPTION,
      start_date: req.body.startDate
        ? parseDate(req.body.startDate)
        : currentProject.START_DATE,
      planned_end_date: req.body.plannedEndDate
        ? parseDate(req.body.plannedEndDate)
        : currentProject.PLANNED_END_DATE,
      priority: req.body.priority ?? currentProject.PRIORITY,
      project_stage: req.body.projectStage ?? currentProject.PROJECT_STAGE,
      days: req.body.days ?? currentProject.DAYS,
      dependency_on: req.body.dependencyOn ?? currentProject.DEPENDENCY_ON,
      bsg_remarks: req.body.bsgRemarks ?? currentProject.BSG_REMARKS,
      tech_fpr_tl: req.body.techFprTl ?? currentProject.TECH_FPR_TL,
      business_fpr_tl:
        req.body.businessFprTl ?? currentProject.BUSINESS_FPR_TL,
      bsg_fpr: req.body.bsgFpr ?? currentProject.BSG_FPR,
      platform: req.body.platform ?? currentProject.PLATFORM,
      cr_numbers: req.body.crNumbers ?? currentProject.CR_NUMBERS,
      roi: req.body.roi ?? currentProject.ROI,
      brs_filename: req.body.brsFilename ?? currentProject.BRS_FILENAME,
      project_cost: req.body.projectCost ?? currentProject.PROJECT_COST,
      remarks: req.body.remarks ?? currentProject.REMARKS,
      discussion_delay_reason:
        req.body.discussionDelayReason ??
        currentProject.DISCUSSION_DELAY_REASON,
      team: req.body.team ?? currentProject.TEAM,
      application_name:
  req.body.applicationName ?? currentProject.APPLICATION_NAME,
    };

    // --------------------------------------------------
    // STAGE TRANSITION LOGIC (FIX)
    // --------------------------------------------------
    const stages = [
      "BRS_Discussion",
      "Approach_Preparation",
      "Approach_Finalization",
      "Under_Development",
      "Under_QA",
      "Under_UAT",
      "UAT_Signoff",
      "Under_Preprod",
      "Preprod_Signoff",
      "Live",
    ];

    const oldStageIndex = stages.indexOf(currentProject.PROJECT_STAGE);
    const newStageIndex = stages.indexOf(allowedFields.project_stage);

    // Sprint dates
    if (newStageIndex >= stages.indexOf("Under_Development")) {
      allowedFields.sprint_start_date =
        currentProject.SPRINT_START_DATE ||
        (allowedFields.project_stage === "Under_Development" ? today : null);

      allowedFields.sprint_end_date =
        currentProject.PROJECT_STAGE === "Under_Development" &&
        newStageIndex > oldStageIndex
          ? today
          : currentProject.SPRINT_END_DATE || null;
    } else {
      allowedFields.sprint_start_date = null;
      allowedFields.sprint_end_date = null;
    }

    // UAT release date
    const uatIndex = stages.indexOf("UAT_Signoff");
    allowedFields.uat_release_date =
      oldStageIndex < uatIndex && newStageIndex >= uatIndex
        ? currentProject.UAT_RELEASE_DATE || today
        : newStageIndex < uatIndex
        ? null
        : currentProject.UAT_RELEASE_DATE;

    // Go-live date
    const liveIndex = stages.indexOf("Live");
    allowedFields.go_live_end_date =
      oldStageIndex < liveIndex && newStageIndex >= liveIndex
        ? currentProject.GO_LIVE_END_DATE || today
        : newStageIndex < liveIndex
        ? null
        : currentProject.GO_LIVE_END_DATE;

    // Man-days
    allowedFields.man_days =
      allowedFields.start_date && allowedFields.planned_end_date
        ? await calculateManDays(
            allowedFields.start_date,
            allowedFields.planned_end_date
          )
        : currentProject.MAN_DAYS;

    // --------------------------------------------------
    // Auto compute on_track_status
    // --------------------------------------------------
    // ✅ Correct call
allowedFields.on_track_status = computeOnTrackStatus(
  allowedFields.planned_end_date,
  allowedFields.project_stage,
  currentProject.ON_TRACK_STATUS,
  allowedFields.go_live_end_date
);

    // --------------------------------------------------
    // PROJECT_CHANGES_RECEIVED (MERGE)
    // --------------------------------------------------
    const existingChanges = await parseClobJson(
      currentProject.PROJECT_CHANGES_RECEIVED
    );

    const incomingChanges = Array.isArray(req.body.projectChangesReceived)
      ? req.body.projectChangesReceived.map((c) => ({
          date: c.date,
          stage: c.stage,
          details: c.details,
          updatedBy,
          timestamp: c.timestamp || new Date().toISOString(),
        }))
      : [];

    const mergedChanges = [...existingChanges, ...incomingChanges];
    const finalProjectChangesReceived =
      mergedChanges.length > 0 ? JSON.stringify(mergedChanges) : null;

    // --------------------------------------------------
    // CHANGE LOG (SYSTEM AUDIT)
    // --------------------------------------------------
    const changes = {};
    for (const [key, newValue] of Object.entries(allowedFields)) {
      const oldValue = currentProject[key.toUpperCase()];
      const oldNorm = oldValue ?? null;
      const newNorm = newValue ?? null;

      const isDate =
        oldNorm instanceof Date ||
        newNorm instanceof Date ||
        (!isNaN(Date.parse(oldNorm)) && !isNaN(Date.parse(newNorm)));

      const different = isDate
        ? new Date(oldNorm || 0).getTime() !==
          new Date(newNorm || 0).getTime()
        : oldNorm !== newNorm;

      if (different) {
        changes[key] = { old: oldNorm, new: newNorm };
      }
    }

    const changeLog = await parseClobJson(currentProject.CHANGE_LOG);
    if (Object.keys(changes).length) {
      changeLog.push({
        timestamp: new Date(),
        updatedBy,
        changes,
      });
    }

    // --------------------------------------------------
    // UPDATE PROJECT
    // --------------------------------------------------
    await connection.execute(
      `
      UPDATE projects SET
        module_id = :module_id,
        application_name = :application_name,
        name = :name,
        description = :description,
        start_date = :start_date,
        planned_end_date = :planned_end_date,
        priority = :priority,
        project_stage = :project_stage,
        days = :days,
        dependency_on = :dependency_on,
        bsg_remarks = :bsg_remarks,
        tech_fpr_tl = :tech_fpr_tl,
        business_fpr_tl = :business_fpr_tl,
        bsg_fpr = :bsg_fpr,
        platform = :platform,
        cr_numbers = :cr_numbers,
        roi = :roi,
        brs_filename = :brs_filename,
        project_cost = :project_cost,
        remarks = :remarks,
        discussion_delay_reason = :discussion_delay_reason,
        team = :team,
        sprint_start_date = :sprint_start_date,
        sprint_end_date = :sprint_end_date,
        uat_release_date = :uat_release_date,
        go_live_end_date = :go_live_end_date,
        man_days = :man_days,
        on_track_status = :on_track_status,
        project_changes_received = :project_changes_received,
        updated_at = SYSTIMESTAMP,
        updated_by = :updated_by,
        change_log = :change_log
      WHERE id = :id AND manager_id = :managerId
      `,
      {
        ...allowedFields,
        project_changes_received: finalProjectChangesReceived,
        change_log: changeLog.length ? JSON.stringify(changeLog) : null,
        updated_by: updatedBy,
        id: projectId,
        managerId,
      },
      { autoCommit: true }
    );

    // --------------------------------------------------
    // Fetch updated project
    // --------------------------------------------------
    const updated = await connection.execute(
      `SELECT * FROM projects WHERE id = :id`,
      { id: projectId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json({
      message: "Project updated successfully",
      project: updated.rows[0],
      updatedBy,
      changes,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
};

// Delete Project
exports.deleteProject = async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const managerId = req.user.managerId || req.user.id;
    const projectId = req.params.id;

    // Fetch the project first
    const result = await connection.execute(
      `SELECT * FROM projects WHERE id = :id AND manager_id = :managerId`,
      { id: projectId, managerId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    const project = result.rows[0];

    // Delete project
    await connection.execute(
      `DELETE FROM projects WHERE id = :id AND manager_id = :managerId`,
      { id: projectId, managerId },
      { autoCommit: true }
    );

    // // Remove project reference from module
    // await connection.execute(
    //   `UPDATE modules
    //    SET projects = projects - :proj_id
    //    WHERE id = :moduleId AND manager_id = :managerId`,
    //   { proj_id: projectId, moduleId: project.MODULE_ID, managerId },
    //   { autoCommit: true }
    // );

    res.json({
      message: "Project deleted successfully",
      deletedProject: {
        id: project.ID,
        name: project.NAME,
        module: project.MODULE_ID
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error(err); }
    }
  }
};

// Get project analytics
exports.getProjectAnalytics = async (req, res) => {
  let connection;

  try {
    connection = await oracledb.getConnection();

    const user = req.user;
    const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);
    const { applicationId } = req.query;

    /* ---------------------------------------------------------
       1️⃣ Build visibility WHERE clause
    --------------------------------------------------------- */

    let where = "";
    let finalBinds = {};

    if (user.role === "admin") {
      // TL → show analytics of his manager's modules
      where = `
        WHERE m.manager_id = (
          SELECT manager_id
          FROM employees
          WHERE id = :currentUserId
        )
      `;
      finalBinds.currentUserId = user.id;
    } else {
      // Normal hierarchy visibility
      where = `
        WHERE m.manager_id IN (
          SELECT e.id
          FROM employees e
          WHERE 1=1
          ${sqlCondition}
        )
      `;
      finalBinds = { ...binds };
    }

    /* ---------------------------------------------------------
       2️⃣ Optional Application Filter
    --------------------------------------------------------- */

    if (applicationId && applicationId !== "all") {
      where += ` AND m.application_id = :applicationId`;
      finalBinds.applicationId = Number(applicationId);
    }

    /* ---------------------------------------------------------
       3️⃣ Fetch Projects via Modules
    --------------------------------------------------------- */

    const query = `
      SELECT
        p.*,
        m.name AS module_name,
        m.application_id
      FROM projects p
      JOIN modules m ON p.module_id = m.id
      ${where}
    `;

    const result = await connection.execute(
      query,
      finalBinds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const projects = result.rows || [];

    /* ---------------------------------------------------------
       4️⃣ Analytics Computation
    --------------------------------------------------------- */

    const analytics = {
      overview: {
        total: projects.length,
        active: projects.filter(p =>
          !["Live", "Hold", "Dropped"].includes(p.PROJECT_STAGE)
        ).length,
        completed: projects.filter(p =>
          p.PROJECT_STAGE === "Live"
        ).length,
        delayed: projects.filter(p =>
          p.ON_TRACK_STATUS === "Delayed"
        ).length,
      },

      byModule: projects.reduce((acc, project) => {
        const moduleName = project.MODULE_NAME || "Unknown";
        acc[moduleName] = (acc[moduleName] || 0) + 1;
        return acc;
      }, {}),

      timeline: {
        thisMonth: projects.filter(p => {
          if (!p.START_DATE) return false;
          const start = new Date(p.START_DATE);
          const now = new Date();
          return (
            start.getMonth() === now.getMonth() &&
            start.getFullYear() === now.getFullYear()
          );
        }).length,

        nextMonth: projects.filter(p => {
          if (!p.PLANNED_END_DATE) return false;
          const end = new Date(p.PLANNED_END_DATE);
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);
          return (
            end.getMonth() === nextMonth.getMonth() &&
            end.getFullYear() === nextMonth.getFullYear()
          );
        }).length,
      },

      costs: {
        total: projects.reduce(
          (sum, p) => sum + (p.PROJECT_COST || 0),
          0
        ),

        average:
          projects.length > 0
            ? projects.reduce(
                (sum, p) => sum + (p.PROJECT_COST || 0),
                0
              ) / projects.length
            : 0,

        byPriority: projects.reduce((acc, project) => {
          const priority = project.PRIORITY || "Unknown";
          acc[priority] =
            (acc[priority] || 0) + (project.PROJECT_COST || 0);
          return acc;
        }, {}),
      },
    };

    res.json(analytics);

  } catch (err) {
    console.error("Failed to fetch project analytics:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); }
      catch (err) { console.error(err); }
    }
  }
};


const oracledb = require("oracledb");

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
      moduleId, name, description, startDate,
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

    // ------------------ Bind Variables ------------------
    const binds = {
      moduleId: moduleId || null,
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
        id, module_id, name, description, start_date, planned_end_date, manager_id,
        priority, project_stage, dependency_on, bsg_remarks, tech_fpr_tl,
        business_fpr_tl, bsg_fpr, platform, cr_numbers, roi, brs_filename,
        project_cost, sprint_start_date, sprint_end_date, man_days,
        on_track_status, remarks, team
      ) VALUES (
        projects_seq.NEXTVAL, :moduleId, :name, :description, :startDate, :plannedEndDate, :managerId,
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
        moduleId, name, description,
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


// Helper function to fetch projects with optional filters
async function fetchProjects(managerId, filters = {}, connection) {
  let query = `
    SELECT 
      p.*, 
      m.name AS module_name,
      e.name AS tech_tl_name
    FROM projects p
    LEFT JOIN modules m ON p.module_id = m.id
    LEFT JOIN employees e ON p.tech_fpr_tl = e.id
    WHERE p.manager_id = :managerId
  `;

  const bindParams = { managerId };

  // Dynamic filters
  if (filters.moduleId) {
    query += ` AND p.module_id = :moduleId`;
    bindParams.moduleId = filters.moduleId;
  }
  if (filters.priority) {
    query += ` AND p.priority = :priority`;
    bindParams.priority = filters.priority;
  }
  if (filters.projectStage) {
    query += ` AND p.project_stage = :projectStage`;
    bindParams.projectStage = filters.projectStage;
  }
  if (filters.onTrackStatus) {
    query += ` AND p.on_track_status = :onTrackStatus`;
    bindParams.onTrackStatus = filters.onTrackStatus;
  }
  if (filters.startDateFrom) {
    query += ` AND p.start_date >= TO_DATE(:startDateFrom, 'YYYY-MM-DD')`;
    bindParams.startDateFrom = filters.startDateFrom;
  }
  if (filters.startDateTo) {
    query += ` AND p.start_date <= TO_DATE(:startDateTo, 'YYYY-MM-DD')`;
    bindParams.startDateTo = filters.startDateTo;
  }

  query += ` ORDER BY p.created_at DESC`;

  const result = await connection.execute(query, bindParams, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
  return result.rows;
}


// ---------------------------
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
    const managerId = req.user.managerId || req.user.id;

    const filters = {
      moduleId: req.query.moduleId,
      priority: req.query.priority,
      projectStage: req.query.projectStage,
      onTrackStatus: req.query.onTrackStatus,
      startDateFrom: req.query.startDateFrom,
      startDateTo: req.query.startDateTo
    };

    let projects = await fetchProjects(managerId, filters, connection);

    // Map Oracle uppercase to camelCase
    projects = projects.map(toCamelCase);

    const updatedProjects = [];
    for (let project of projects) {
      const updates = updateTrackingStatus(project);
      if (Object.keys(updates).length > 0) {
        // Convert updates keys to uppercase for Oracle
        const oracleUpdates = {};
        for (let k in updates) {
          const upperKey = k.replace(/([A-Z])/g, "_$1").toUpperCase();
          oracleUpdates[upperKey] = updates[k];
        }

        const updateQuery = `
          UPDATE projects
          SET ${Object.keys(oracleUpdates).map(k => `${k} = :${k}`).join(", ")}
          WHERE ID = :projectId
        `;
        await connection.execute(updateQuery, { ...oracleUpdates, projectId: project.id }, { autoCommit: true });
        Object.assign(project, updates); // update local copy
      }
      updatedProjects.push(await formatProjectDates(project));
    }

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
    console.error(err);
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
    const managerId = req.user.managerId || req.user.id;

    const result = await connection.execute(
      `SELECT id, module_id, name 
       FROM projects 
       WHERE manager_id = :managerId 
       ORDER BY created_at DESC`,
      { managerId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    // Convert to camelCase
    const projects = result.rows.map(row => ({
      id: row.ID,
      moduleId: row.MODULE_ID,
      name: row.NAME
    }));

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
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

    const computeOnTrackStatus = (plannedEnd) => {
      if (!plannedEnd) return "On Track";
      const planned = new Date(plannedEnd);
      planned.setHours(0, 0, 0, 0);
      return today > planned ? "Delayed" : "On Track";
    };

    const parseClobJson = async (clob) => {
      if (!clob) return [];
      try {
        if (clob instanceof oracledb.Lob) {
          let data = "";
          clob.setEncoding("utf8");
          for await (const chunk of clob) data += chunk;
          return JSON.parse(data);
        }
        return JSON.parse(clob);
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
      start_date: req.body.startDate ? parseDate(req.body.startDate) : currentProject.START_DATE,
      planned_end_date: req.body.plannedEndDate
        ? parseDate(req.body.plannedEndDate)
        : currentProject.PLANNED_END_DATE,
      priority: req.body.priority ?? currentProject.PRIORITY,
      project_stage: req.body.projectStage ?? currentProject.PROJECT_STAGE,
      days: req.body.days ?? currentProject.DAYS,
      dependency_on: req.body.dependencyOn ?? currentProject.DEPENDENCY_ON,
      bsg_remarks: req.body.bsgRemarks ?? currentProject.BSG_REMARKS,
      tech_fpr_tl: req.body.techFprTl ?? currentProject.TECH_FPR_TL,
      business_fpr_tl: req.body.businessFprTl ?? currentProject.BUSINESS_FPR_TL,
      bsg_fpr: req.body.bsgFpr ?? currentProject.BSG_FPR,
      platform: req.body.platform ?? currentProject.PLATFORM,
      cr_numbers: req.body.crNumbers ?? currentProject.CR_NUMBERS,
      roi: req.body.roi ?? currentProject.ROI,
      brs_filename: req.body.brsFilename ?? currentProject.BRS_FILENAME,
      project_cost: req.body.projectCost ?? currentProject.PROJECT_COST,
      remarks: req.body.remarks ?? currentProject.REMARKS,
      discussion_delay_reason:
        req.body.discussionDelayReason ?? currentProject.DISCUSSION_DELAY_REASON,
      team: req.body.team ?? currentProject.TEAM,
    };

    // --------------------------------------------------
    // Auto compute on_track_status on EVERY edit
    // --------------------------------------------------
    allowedFields.on_track_status = computeOnTrackStatus(
      allowedFields.planned_end_date
    );

// --------------------------------------------------
// --------------------------------------------------
// PROJECT_CHANGES_RECEIVED (MERGE, NOT OVERWRITE)
// --------------------------------------------------

// 1️⃣ Read existing DB changes
let existingChanges = await parseClobJson(
  currentProject.PROJECT_CHANGES_RECEIVED
);

// 2️⃣ Read incoming changes from frontend
let incomingChanges = Array.isArray(req.body.projectChangesReceived)
  ? req.body.projectChangesReceived
  : [];

// 3️⃣ Normalize incoming entries
incomingChanges = incomingChanges.map((c) => ({
  date: c.date,
  stage: c.stage,
  details: c.details,
  updatedBy,
  timestamp: c.timestamp || new Date().toISOString(),
}));

// 4️⃣ Merge (append new → keep old)
const mergedChanges = [...existingChanges, ...incomingChanges];

// 5️⃣ Store
const finalProjectChangesReceived =
  mergedChanges.length > 0 ? JSON.stringify(mergedChanges) : null;

    // --------------------------------------------------
    // Compute change_log (system audit)
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
        ? new Date(oldNorm || 0).getTime() !== new Date(newNorm || 0).getTime()
        : oldNorm !== newNorm;

      if (different) {
        changes[key] = { old: oldNorm, new: newNorm };
      }
    }

    let changeLog = await parseClobJson(currentProject.CHANGE_LOG);
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
    const managerId = req.user.managerId || req.user.id;

    const result = await connection.execute(
      `SELECT p.*, m.name AS module_name
       FROM projects p
       LEFT JOIN modules m ON p.module_id = m.id
       WHERE p.manager_id = :managerId`,
      { managerId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const projects = result.rows || [];

    const analytics = {
      overview: {
        total: projects.length,
        active: projects.filter(p => !["Live", "Hold", "Dropped"].includes(p.PROJECT_STAGE)).length,
        completed: projects.filter(p => p.PROJECT_STAGE === "Live").length,
        delayed: projects.filter(p => p.ON_TRACK_STATUS === "Delayed").length,
      },
      byModule: projects.reduce((acc, project) => {
        const moduleName = project.MODULE_NAME || "Unknown";
        acc[moduleName] = (acc[moduleName] || 0) + 1;
        return acc;
      }, {}),
      timeline: {
        thisMonth: projects.filter(p => {
          const start = new Date(p.START_DATE);
          const now = new Date();
          return start.getMonth() === now.getMonth() && start.getFullYear() === now.getFullYear();
        }).length,
        nextMonth: projects.filter(p => {
          const end = new Date(p.PLANNED_END_DATE);
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);
          return end.getMonth() === nextMonth.getMonth() && end.getFullYear() === nextMonth.getFullYear();
        }).length,
      },
      costs: {
        total: projects.reduce((sum, p) => sum + (p.PROJECT_COST || 0), 0),
        average: projects.length > 0 ? projects.reduce((sum, p) => sum + (p.PROJECT_COST || 0), 0) / projects.length : 0,
        byPriority: projects.reduce((acc, project) => {
          const priority = project.PRIORITY || "Unknown";
          acc[priority] = (acc[priority] || 0) + (project.PROJECT_COST || 0);
          return acc;
        }, {}),
      }
    };

    res.json(analytics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error(err); }
    }
  }
};

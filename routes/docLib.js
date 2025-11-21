// const express = require("express");
// const router = express.Router();
// const oracledb = require("oracledb");
// const multer = require("multer");
// const fs = require("fs");
// const authMiddleware = require("../middleware/auth");

// // ---------------------------
// // Oracle helper
// // ---------------------------
// async function executeQuery(query, binds = {}, options = {}) {
//   let connection;
//   try {
//     connection = await oracledb.getConnection();
//     const result = await connection.execute(query, binds, { autoCommit: true, ...options });
//     return result;
//   } finally {
//     if (connection) await connection.close();
//   }
// }

// // ---------------------------
// // Multer setup
// // ---------------------------
// const upload = multer({ dest: "uploads/" });

// // ---------------------------
// // FETCH ALL DOCUMENTS (with category & subcategory)
// // ---------------------------
// router.get("/", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
//   try {
//     const result = await executeQuery(`
//       SELECT d.id, d.name, d.mime_type, d.uploaded_at, c.category_name, d.sub_category
//       FROM documents d
//       LEFT JOIN document_categories c ON d.category_id = c.id
//       ORDER BY d.uploaded_at DESC
//     `);

//     const docs = result.rows.map(row => ({
//       id: row[0],
//       name: row[1],
//       mimeType: row[2],
//       uploadedAt: row[3],
//       category: row[4] || "Uncategorized",
//       subCategory: row[5] || "",
//     }));

//     res.json(docs);
//   } catch (err) {
//     console.error("Failed to fetch documents:", err);
//     res.status(500).json({ error: "Failed to fetch documents" });
//   }
// });

// // ---------------------------
// // ---------------------------
// // FETCH ALL CATEGORIES (for dropdown)
// // ---------------------------
// router.get("/categories", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
//   try {
//     const result = await executeQuery(`
//       SELECT id, category_name 
//       FROM document_categories 
//       ORDER BY category_name
//     `);

//     const categories = result.rows.map(row => ({ id: row[0], name: row[1] }));
//     res.json(categories);
//   } catch (err) {
//     console.error("Failed to fetch categories:", err);
//     res.status(500).json({ error: "Failed to fetch categories" });
//   }
// });

// // ---------------------------
// // ADD NEW CATEGORY
// // ---------------------------
// router.post("/categories", authMiddleware(["manager"]), async (req, res) => {
//   try {
//     const { category_name } = req.body;
//     if (!category_name) return res.status(400).json({ error: "Category name required" });

//     await executeQuery(
//       `INSERT INTO document_categories (category_name) VALUES (:name)`,
//       { name: category_name }
//     );

//     res.json({ message: "Category added successfully" });
//   } catch (err) {
//     console.error("Failed to add category:", err);
//     res.status(500).json({ error: "Failed to add category" });
//   }
// });

// // ---------------------------
// // UPDATE CATEGORY
// // ---------------------------
// router.put("/categories/:id", authMiddleware(["manager"]), async (req, res) => {
//   try {
//     const categoryId = req.params.id;
//     console.log(req.body)
//     const { name } = req.body;

//     if (!name) return res.status(400).json({ error: "Category name required" });

//     await executeQuery(
//       `UPDATE document_categories SET category_name = :name WHERE id = :id`,
//       { name: name, id: categoryId }
//     );

//     res.json({ message: "Category updated successfully" });
//   } catch (err) {
//     console.error("Failed to update category:", err);
//     res.status(500).json({ error: "Failed to update category" });
//   }
// });

// // ---------------------------
// // DELETE CATEGORY
// // ---------------------------
// router.delete("/categories/:id", authMiddleware(["manager"]), async (req, res) => {
//   try {
//     const categoryId = req.params.id;

//     // Optional: Check if any document is assigned to this category before deleting
//     const check = await executeQuery(
//       `SELECT COUNT(*) FROM documents WHERE category_id = :id`,
//       { id: categoryId }
//     );
//     if (check.rows[0][0] > 0) {
//       return res.status(400).json({ error: "Cannot delete category with assigned documents" });
//     }

//     await executeQuery(
//       `DELETE FROM document_categories WHERE id = :id`,
//       { id: categoryId }
//     );

//     res.json({ message: "Category deleted successfully" });
//   } catch (err) {
//     console.error("Failed to delete category:", err);
//     res.status(500).json({ error: "Failed to delete category" });
//   }
// });


// // ---------------------------
// // UPLOAD DOCUMENT (category dropdown + free subcategory)
// // ---------------------------
// router.post("/", authMiddleware(["admin", "manager"]), upload.single("file"), async (req, res) => {
//   try {
//     if (!req.file) return res.status(400).json({ error: "File is required" });

//     const { category_id, sub_category } = req.body;
//     const { originalname, mimetype, path } = req.file;
//     const fileData = fs.readFileSync(path);

//     const result = await executeQuery(
//       `INSERT INTO documents (name, mime_type, category_id, sub_category, file_data)
//        VALUES (:name, :mime, :cat, :subcat, :data)
//        RETURNING id INTO :outId`,
//       {
//         name: originalname,
//         mime: mimetype,
//         cat: category_id ? Number(category_id) : null,
//         subcat: sub_category || null,
//         data: fileData,
//         outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
//       }
//     );

//     fs.unlinkSync(path);
//     res.json({ id: result.outBinds.outId, name: originalname });
//   } catch (err) {
//     console.error("Failed to upload document:", err);
//     res.status(500).json({ error: "Failed to upload document" });
//   }
// });

// // ---------------------------
// // VIEW / PREVIEW DOCUMENT BY ID
// // ---------------------------
// router.get("/view/:id", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
//   let connection;
//   try {
//     const { id } = req.params;
//     connection = await oracledb.getConnection();

//     const result = await connection.execute(
//       `SELECT name, mime_type, file_data FROM documents WHERE id = :id`,
//       { id: Number(id) },
//       { outFormat: oracledb.OUT_FORMAT_OBJECT }
//     );

//     if (!result.rows || result.rows.length === 0)
//       return res.status(404).json({ error: "Document not found" });

//     const { NAME: name, MIME_TYPE: mimeType, FILE_DATA: lob } = result.rows[0];

//     if (!lob) return res.status(404).json({ error: "No file data" });

//     res.setHeader("Content-Type", mimeType);
//     res.setHeader("Content-Disposition", `inline; filename="${name}"`);

//     lob.on("error", (err) => {
//       console.error("Error streaming LOB:", err);
//       res.status(500).end("Error reading file");
//     });

//     lob.on("end", () => res.end());
//     lob.pipe(res);

//   } catch (err) {
//     console.error("Failed to view document:", err);
//     res.status(500).json({ error: "Failed to view document" });
//   } finally {
//     if (connection) await connection.close();
//   }
// });

// // ---------------------------
// // DELETE DOCUMENT BY ID
// // ---------------------------
// router.delete("/:id", authMiddleware(["admin", "manager"]), async (req, res) => {
//   try {
//     const { id } = req.params;

//     const result = await executeQuery(
//       `DELETE FROM documents WHERE id = :id RETURNING id INTO :outId`,
//       {
//         id: Number(id),
//         outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
//       }
//     );

//     if (!result.outBinds || !result.outBinds.outId)
//       return res.status(404).json({ error: "Document not found" });

//     res.json({ message: "Document deleted successfully" });
//   } catch (err) {
//     console.log(err)
//     console.error("Failed to delete document:", err);
//     res.status(500).json({ error: "Failed to delete document" });
//   }
// });

// module.exports = router;


const express = require("express");
const router = express.Router();
const oracledb = require("oracledb");
const multer = require("multer");
const fs = require("fs");
const authMiddleware = require("../middleware/auth");

// ---------------------------
// Helper: Execute Oracle queries safely
// ---------------------------
async function executeQuery(query, params = {}) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(query, params, { autoCommit: true });
    return result;
  } finally {
    if (connection) await connection.close();
  }
}

// ---------------------------
// Multer: Store file temporarily
// ---------------------------
const upload = multer({ dest: "uploads/" });

// ======================================================
// 1️⃣ Upload Document (Only Manager / Admin)
// ======================================================
router.post("/", authMiddleware(["admin", "manager"]), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File is required" });

    const { category_id, sub_category } = req.body;
    const { originalname, mimetype, path } = req.file;
    const fileData = fs.readFileSync(path);

    const result = await executeQuery(
      `INSERT INTO documents (name, mime_type, category_id, sub_category, file_data, uploaded_by)
       VALUES (:name, :mime, :cat, :subcat, :data, :uploaded_by)
       RETURNING id INTO :outId`,
      {
        name: originalname,
        mime: mimetype,
        cat: category_id ? Number(category_id) : null,
        subcat: sub_category || null,
        data: fileData,
        uploaded_by: req.user.id,
        outId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    fs.unlinkSync(path);
    res.json({ id: result.outBinds.outId, name: originalname });
  } catch (err) {
    console.error("❌ Upload document failed:", err);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

// ======================================================
// 2️⃣ Fetch Documents (Role-based Access)
// ======================================================
router.get("/", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();
    let query = `
      SELECT d.id, d.name, d.mime_type, d.uploaded_at, c.category_name, d.sub_category, d.uploaded_by
      FROM documents d
      LEFT JOIN document_categories c ON d.category_id = c.id
    `;
    const binds = {};

    // --- Role based conditions ---
    if (req.user.role === "employee") {
      const mgrRes = await connection.execute(
        `SELECT manager_id FROM employees WHERE id = :empId`,
        { empId: req.user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!mgrRes.rows.length)
        return res.status(403).json({ error: "Employee record not found" });

      const managerId = mgrRes.rows[0].MANAGER_ID;
      query += ` WHERE d.uploaded_by = :managerId`;
      binds.managerId = managerId;
    } else if (req.user.role === "manager") {
      query += ` WHERE d.uploaded_by = :managerId`;
      binds.managerId = req.user.id;
    } else {
      query += ` WHERE 1=1`; // admin sees all
    }

    query += ` ORDER BY d.uploaded_at DESC`;

    const result = await connection.execute(query, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    const docs = result.rows.map((row) => ({
      id: row.ID,
      name: row.NAME,
      mimeType: row.MIME_TYPE,
      uploadedAt: row.UPLOADED_AT,
      category: row.CATEGORY_NAME || "Uncategorized",
      subCategory: row.SUB_CATEGORY || "",
    }));

    res.json(docs);
  } catch (err) {
    console.error("❌ Fetch documents failed:", err);
    res.status(500).json({ error: "Failed to fetch documents" });
  } finally {
    if (connection) await connection.close();
  }
});

// ======================================================
// 3️⃣ View Document (Access Restriction Applied)
// ======================================================
router.get("/view/:id", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const docId = Number(req.params.id);

    // Fetch document
    const docRes = await connection.execute(
      `SELECT id, name, mime_type, file_data, uploaded_by 
       FROM documents WHERE id = :id`,
      { id: docId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!docRes.rows.length)
      return res.status(404).json({ error: "Document not found" });

    const { NAME: name, MIME_TYPE: mimeType, FILE_DATA: lob, UPLOADED_BY: uploadedBy } = docRes.rows[0];

    if (!lob)
      return res.status(404).json({ error: "No file data" });

    // -------------------------------
    // 🔐 Role-based access check
    // -------------------------------
    if (req.user.role === "employee") {
      const mgrRes = await connection.execute(
        `SELECT manager_id FROM employees WHERE id = :empId`,
        { empId: req.user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const managerId = mgrRes.rows[0]?.MANAGER_ID;
      if (uploadedBy !== managerId)
        return res.status(403).json({ error: "Access denied — not your manager's document" });
    } else if (req.user.role === "manager") {
      if (uploadedBy !== req.user.id)
        return res.status(403).json({ error: "Access denied — you didn’t upload this document" });
    }

    // -------------------------------
    // 📄 Stream the file (BLOB)
    // -------------------------------
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);

    lob.on("error", (err) => {
      console.error("Error streaming LOB:", err);
      res.status(500).end("Error reading file");
    });

    lob.on("end", () => res.end());
    lob.pipe(res);

  } catch (err) {
    console.error("❌ View document failed:", err);
    res.status(500).json({ error: "Failed to view document" });
  } finally {
    if (connection) await connection.close();
  }
});


// ======================================================
// 4️⃣ Delete Document (Only Manager / Admin)
// ======================================================
router.delete("/:id", authMiddleware(["admin", "manager"]), async (req, res) => {
  try {
    const docId = Number(req.params.id);
    const docRes = await executeQuery(
      `SELECT uploaded_by FROM documents WHERE id = :id`,
      { id: docId }
    );

    if (!docRes.rows.length)
      return res.status(404).json({ error: "Document not found" });

    const uploadedBy = docRes.rows[0][0];

    if (req.user.role === "manager" && uploadedBy !== req.user.id) {
      return res.status(403).json({ error: "You can only delete your own uploaded documents" });
    }

    await executeQuery(`DELETE FROM documents WHERE id = :id`, { id: docId });
    res.json({ success: true, message: "Document deleted successfully" });
  } catch (err) {
    console.error("❌ Delete document failed:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// ======================================================
// 5️⃣ CATEGORY ROUTES
// ======================================================

// ---------------------------
// FETCH ALL CATEGORIES
// ---------------------------
router.get("/categories", authMiddleware(["admin", "manager", "employee"]), async (req, res) => {
  try {
    const result = await executeQuery(`
      SELECT id, category_name 
      FROM document_categories 
      ORDER BY category_name
    `);

    const categories = result.rows.map(row => ({ id: row[0], name: row[1] }));
    res.json(categories);
  } catch (err) {
    console.error("Failed to fetch categories:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// ---------------------------
// ADD NEW CATEGORY
// ---------------------------
router.post("/categories", authMiddleware(["manager"]), async (req, res) => {
  try {
    const { category_name } = req.body;
    if (!category_name) return res.status(400).json({ error: "Category name required" });

    await executeQuery(
      `INSERT INTO document_categories (category_name) VALUES (:name)`,
      { name: category_name }
    );

    res.json({ message: "Category added successfully" });
  } catch (err) {
    console.error("Failed to add category:", err);
    res.status(500).json({ error: "Failed to add category" });
  }
});

// ---------------------------
// UPDATE CATEGORY
// ---------------------------
router.put("/categories/:id", authMiddleware(["manager"]), async (req, res) => {
  try {
    const categoryId = req.params.id;
    const { name } = req.body;

    if (!name) return res.status(400).json({ error: "Category name required" });

    await executeQuery(
      `UPDATE document_categories SET category_name = :name WHERE id = :id`,
      { name: name, id: categoryId }
    );

    res.json({ message: "Category updated successfully" });
  } catch (err) {
    console.error("Failed to update category:", err);
    res.status(500).json({ error: "Failed to update category" });
  }
});

// ---------------------------
// DELETE CATEGORY
// ---------------------------
router.delete("/categories/:id", authMiddleware(["manager"]), async (req, res) => {
  try {
    const categoryId = req.params.id;

    // Optional: Check if any document is assigned to this category before deleting
    const check = await executeQuery(
      `SELECT COUNT(*) FROM documents WHERE category_id = :id`,
      { id: categoryId }
    );
    if (check.rows[0][0] > 0) {
      return res.status(400).json({ error: "Cannot delete category with assigned documents" });
    }

    await executeQuery(
      `DELETE FROM document_categories WHERE id = :id`,
      { id: categoryId }
    );

    res.json({ message: "Category deleted successfully" });
  } catch (err) {
    console.error("Failed to delete category:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

module.exports = router;

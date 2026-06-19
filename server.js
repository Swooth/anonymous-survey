const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const initSqlJs = require("sql.js");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "survey.db");
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");

let db;

async function initDB() {
  const SQL = await initSqlJs();
  let buffer = null;
  if (fs.existsSync(DB_PATH)) {
    buffer = fs.readFileSync(DB_PATH);
  }
  db = new SQL.Database(buffer);

  db.run("CREATE TABLE IF NOT EXISTS surveys (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), status TEXT DEFAULT 'active')");
  db.run("CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, options TEXT DEFAULT '[]', required INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)");
  db.run("CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, submit_time TEXT DEFAULT (datetime('now','localtime')), ip_hash TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, response_id TEXT NOT NULL, question_id TEXT NOT NULL, value TEXT, image_path TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)");
  saveDB();

  const rows = db.exec("SELECT id FROM admins WHERE username='admin' LIMIT 1");
  if (!rows.length || !rows[0].values.length) {
    db.run("INSERT INTO admins (id, username, password) VALUES (?, 'admin', 'admin123')", [uuidv4()]);
    saveDB();
  }
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function runSQL(sql, params) {
  if (params) db.run(sql, params);
  else db.run(sql);
  saveDB();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ----- API ???????????? -----

app.get("/api/surveys", (req, res) => {
  const surveys = queryAll("SELECT id, title, description, created_at FROM surveys WHERE status='active' ORDER BY created_at DESC");
  res.json(surveys);
});

app.get("/api/survey/:id", (req, res) => {
  const survey = queryOne("SELECT * FROM surveys WHERE id=?", [req.params.id]);
  if (!survey) return res.status(404).json({ error: "?????" });
  const questions = queryAll("SELECT * FROM questions WHERE survey_id=? ORDER BY sort_order", [req.params.id]);
  questions.forEach(q => q.options = JSON.parse(q.options || "[]"));
  res.json({ survey, questions });
});

app.post("/api/survey/:id/submit", upload.array("images"), (req, res) => {
  const surveyId = req.params.id;
  const survey = queryOne("SELECT id FROM surveys WHERE id=? AND status='active'", [surveyId]);
  if (!survey) return res.status(404).json({ error: "?????????" });

  let answers;
  try {
    answers = typeof req.body.answers === "string" ? JSON.parse(req.body.answers) : req.body.answers;
  } catch(e) {
    return res.status(400).json({ error: "??????" });
  }
  if (!answers || !Array.isArray(answers)) return res.status(400).json({ error: "??????" });

  const ipHash = uuidv4().slice(0, 8);
  const responseId = uuidv4();
  runSQL("INSERT INTO responses (id, survey_id, ip_hash) VALUES (?, ?, ?)", [responseId, surveyId, ipHash]);

  let imgIdx = 0;
  for (const ans of answers) {
    let imagePath = null;
    if (ans.type === "image" && req.files && req.files[imgIdx]) {
      imagePath = "/uploads/" + req.files[imgIdx].filename;
      imgIdx++;
    }
    runSQL("INSERT INTO answers (id, response_id, question_id, value, image_path) VALUES (?, ?, ?, ?, ?)",
      [uuidv4(), responseId, ans.questionId, ans.value || "", imagePath]);
  }

  res.json({ success: true, responseId });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const admin = queryOne("SELECT * FROM admins WHERE username=? AND password=?", [username, password]);
  if (!admin) return res.status(401).json({ error: "????????" });
  res.json({ success: true, token: "admin-token-" + admin.id });
});

app.get("/api/admin/surveys", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const surveys = queryAll("SELECT * FROM surveys ORDER BY created_at DESC");
  surveys.forEach(s => {
    const cnt = queryOne("SELECT COUNT(*) as cnt FROM responses WHERE survey_id=?", [s.id]);
    s.response_count = cnt ? cnt.cnt : 0;
  });
  res.json(surveys);
});

app.get("/api/admin/survey/:id/stats", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const surveyId = req.params.id;
  const survey = queryOne("SELECT * FROM surveys WHERE id=?", [surveyId]);
  if (!survey) return res.status(404).json({ error: "?????" });

  const questions = queryAll("SELECT * FROM questions WHERE survey_id=? ORDER BY sort_order", [surveyId]);
  const totalResponses = queryOne("SELECT COUNT(*) as cnt FROM responses WHERE survey_id=?", [surveyId]);

  const stats = questions.map(q => {
    q.options = JSON.parse(q.options || "[]");
    const answers = queryAll("SELECT a.* FROM answers a JOIN responses r ON a.response_id=r.id WHERE a.question_id=? AND r.survey_id=?", [q.id, surveyId]);

    let result = { question: q, total: answers.length, details: [] };

    if (q.type === "radio" || q.type === "checkbox" || q.type === "double_select") {
      const countMap = {};
      answers.forEach(a => {
        const vals = a.value ? a.value.split(",") : [];
        vals.forEach(v => { countMap[v] = (countMap[v] || 0) + 1; });
      });
      result.details = Object.entries(countMap).map(([key, count]) => ({ key, count }));
    } else if (q.type === "text") {
      result.details = answers.map(a => ({ value: a.value }));
    } else if (q.type === "image") {
      result.details = answers.map(a => ({ image_path: a.image_path }));
    }

    return result;
  });

  res.json({ survey, stats, total_responses: totalResponses ? totalResponses.cnt : 0 });
});

app.post("/api/admin/survey/save", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const { id, title, description, questions } = req.body;
  const surveyId = id || uuidv4();

  const existing = queryOne("SELECT id FROM surveys WHERE id=?", [surveyId]);
  if (existing) {
    runSQL("UPDATE surveys SET title=?, description=? WHERE id=?", [title, description || "", surveyId]);
  } else {
    runSQL("INSERT INTO surveys (id, title, description) VALUES (?, ?, ?)", [surveyId, title, description || ""]);
  }

  const oldQs = queryAll("SELECT id FROM questions WHERE survey_id=?", [surveyId]);
  oldQs.forEach(q => {
    runSQL("DELETE FROM answers WHERE question_id=?", [q.id]);
    runSQL("DELETE FROM questions WHERE id=?", [q.id]);
  });

  if (questions && Array.isArray(questions)) {
    questions.forEach((q, idx) => {
      runSQL("INSERT INTO questions (id, survey_id, type, title, options, required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), surveyId, q.type, q.title, JSON.stringify(q.options || []), q.required ? 1 : 0, idx]);
    });
  }

  res.json({ success: true, surveyId });
});

app.post("/api/admin/survey/:id/toggle", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const survey = queryOne("SELECT * FROM surveys WHERE id=?", [req.params.id]);
  if (!survey) return res.status(404).json({ error: "?????" });
  const newStatus = survey.status === "active" ? "closed" : "active";
  runSQL("UPDATE surveys SET status=? WHERE id=?", [newStatus, req.params.id]);
  res.json({ success: true, status: newStatus });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ----- ??????? API ????? -----
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

// ??? API ????? index.html????????
app.get("*", (req, res) => {
  const filePath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log("  ?? ???????????");
    console.log("==================================");
    console.log("  ?? ??: " + PORT);
    console.log("  ?? ????: admin / admin123");
    console.log("==================================");
  });
});

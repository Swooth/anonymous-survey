const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const initSqlJs = require("sql.js");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "web", "uploads");

let db;
const DB_PATH = path.join(__dirname, "survey.db");

let memoryDB = {
  surveys: [],
  questions: [],
  responses: [],
  answers: [],
  admins: [{ id: uuidv4(), username: "admin", password: "admin123" }]
};
let useMemoryFallback = false;

function genId() { return uuidv4(); }
function now() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

async function initDB() {
  try {
    const SQL = await initSqlJs();
    let buffer = null;
    if (fs.existsSync(DB_PATH)) { buffer = fs.readFileSync(DB_PATH); }
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
    console.log("SQLite ????????");
    return true;
  } catch(e) {
    console.error("SQLite ????????????:", e.message);
    useMemoryFallback = true;
    return false;
  }
}

function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error("???????:", e.message); }
}

function queryAll(sql, params) {
  if (useMemoryFallback) return memQueryAll(sql, params);
  try {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch(e) { console.error("queryAll error:", e.message); return []; }
}

function queryOne(sql, params) {
  if (useMemoryFallback) return memQueryOne(sql, params);
  try {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    let result = null;
    if (stmt.step()) result = stmt.getAsObject();
    stmt.free();
    return result;
  } catch(e) { console.error("queryOne error:", e.message); return null; }
}

function runSQL(sql, params) {
  if (useMemoryFallback) return memRunSQL(sql, params);
  try {
    if (params) db.run(sql, params); else db.run(sql);
    saveDB();
  } catch(e) { console.error("runSQL error:", e.message); }
}

function memQueryAll(sql, params) {
  const tbl = (sql.match(/FROM\s+(\w+)/i) || [])[1];
  if (!tbl || !memoryDB[tbl]) return [];
  let data = [...memoryDB[tbl]];
  if (sql.includes("WHERE") && params && params.length) {
    const whereClause = sql.split("WHERE")[1];
    if (whereClause.includes("survey_id=?") && sql.includes("status='active'"))
      data = data.filter(d => d.survey_id === params[0] && d.status === 'active');
    else if (whereClause.includes("id=?") && whereClause.includes("status='active'"))
      data = data.filter(d => d.id === params[0] && d.status === 'active');
    else if (whereClause.includes("survey_id=?"))
      data = data.filter(d => d.survey_id === params[0]);
    else if (whereClause.includes("question_id=?"))
      data = data.filter(d => d.question_id === params[0]);
    else if (whereClause.includes("username=?") && whereClause.includes("password=?"))
      data = data.filter(d => d.username === params[0] && d.password === params[1]);
    else if (whereClause.includes("id=?"))
      data = data.filter(d => d.id === params[0]);
  }
  if (sql.includes("ORDER BY")) {
    if (sql.includes("created_at DESC")) data.sort((a,b) => (b.created_at||"").localeCompare(a.created_at||""));
    if (sql.includes("sort_order")) data.sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  }
  return data;
}

function memQueryOne(sql, params) {
  const results = memQueryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function memRunSQL(sql, params) {
  const tblMatch = sql.match(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i);
  if (!tblMatch) return;
  const action = tblMatch[1].toUpperCase();
  const tbl = tblMatch[2];
  if (!memoryDB[tbl]) memoryDB[tbl] = [];
  if (action.startsWith("INSERT")) {
    const colsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (colsMatch && params) {
      const cols = colsMatch[1].split(",").map(c => c.trim().replace(/['"]/g,""));
      const obj = { id: params[0] };
      cols.forEach((c, i) => { if (params[i] !== undefined) obj[c] = params[i]; });
      memoryDB[tbl].push(obj);
    }
  } else if (action === "UPDATE") {
    if (params) {
      const id = params[params.length-1];
      const item = memoryDB[tbl].find(d => d.id === id);
      if (item) {
        const sets = sql.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
        if (sets) {
          const parts = sets[1].split(",");
          parts.forEach((p, i) => {
            const [k] = p.split("=").map(s => s.trim().replace(/['"]/g,""));
            if (params[i] !== undefined) item[k] = params[i];
          });
        }
      }
    }
  } else if (action.startsWith("DELETE")) {
    const idMatch = sql.match(/WHERE\s+(\w+)=\?/);
    if (idMatch && params) {
      memoryDB[tbl] = memoryDB[tbl].filter(d => d[idMatch[1]] !== params[0]);
    }
  }
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
  storage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// API ??
app.get("/_api/surveys", (req, res) => {
  const surveys = queryAll("SELECT id, title, description, created_at FROM surveys WHERE status='active' ORDER BY created_at DESC");
  res.json(surveys);
});

app.get("/_api/survey/:id", (req, res) => {
  const survey = queryOne("SELECT * FROM surveys WHERE id=?", [req.params.id]);
  if (!survey) return res.status(404).json({ error: "?????" });
  const questions = queryAll("SELECT * FROM questions WHERE survey_id=? ORDER BY sort_order", [req.params.id]);
  questions.forEach(q => q.options = JSON.parse(q.options || "[]"));
  res.json({ survey, questions });
});

app.post("/_api/survey/:id/submit", upload.array("images"), (req, res) => {
  const surveyId = req.params.id;
  const survey = queryOne("SELECT id FROM surveys WHERE id=? AND status='active'", [surveyId]);
  if (!survey) return res.status(404).json({ error: "?????????" });
  let answers;
  try { answers = typeof req.body.answers === "string" ? JSON.parse(req.body.answers) : req.body.answers; }
  catch(e) { return res.status(400).json({ error: "??????" }); }
  if (!answers || !Array.isArray(answers)) return res.status(400).json({ error: "??????" });
  const ipHash = uuidv4().slice(0, 8);
  const responseId = uuidv4();
  runSQL("INSERT INTO responses (id, survey_id, ip_hash) VALUES (?, ?, ?)", [responseId, surveyId, ipHash]);
  let imgIdx = 0;
  for (const ans of answers) {
    let imagePath = null;
    if (ans.type === "image" && req.files && req.files[imgIdx]) { imagePath = "/uploads/" + req.files[imgIdx].filename; imgIdx++; }
    runSQL("INSERT INTO answers (id, response_id, question_id, value, image_path) VALUES (?, ?, ?, ?, ?)", [uuidv4(), responseId, ans.questionId, ans.value || "", imagePath]);
  }
  res.json({ success: true, responseId });
});

app.post("/_api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const admin = queryOne("SELECT * FROM admins WHERE username=? AND password=?", [username, password]);
  if (!admin) return res.status(401).json({ error: "????????" });
  res.json({ success: true, token: "admin-token-" + admin.id });
});

app.get("/_api/admin/surveys", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const surveys = queryAll("SELECT * FROM surveys ORDER BY created_at DESC");
  surveys.forEach(s => {
    const cnt = queryOne("SELECT COUNT(*) as cnt FROM responses WHERE survey_id=?", [s.id]);
    s.response_count = cnt ? cnt.cnt : 0;
  });
  res.json(surveys);
});

app.get("/_api/admin/survey/:id/stats", (req, res) => {
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
      answers.forEach(a => { (a.value||"").split(",").filter(Boolean).forEach(v => { countMap[v] = (countMap[v] || 0) + 1; }); });
      result.details = Object.entries(countMap).map(([key, count]) => ({ key, count }));
    } else if (q.type === "text") { result.details = answers.map(a => ({ value: a.value })); }
    else if (q.type === "image") { result.details = answers.map(a => ({ image_path: a.image_path })); }
    return result;
  });
  res.json({ survey, stats, total_responses: totalResponses ? totalResponses.cnt : 0 });
});

app.post("/_api/admin/survey/save", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const { id, title, description, questions } = req.body;
  const surveyId = id || uuidv4();
  const existing = queryOne("SELECT id FROM surveys WHERE id=?", [surveyId]);
  if (existing) runSQL("UPDATE surveys SET title=?, description=? WHERE id=?", [title, description || "", surveyId]);
  else runSQL("INSERT INTO surveys (id, title, description) VALUES (?, ?, ?)", [surveyId, title, description || ""]);
  const oldQs = queryAll("SELECT id FROM questions WHERE survey_id=?", [surveyId]);
  oldQs.forEach(q => { runSQL("DELETE FROM answers WHERE question_id=?", [q.id]); runSQL("DELETE FROM questions WHERE id=?", [q.id]); });
  if (questions && Array.isArray(questions)) {
    questions.forEach((q, idx) => { runSQL("INSERT INTO questions (id, survey_id, type, title, options, required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)", [uuidv4(), surveyId, q.type, q.title, JSON.stringify(q.options || []), q.required ? 1 : 0, idx]); });
  }
  res.json({ success: true, surveyId });
});

app.post("/_api/admin/survey/:id/toggle", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const survey = queryOne("SELECT * FROM surveys WHERE id=?", [req.params.id]);
  if (!survey) return res.status(404).json({ error: "?????" });
  const newStatus = survey.status === "active" ? "closed" : "active";
  runSQL("UPDATE surveys SET status=? WHERE id=?", [newStatus, req.params.id]);
  res.json({ success: true, status: newStatus });
});

app.get("/health", (req, res) => res.json({ status: "ok", mode: useMemoryFallback ? "memory" : "sqlite" }));

// ----- ???????????-----
const FRONTEND_INDEX = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf-8");
const FRONTEND_ADMIN = fs.readFileSync(path.join(__dirname, "web", "admin.html"), "utf-8");

app.get("/", (req, res) => res.type("html").send(FRONTEND_INDEX));
app.get("/index.html", (req, res) => res.type("html").send(FRONTEND_INDEX));
app.get("/admin.html", (req, res) => res.type("html").send(FRONTEND_ADMIN));
app.get("/index.html", (req, res) => res.type("html").send(FRONTEND_INDEX));
app.get("/admin.html", (req, res) => res.type("html").send(FRONTEND_ADMIN));
app.get("/uploads/*", (req, res) => res.sendFile(path.join(UPLOAD_DIR, req.params[0])));


// ????
app.use("/uploads", express.static(UPLOAD_DIR));

// SPA fallback - serve inline HTML
app.get("*", (req, res) => {
  res.type("html").send(FRONTEND_INDEX);
});

initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log("  ?? ???????????");
    console.log("==================================");
    console.log("  ?? ??: " + PORT);
    console.log("  ?? ??: " + (useMemoryFallback ? "????" : "SQLite"));
    console.log("  ?? ????: admin / admin123");
    console.log("==================================");
  });
});

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
      answers.forEach(a => { (a.value||"").split(",").filter(Boolean).forEach(v => { countMap[v] = (countMap[v] || 0) + 1; }); });
      result.details = Object.entries(countMap).map(([key, count]) => ({ key, count }));
    } else if (q.type === "text") { result.details = answers.map(a => ({ value: a.value })); }
    else if (q.type === "image") { result.details = answers.map(a => ({ image_path: a.image_path })); }
    return result;
  });
  res.json({ survey, stats, total_responses: totalResponses ? totalResponses.cnt : 0 });
});

app.post("/api/admin/survey/save", (req, res) => {
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

app.post("/api/admin/survey/:id/toggle", (req, res) => {
  if (!req.headers.authorization) return res.status(401).json({ error: "???" });
  const survey = queryOne("SELECT * FROM surveys WHERE id=?", [req.params.id]);
  if (!survey) return res.status(404).json({ error: "?????" });
  const newStatus = survey.status === "active" ? "closed" : "active";
  runSQL("UPDATE surveys SET status=? WHERE id=?", [newStatus, req.params.id]);
  res.json({ success: true, status: newStatus });
});

app.get("/health", (req, res) => res.json({ status: "ok", mode: useMemoryFallback ? "memory" : "sqlite" }));

// ----- ?????? -----
const FRONTEND_INDEX = String.raw`﻿<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>匿名问卷调查</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f5f7fa; color: #333; min-height: 100vh; padding: 16px; }
    .container { max-width: 600px; margin: 0 auto; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .desc { color: #666; font-size: 14px; margin-bottom: 12px; }
    .survey-list { list-style: none; }
    .survey-item { display: block; padding: 16px; background: #fff; border-radius: 12px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); cursor: pointer; transition: transform 0.1s; text-decoration: none; color: inherit; }
    .survey-item:active { transform: scale(0.98); }
    .survey-item h3 { font-size: 17px; font-weight: 600; margin-bottom: 4px; }
    .survey-item .date { font-size: 12px; color: #999; }
    .empty { text-align: center; padding: 40px 0; color: #999; }
    .empty .icon { font-size: 48px; margin-bottom: 12px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 24px; background: #4a90d9; color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%; transition: background 0.2s; }
    .btn:active { background: #357abd; }
    .btn-secondary { background: #e8ecf1; color: #333; }
    .btn-secondary:active { background: #d5dae0; }
    .btn-success { background: #34c759; }
    .btn-success:active { background: #2db84e; }
    .btn-danger { background: #ff3b30; }
    .btn-danger:active { background: #e0352b; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .question-block { margin-bottom: 24px; }
    .question-block:last-child { margin-bottom: 0; }
    .q-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: flex-start; }
    .q-required { color: #ff3b30; margin-left: 4px; font-size: 14px; }
    .option-item { display: flex; align-items: center; padding: 10px 12px; margin-bottom: 6px; border: 2px solid #e8ecf1; border-radius: 8px; transition: all 0.15s; }
    .option-item.selected { border-color: #4a90d9; background: #f0f6ff; }
    .option-item input[type='radio'], .option-item input[type='checkbox'] { margin-right: 10px; width: 20px; height: 20px; accent-color: #4a90d9; flex-shrink: 0; }
    .option-item label { flex: 1; font-size: 15px; cursor: pointer; }
    .text-input { width: 100%; padding: 12px; border: 2px solid #e8ecf1; border-radius: 8px; font-size: 15px; outline: none; transition: border 0.2s; font-family: inherit; }
    .text-input:focus { border-color: #4a90d9; }
    textarea.text-input { min-height: 100px; resize: vertical; }
    .image-upload-area { border: 2px dashed #ccc; border-radius: 8px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s; background: #fafafa; }
    .image-upload-area:active { background: #f0f0f0; }
    .image-upload-area.has-image { border-color: #34c759; background: #f0faf0; }
    .image-upload-area input { display: none; }
    .image-upload-area .upload-icon { font-size: 36px; margin-bottom: 8px; }
    .image-upload-area .upload-text { font-size: 14px; color: #666; }
    .image-preview { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 8px; }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 14px; z-index: 999; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    .toast.show { opacity: 1; }
    .loading { text-align: center; padding: 20px; color: #999; }
    .loading::after { content: '...'; animation: dots 1.2s steps(3, end) infinite; }
    @keyframes dots { 0%, 20% { content: '.'; } 40% { content: '..'; } 60%, 100% { content: '...'; } }
    .nav-bar { display: flex; gap: 8px; margin-bottom: 16px; }
    .nav-bar .btn { flex: 1; }
    .success-page { text-align: center; padding: 40px 0; }
    .success-page .check { font-size: 64px; color: #34c759; margin-bottom: 16px; }
    .success-page h2 { font-size: 20px; margin-bottom: 8px; }
    .success-page p { color: #666; margin-bottom: 24px; }
    .hidden { display: none; }
    .error-msg { color: #ff3b30; font-size: 13px; margin-top: 4px; }
    .double-select-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .double-select-row select { flex: 1; padding: 10px; border: 2px solid #e8ecf1; border-radius: 8px; font-size: 14px; background: #fff; outline: none; }
    .double-select-row select:focus { border-color: #4a90d9; }
  </style>
</head>
<body>
  <div class="container" id="app">
    <div id="page-home">
      <div class="card" style="text-align:center;">
        <h1>📋 匿名问卷调查</h1>
        <p class="desc">无需登录，完全匿名，放心填写</p>
      </div>
      <div id="surveyList"></div>
    </div>

    <div id="page-survey" class="hidden">
      <button class="btn btn-secondary" onclick="goHome()" style="margin-bottom:12px;">← 返回列表</button>
      <div class="card">
        <h1 id="surveyTitle"></h1>
        <p class="desc" id="surveyDesc"></p>
      </div>
      <div class="card" id="questionsContainer"></div>
      <div class="card">
        <button class="btn btn-success" onclick="submitSurvey()" id="submitBtn">提交问卷</button>
      </div>
    </div>

    <div id="page-success" class="hidden">
      <div class="card success-page">
        <div class="check">✓</div>
        <h2>提交成功！</h2>
        <p>感谢您的参与，您的回答已匿名提交。</p>
        <button class="btn btn-secondary" onclick="goHome()">返回首页</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let currentSurveyId = null;
    let imageFiles = {};

    async function fetchAPI(url, opts = {}) {
      try {
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error('请求失败');
        return await res.json();
      } catch (e) {
        showToast('网络错误，请稍后重试');
        throw e;
      }
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    function goHome() {
      document.getElementById('page-home').classList.remove('hidden');
      document.getElementById('page-survey').classList.add('hidden');
      document.getElementById('page-success').classList.add('hidden');
      loadSurveys();
    }

    async function loadSurveys() {
      const container = document.getElementById('surveyList');
      container.innerHTML = '<div class="loading">加载中</div>';
      try {
        const surveys = await fetchAPI('/api/surveys');
        if (!surveys.length) {
          container.innerHTML = '<div class="empty"><div class="icon">📝</div><p>暂无可用问卷</p></div>';
          return;
        }
        container.innerHTML = '<div class="survey-list">' + surveys.map(s => 
          '<a class="survey-item" onclick="openSurvey(\\'' + s.id + '\\')">' +
            '<h3>' + escapeHtml(s.title) + '</h3>' +
            (s.description ? '<p>' + escapeHtml(s.description) + '</p>' : '') +
            '<div class="date">发布于 ' + formatDate(s.created_at) + '</div>' +
          '</a>'
        ).join('') + '</div>';
      } catch (e) {
        container.innerHTML = '<div class="empty"><p>加载失败，<a href="#" onclick="loadSurveys()">点击重试</a></p></div>';
      }
    }

    function formatDate(d) { return d ? d.slice(0, 10) : ''; }
    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    async function openSurvey(id) {
      currentSurveyId = id;
      imageFiles = {};
      document.getElementById('page-home').classList.add('hidden');
      document.getElementById('page-survey').classList.remove('hidden');
      document.getElementById('page-success').classList.add('hidden');

      document.getElementById('questionsContainer').innerHTML = '<div class="loading">加载中</div>';
      try {
        const data = await fetchAPI('/api/survey/' + id);
        document.getElementById('surveyTitle').textContent = data.survey.title;
        document.getElementById('surveyDesc').textContent = data.survey.description || '';

        let html = '';
        data.questions.forEach((q, idx) => {
          html += '<div class="question-block" data-qid="' + q.id + '" data-type="' + q.type + '">';
          html += '<div class="q-title">' + (idx + 1) + '. ' + escapeHtml(q.title) + (q.required ? '<span class="q-required">*</span>' : '') + '</div>';

          if (q.type === 'radio') {
            q.options.forEach(o => {
              html += '<div class="option-item" onclick="selectRadio(this)">' +
                '<input type="radio" name="q_' + q.id + '" value="' + escapeHtml(o) + '">' +
                '<label>' + escapeHtml(o) + '</label></div>';
            });
          } else if (q.type === 'checkbox') {
            q.options.forEach(o => {
              html += '<div class="option-item" onclick="toggleCheckbox(this)">' +
                '<input type="checkbox" value="' + escapeHtml(o) + '">' +
                '<label>' + escapeHtml(o) + '</label></div>';
            });
          } else if (q.type === 'double_select') {
            const mid = Math.ceil(q.options.length / 2);
            const left = q.options.slice(0, mid);
            const right = q.options.slice(mid);
            html += '<div class="double-select-row">' +
              '<select id="ds_left_' + q.id + '"><option value="">请选择</option>' + left.map(o => '<option value="' + escapeHtml(o) + '">' + escapeHtml(o) + '</option>').join('') + '</select>' +
              '<select id="ds_right_' + q.id + '"><option value="">请选择</option>' + right.map(o => '<option value="' + escapeHtml(o) + '">' + escapeHtml(o) + '</option>').join('') + '</select>' +
              '</div>';
          } else if (q.type === 'text') {
            html += '<textarea class="text-input" placeholder="请输入您的回答..."></textarea>';
          } else if (q.type === 'image') {
            html += '<div class="image-upload-area" onclick="document.getElementById(\\'img_' + q.id + '\\').click()" id="area_' + q.id + '">' +
              '<div class="upload-icon">📷</div>' +
              '<div class="upload-text">点击上传图片</div>' +
              '<input type="file" accept="image/*" id="img_' + q.id + '" onchange="previewImage(this, \\'' + q.id + '\\')">' +
              '<img class="image-preview hidden" id="preview_' + q.id + '">' +
              '</div>';
          }
          html += '</div>';
        });
        document.getElementById('questionsContainer').innerHTML = html;
      } catch (e) {
        document.getElementById('questionsContainer').innerHTML = '<div class="empty"><p>加载问卷失败</p></div>';
      }
    }

    function selectRadio(el) {
      const parent = el.parentElement;
      parent.querySelectorAll('.option-item').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      el.querySelector('input[type="radio"]').checked = true;
    }

    function toggleCheckbox(el) {
      el.classList.toggle('selected');
      const cb = el.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
    }

    function previewImage(input, qid) {
      if (input.files && input.files[0]) {
        imageFiles[qid] = input.files[0];
        const reader = new FileReader();
        reader.onload = function(e) {
          const preview = document.getElementById('preview_' + qid);
          preview.src = e.target.result;
          preview.classList.remove('hidden');
          document.getElementById('area_' + qid).classList.add('has-image');
          document.getElementById('area_' + qid).querySelector('.upload-text').textContent = '点击更换图片';
        };
        reader.readAsDataURL(input.files[0]);
      }
    }

    async function submitSurvey() {
      const container = document.getElementById('questionsContainer');
      const blocks = container.querySelectorAll('.question-block');
      const answers = [];
      let hasError = false;
      const formData = new FormData();

      blocks.forEach((block, idx) => {
        const qid = block.dataset.qid;
        const type = block.dataset.type;
        const required = block.querySelector('.q-required') !== null;
        let value = '';

        if (type === 'radio') {
          const checked = block.querySelector('input[type="radio"]:checked');
          if (checked) value = checked.value;
          else if (required) { hasError = true; showToast('请回答第 ' + (idx + 1) + ' 题'); }
        } else if (type === 'checkbox') {
          const checked = block.querySelectorAll('input[type="checkbox"]:checked');
          value = Array.from(checked).map(c => c.value).join(',');
          if (required && !value) { hasError = true; showToast('请回答第 ' + (idx + 1) + ' 题'); }
        } else if (type === 'double_select') {
          const left = document.getElementById('ds_left_' + qid).value;
          const right = document.getElementById('ds_right_' + qid).value;
          if (left || right) value = [left, right].filter(Boolean).join(',');
          else if (required) { hasError = true; showToast('请回答第 ' + (idx + 1) + ' 题'); }
        } else if (type === 'text') {
          value = block.querySelector('textarea')?.value || '';
          if (required && !value.trim()) { hasError = true; showToast('请回答第 ' + (idx + 1) + ' 题'); }
        } else if (type === 'image') {
          if (imageFiles[qid]) {
            formData.append('images', imageFiles[qid]);
          } else if (required) { hasError = true; showToast('请上传第 ' + (idx + 1) + ' 题的图片'); }
          answers.push({ questionId: qid, type: 'image', value: '' });
          return; // 跳过下面的push
        }
        answers.push({ questionId: qid, type, value });
      });

      if (hasError) return;

      formData.append('answers', JSON.stringify(answers));

      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = '提交中...';

      try {
        const res = await fetch('/api/survey/' + currentSurveyId + '/submit', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
          document.getElementById('page-survey').classList.add('hidden');
          document.getElementById('page-success').classList.remove('hidden');
        } else {
          showToast(data.error || '提交失败');
        }
      } catch (e) {
        showToast('提交失败，请重试');
      }
      btn.disabled = false;
      btn.textContent = '提交问卷';
    }

    loadSurveys();
  </script>
</body>
</html>
`;
const FRONTEND_ADMIN = String.raw`﻿<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>管理员后台 - 匿名问卷</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f5f7fa; color: #333; min-height: 100vh; padding: 16px; }
    .container { max-width: 800px; margin: 0 auto; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 12px; }
    h2 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 20px; background: #4a90d9; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .btn:active { background: #357abd; }
    .btn-secondary { background: #e8ecf1; color: #333; }
    .btn-secondary:active { background: #d5dae0; }
    .btn-success { background: #34c759; }
    .btn-danger { background: #ff3b30; }
    .btn-warning { background: #ff9500; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .btn-block { width: 100%; }
    .btn:disabled { opacity: 0.6; }
    .login-box { max-width: 360px; margin: 40px auto; }
    .login-box input { width: 100%; padding: 12px; margin-bottom: 12px; border: 2px solid #e8ecf1; border-radius: 8px; font-size: 15px; outline: none; }
    .login-box input:focus { border-color: #4a90d9; }
    .survey-item { padding: 16px; border: 1px solid #e8ecf1; border-radius: 8px; margin-bottom: 10px; }
    .survey-item .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
    .survey-item .title { font-size: 16px; font-weight: 600; }
    .survey-item .meta { font-size: 12px; color: #999; }
    .survey-item .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .badge-active { background: #e8f5e9; color: #2e7d32; }
    .badge-closed { background: #fbe9e7; color: #c62828; }
    .tab-bar { display: flex; gap: 0; margin-bottom: 16px; background: #e8ecf1; border-radius: 8px; overflow: hidden; }
    .tab-bar .tab { flex: 1; padding: 10px; text-align: center; font-weight: 600; font-size: 14px; cursor: pointer; transition: background 0.2s; }
    .tab-bar .tab.active { background: #4a90d9; color: #fff; }
    .stats-container .q-stats { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #eee; }
    .stats-container .q-stats:last-child { border-bottom: none; }
    .stats-container .q-title { font-weight: 600; margin-bottom: 8px; }
    .bar-chart { display: flex; align-items: center; margin-bottom: 4px; gap: 8px; }
    .bar-chart .label { min-width: 80px; font-size: 13px; }
    .bar-chart .bar-wrap { flex: 1; height: 20px; background: #e8ecf1; border-radius: 10px; overflow: hidden; }
    .bar-chart .bar { height: 100%; background: #4a90d9; border-radius: 10px; transition: width 0.3s; }
    .bar-chart .count { min-width: 40px; text-align: right; font-size: 12px; color: #666; }
    .text-answers { max-height: 200px; overflow-y: auto; }
    .text-answers .item { padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .text-answers .item:last-child { border-bottom: none; }
    .img-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
    .img-grid img { width: 100%; height: 80px; object-fit: cover; border-radius: 6px; cursor: pointer; }
    .stats-summary { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .stats-summary .stat-card { flex: 1; min-width: 100px; background: #f8f9fa; padding: 12px; border-radius: 8px; text-align: center; }
    .stats-summary .stat-card .num { font-size: 24px; font-weight: 700; color: #4a90d9; }
    .stats-summary .stat-card .label { font-size: 12px; color: #666; margin-top: 4px; }
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
    .modal-overlay.show { display: flex; }
    .modal { background: #fff; border-radius: 12px; padding: 20px; max-width: 500px; width: 100%; max-height: 80vh; overflow-y: auto; }
    .modal h3 { margin-bottom: 12px; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
    .form-group input[type='text'], .form-group textarea { width: 100%; padding: 10px; border: 2px solid #e8ecf1; border-radius: 8px; font-size: 14px; outline: none; }
    .form-group textarea { min-height: 60px; }
    .form-group input:focus { border-color: #4a90d9; }
    .q-editor-item { background: #f8f9fa; border-radius: 8px; padding: 12px; margin-bottom: 8px; }
    .q-editor-item .q-row { display: flex; gap: 8px; margin-bottom: 6px; align-items: center; flex-wrap: wrap; }
    .q-editor-item .q-row select, .q-editor-item .q-row input { padding: 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
    .q-editor-item .q-row input[type='text'] { flex: 1; min-width: 100px; }
    .q-editor-item .options-row { display: flex; gap: 4px; flex-wrap: wrap; }
    .q-editor-item .options-row input { flex: 1; min-width: 60px; padding: 4px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
    .empty { text-align: center; padding: 30px; color: #999; }
    .hidden { display: none; }
    .img-viewer { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); display: none; align-items: center; justify-content: center; z-index: 200; padding: 16px; cursor: pointer; }
    .img-viewer.show { display: flex; }
    .img-viewer img { max-width: 100%; max-height: 90vh; border-radius: 8px; }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 14px; z-index: 999; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="container" id="app">
    <!-- 登录页 -->
    <div id="page-login">
      <div class="card login-box">
        <h1 style="text-align:center;">🔐 管理员登录</h1>
        <p style="text-align:center;color:#999;margin-bottom:16px;">默认账号: admin / admin123</p>
        <input type="text" id="loginUser" placeholder="用户名" autocomplete="off">
        <input type="password" id="loginPass" placeholder="密码">
        <button class="btn btn-block" onclick="login()">登录</button>
        <p id="loginError" style="color:#ff3b30;text-align:center;margin-top:8px;display:none;"></p>
      </div>
    </div>

    <!-- 管理页 -->
    <div id="page-admin" class="hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <h1>📊 问卷管理</h1>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-success btn-sm" onclick="openEditor()">+ 新建问卷</button>
          <button class="btn btn-secondary btn-sm" onclick="logout()">退出</button>
        </div>
      </div>

      <div class="tab-bar">
        <div class="tab active" onclick="switchTab('list', this)">问卷列表</div>
        <div class="tab" onclick="switchTab('stats', this)">查看统计</div>
      </div>

      <div id="tab-list"></div>
      <div id="tab-stats" class="hidden"></div>
    </div>
  </div>

  <!-- 编辑器弹窗 -->
  <div class="modal-overlay" id="modal-editor">
    <div class="modal">
      <h3 id="editorTitle">新建问卷</h3>
      <div class="form-group">
        <label>问卷标题</label>
        <input type="text" id="edit-title" placeholder="请输入问卷标题">
      </div>
      <div class="form-group">
        <label>描述</label>
        <textarea id="edit-desc" placeholder="请输入问卷描述（可选）"></textarea>
      </div>
      <div class="form-group">
        <label>题目列表</label>
        <div id="edit-questions"></div>
        <button class="btn btn-secondary btn-sm btn-block" onclick="addQuestion()" style="margin-top:8px;">+ 添加题目</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-success" style="flex:1;" onclick="saveSurvey()">保存问卷</button>
        <button class="btn btn-secondary" style="flex:1;" onclick="closeEditor()">取消</button>
      </div>
    </div>
  </div>

  <!-- 图片查看 -->
  <div class="img-viewer" id="imgViewer" onclick="this.classList.remove('show')">
    <img id="imgViewerSrc">
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const TOKEN_KEY = 'admin_token';
    let editingId = null;
    let questionCounter = 0;

    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }

    async function api(url, opts = {}) {
      const token = getToken();
      if (token) opts.headers = { ...opts.headers, 'Authorization': token };
      try {
        const res = await fetch(url, opts);
        if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); location.reload(); throw new Error('未授权'); }
        return await res.json();
      } catch(e) { throw e; }
    }

    function login() {
      const username = document.getElementById('loginUser').value.trim();
      const password = document.getElementById('loginPass').value.trim();
      if (!username || !password) { showToast('请输入用户名和密码'); return; }
      fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      }).then(r => r.json()).then(d => {
        if (d.success) {
          localStorage.setItem(TOKEN_KEY, d.token);
          document.getElementById('page-login').classList.add('hidden');
          document.getElementById('page-admin').classList.remove('hidden');
          loadList();
        } else {
          document.getElementById('loginError').textContent = d.error;
          document.getElementById('loginError').style.display = 'block';
        }
      }).catch(() => showToast('登录失败'));
    }

    function logout() { localStorage.removeItem(TOKEN_KEY); location.reload(); }

    function switchTab(tab, el) {
      document.querySelectorAll('.tab-bar .tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('tab-list').classList.add('hidden');
      document.getElementById('tab-stats').classList.add('hidden');
      document.getElementById('tab-' + tab).classList.remove('hidden');
      if (tab === 'list') loadList();
    }

    async function loadList() {
      const container = document.getElementById('tab-list');
      container.innerHTML = '<div class="loading" style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const surveys = await api('/api/admin/surveys');
        if (!surveys.length) {
          container.innerHTML = '<div class="empty"><p>暂无问卷，点击右上角新建</p></div>';
          return;
        }
        container.innerHTML = surveys.map(s => 
          '<div class="survey-item">' +
            '<div class="header">' +
              '<span class="title">' + escapeHtml(s.title) + '</span>' +
              '<span class="badge ' + (s.status === 'active' ? 'badge-active' : 'badge-closed') + '">' + (s.status === 'active' ? '进行中' : '已关闭') + '</span>' +
            '</div>' +
            '<div class="meta">' + formatDate(s.created_at) + ' | 共 ' + (s.response_count || 0) + ' 份回答</div>' +
            '<div class="actions">' +
              '<button class="btn btn-sm" onclick="viewStats(\\'' + s.id + '\\')">📊 统计</button>' +
              '<button class="btn btn-warning btn-sm" onclick="openEditor(\\'' + s.id + '\\')">✏️ 编辑</button>' +
              '<button class="btn btn-sm btn-secondary" onclick="toggleSurvey(\\'' + s.id + '\\')">' + (s.status === 'active' ? '🔒 关闭' : '🔓 开启') + '</button>' +
            '</div>' +
          '</div>'
        ).join('');
      } catch(e) { container.innerHTML = '<div class="empty"><p>加载失败，<a href="#" onclick="loadList()">重试</a></p></div>'; }
    }

    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function formatDate(d) { return d ? d.slice(0, 10) : ''; }

    async function viewStats(id) {
      switchTab('stats', document.querySelectorAll('.tab-bar .tab')[1]);
      const container = document.getElementById('tab-stats');
      container.innerHTML = '<div class="loading" style="text-align:center;padding:20px;color:#999;">加载统计中...</div>';
      try {
        const data = await api('/api/admin/survey/' + id + '/stats');
        let html = '<div class="card"><h2>' + escapeHtml(data.survey.title) + ' - 统计结果</h2>';
        html += '<div class="stats-summary">' +
          '<div class="stat-card"><div class="num">' + data.total_responses + '</div><div class="label">总回答数</div></div>' +
          '<div class="stat-card"><div class="num">' + data.stats.length + '</div><div class="label">题目数</div></div>' +
        '</div></div>';

        data.stats.forEach((stat, idx) => {
          html += '<div class="card q-stats">';
          html += '<div class="q-title">' + (idx + 1) + '. ' + escapeHtml(stat.question.title) + ' <span style="font-weight:400;color:#999;font-size:12px;">(' + getTypeLabel(stat.question.type) + ')</span></div>';
          html += '<div style="font-size:12px;color:#999;margin-bottom:8px;">共 ' + stat.total + ' 条回答</div>';

          if (stat.question.type === 'radio' || stat.question.type === 'checkbox' || stat.question.type === 'double_select') {
            const total = stat.details.reduce((s, d) => s + d.count, 0) || 1;
            stat.details.forEach(d => {
              const pct = (d.count / total * 100).toFixed(1);
              html += '<div class="bar-chart"><span class="label">' + escapeHtml(d.key) + '</span><div class="bar-wrap"><div class="bar" style="width:' + pct + '%"></div></div><span class="count">' + d.count + ' (' + pct + '%)</span></div>';
            });
          } else if (stat.question.type === 'text') {
            if (stat.details.length) {
              html += '<div class="text-answers">' + stat.details.map(d => '<div class="item">' + escapeHtml(d.value || '(空)') + '</div>').join('') + '</div>';
            } else {
              html += '<p style="color:#999;">暂无回答</p>';
            }
          } else if (stat.question.type === 'image') {
            if (stat.details.length) {
              html += '<div class="img-grid">' + stat.details.filter(d => d.image_path).map(d => '<img src="' + d.image_path + '" onclick="viewImg(this.src)">').join('') + '</div>';
            } else {
              html += '<p style="color:#999;">暂无图片</p>';
            }
          }
          html += '</div>';
        });
        container.innerHTML = html;
      } catch(e) { container.innerHTML = '<div class="empty"><p>加载统计失败</p></div>'; }
    }

    function getTypeLabel(t) {
      const map = { radio: '单选', checkbox: '多选', double_select: '双选', text: '填空', image: '图片上传' };
      return map[t] || t;
    }

    async function toggleSurvey(id) {
      try {
        await api('/api/admin/survey/' + id + '/toggle', { method: 'POST' });
        showToast('状态已更新');
        loadList();
      } catch(e) { showToast('操作失败'); }
    }

    // --- 问卷编辑器 ---
    function openEditor(id) {
      editingId = id || null;
      document.getElementById('editorTitle').textContent = id ? '编辑问卷' : '新建问卷';
      document.getElementById('edit-title').value = '';
      document.getElementById('edit-desc').value = '';
      document.getElementById('edit-questions').innerHTML = '';
      questionCounter = 0;

      if (id) {
        fetch('/api/survey/' + id).then(r => r.json()).then(data => {
          document.getElementById('edit-title').value = data.survey.title;
          document.getElementById('edit-desc').value = data.survey.description || '';
          data.questions.forEach(q => {
            addQuestion(q.type, q.title, q.options, q.required);
          });
        });
      } else {
        addQuestion('radio', '', [], true);
      }
      document.getElementById('modal-editor').classList.add('show');
    }

    function closeEditor() {
      document.getElementById('modal-editor').classList.remove('show');
    }

    function addQuestion(type, title, options, required) {
      const container = document.getElementById('edit-questions');
      const idx = questionCounter++;
      const qid = 'q_' + idx;
      type = type || 'radio';
      title = title || '';
      options = options || ['选项1', '选项2'];
      required = required !== undefined ? required : true;

      let optsHtml = '';
      if (type === 'radio' || type === 'checkbox' || type === 'double_select') {
        optsHtml = '<div class="options-row" id="opts_' + qid + '">' +
          options.map((o, i) => '<input type="text" value="' + escapeHtml(o) + '" placeholder="选项' + (i + 1) + '">').join('') +
          '<button class="btn btn-secondary btn-sm" onclick="addOption(\\'' + qid + '\\')">+</button>' +
        '</div>';
      }

      container.insertAdjacentHTML('beforeend', 
        '<div class="q-editor-item" data-qid="' + qid + '">' +
          '<div class="q-row">' +
            '<select onchange="changeQType(this, \\'' + qid + '\\')">' +
              '<option value="radio"' + (type === 'radio' ? ' selected' : '') + '>单选</option>' +
              '<option value="checkbox"' + (type === 'checkbox' ? ' selected' : '') + '>多选</option>' +
              '<option value="double_select"' + (type === 'double_select' ? ' selected' : '') + '>双选</option>' +
              '<option value="text"' + (type === 'text' ? ' selected' : '') + '>填空</option>' +
              '<option value="image"' + (type === 'image' ? ' selected' : '') + '>图片上传</option>' +
            '</select>' +
            '<input type="text" value="' + escapeHtml(title) + '" placeholder="题目内容">' +
            '<label style="font-size:12px;white-space:nowrap;"><input type="checkbox" ' + (required ? 'checked' : '') + '> 必填</label>' +
            '<button class="btn btn-danger btn-sm" onclick="removeQuestion(this)">✕</button>' +
          '</div>' +
          '<div id="opts_container_' + qid + '">' + (optsHtml || '') + '</div>' +
        '</div>'
      );
    }

    function changeQType(sel, qid) {
      const container = document.getElementById('opts_container_' + qid);
      const val = sel.value;
      if (val === 'text' || val === 'image') {
        container.innerHTML = '';
      } else {
        container.innerHTML = '<div class="options-row" id="opts_' + qid + '">' +
          '<input type="text" value="选项1" placeholder="选项1">' +
          '<input type="text" value="选项2" placeholder="选项2">' +
          '<button class="btn btn-secondary btn-sm" onclick="addOption(\\'' + qid + '\\')">+</button>' +
        '</div>';
      }
    }

    function addOption(qid) {
      const row = document.getElementById('opts_' + qid);
      if (row) {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '选项' + (row.children.length);
        row.insertBefore(input, row.lastElementChild);
      }
    }

    function removeQuestion(btn) {
      btn.closest('.q-editor-item').remove();
    }

    function viewImg(src) {
      document.getElementById('imgViewerSrc').src = src;
      document.getElementById('imgViewer').classList.add('show');
    }

    async function saveSurvey() {
      const title = document.getElementById('edit-title').value.trim();
      if (!title) { showToast('请输入问卷标题'); return; }
      const desc = document.getElementById('edit-desc').value.trim();
      const items = document.querySelectorAll('#edit-questions .q-editor-item');
      const questions = [];

      for (const item of items) {
        const qid = item.dataset.qid;
        const type = item.querySelector('select').value;
        const titleEl = item.querySelector('.q-row > input[type="text"]');
        const qTitle = titleEl ? titleEl.value.trim() : '';
        if (!qTitle) { showToast('请填写所有题目标题'); return; }
        const required = item.querySelector('.q-row input[type="checkbox"]').checked;

        let options = [];
        if (type === 'radio' || type === 'checkbox' || type === 'double_select') {
          const optInputs = document.querySelectorAll('#opts_' + qid + ' input[type="text"]');
          options = Array.from(optInputs).map(i => i.value.trim()).filter(Boolean);
          if (options.length < 2) { showToast('选择题至少需要2个选项'); return; }
        }

        questions.push({ type, title: qTitle, options, required });
      }

      if (!questions.length) { showToast('请至少添加一道题目'); return; }

      try {
        const res = await api('/api/admin/survey/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingId, title, description: desc, questions })
        });
        if (res.success) {
          showToast('保存成功');
          closeEditor();
          loadList();
        }
      } catch(e) { showToast('保存失败'); }
    }

    // 检查登录
    if (getToken()) {
      document.getElementById('page-login').classList.add('hidden');
      document.getElementById('page-admin').classList.remove('hidden');
      loadList();
    }
  </script>
</body>
</html>
`;
app.get("/", (req, res) => res.type("html").send(FRONTEND_INDEX));
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

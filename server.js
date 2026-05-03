// ============================================================
// PhysiChim — Serveur Node.js + SQLite
// Déploiement : Railway.app
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Base de données SQLite légère ──────────────────────────
// On utilise better-sqlite3 (synchrone, parfait pour ce cas)
let db;
try {
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || './physichim.db';
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initDB();
  console.log('✅ Base de données initialisée :', dbPath);
} catch (e) {
  console.error('❌ Erreur SQLite :', e.message);
  process.exit(1);
}

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eleves (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      pseudo TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quiz_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eleve_id TEXT NOT NULL,
      chapitre_id INTEGER NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL DEFAULT 10,
      date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (eleve_id) REFERENCES eleves(id)
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eleve_id TEXT NOT NULL,
      type TEXT NOT NULL,
      intitule TEXT NOT NULL,
      valeur REAL NOT NULL,
      date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (eleve_id) REFERENCES eleves(id)
    );

    CREATE TABLE IF NOT EXISTS progression (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eleve_id TEXT NOT NULL,
      chapitre_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (eleve_id) REFERENCES eleves(id)
    );
  `);
}

// ── Utilitaires ───────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'physichim-admin-2024';
const PORT = process.env.PORT || 3000;

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${ADMIN_KEY}`;
}

// ── Routeur ───────────────────────────────────────────────
async function router(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // ── Servir le fichier HTML principal ──
  if (p === '/' || p === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
    return json(res, 404, { error: 'index.html introuvable' });
  }

  // ── Servir le fichier HTML principal ──
  if (p === '/' || p === '/admin.html') {
    const htmlPath = path.join(__dirname, 'admin.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
    return json(res, 404, { error: 'admin.html introuvable' });
  }

  // ── API : Connexion élève par code ──
  // POST /api/login  { code: "E01" }
  if (p === '/api/login' && method === 'POST') {
    const body = await parseBody(req);
    const code = (body.code || '').toUpperCase().trim();
    if (!code) return json(res, 400, { error: 'Code manquant' });

    const eleve = db.prepare('SELECT * FROM eleves WHERE code = ?').get(code);
    if (!eleve) return json(res, 404, { error: 'Code inconnu. Demandez votre code à votre enseignant.' });

    db.prepare("UPDATE eleves SET last_seen = datetime('now') WHERE id = ?").run(eleve.id);

    const scores = db.prepare('SELECT chapitre_id, score, total, date FROM quiz_scores WHERE eleve_id = ? ORDER BY date DESC').all(eleve.id);
    const notes = db.prepare('SELECT id, type, intitule, valeur, date FROM notes WHERE eleve_id = ? ORDER BY date DESC').all(eleve.id);
    const progression = db.prepare('SELECT chapitre_id, action, date FROM progression WHERE eleve_id = ? ORDER BY date DESC LIMIT 50').all(eleve.id);

    return json(res, 200, {
      eleve: { id: eleve.id, code: eleve.code, pseudo: eleve.pseudo },
      scores, notes, progression
    });
  }

  // ── API : Sauvegarder un score de quiz ──
  // POST /api/quiz  { eleve_id, chapitre_id, score, total }
  if (p === '/api/quiz' && method === 'POST') {
    const body = await parseBody(req);
    const { eleve_id, chapitre_id, score, total } = body;
    if (!eleve_id || chapitre_id === undefined || score === undefined) {
      return json(res, 400, { error: 'Données manquantes' });
    }
    const eleve = db.prepare('SELECT id FROM eleves WHERE id = ?').get(eleve_id);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });

    db.prepare('INSERT INTO quiz_scores (eleve_id, chapitre_id, score, total) VALUES (?, ?, ?, ?)').run(eleve_id, chapitre_id, score, total || 10);
    db.prepare("UPDATE eleves SET last_seen = datetime('now') WHERE id = ?").run(eleve_id);

    return json(res, 201, { ok: true });
  }

  // ── API : Sauvegarder une note ──
  // POST /api/notes  { eleve_id, type, intitule, valeur }
  if (p === '/api/notes' && method === 'POST') {
    const body = await parseBody(req);
    const { eleve_id, type, intitule, valeur } = body;
    if (!eleve_id || !type || !intitule || valeur === undefined) {
      return json(res, 400, { error: 'Données manquantes' });
    }
    const eleve = db.prepare('SELECT id FROM eleves WHERE id = ?').get(eleve_id);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });

    const result = db.prepare('INSERT INTO notes (eleve_id, type, intitule, valeur) VALUES (?, ?, ?, ?)').run(eleve_id, type, intitule, valeur);
    return json(res, 201, { ok: true, id: result.lastInsertRowid });
  }

  // ── API : Supprimer une note ──
  // DELETE /api/notes/:id
  if (p.startsWith('/api/notes/') && method === 'DELETE') {
    const noteId = p.split('/')[3];
    const body = await parseBody(req);
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!note) return json(res, 404, { error: 'Note introuvable' });
    if (note.eleve_id !== body.eleve_id && !isAdmin(req)) {
      return json(res, 403, { error: 'Non autorisé' });
    }
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    return json(res, 200, { ok: true });
  }

  // ── API : Enregistrer une progression ──
  // POST /api/progression  { eleve_id, chapitre_id, action }
  if (p === '/api/progression' && method === 'POST') {
    const body = await parseBody(req);
    const { eleve_id, chapitre_id, action } = body;
    if (!eleve_id || chapitre_id === undefined || !action) {
      return json(res, 400, { error: 'Données manquantes' });
    }
    db.prepare('INSERT INTO progression (eleve_id, chapitre_id, action) VALUES (?, ?, ?)').run(eleve_id, chapitre_id, action);
    return json(res, 201, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // ROUTES ADMIN (protégées par ADMIN_KEY)
  // ══════════════════════════════════════════════════════════

  // ── Admin : Créer un élève ──
  // POST /api/admin/eleves  { code, pseudo }
  if (p === '/api/admin/eleves' && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });
    const body = await parseBody(req);
    const code = (body.code || '').toUpperCase().trim();
    const pseudo = (body.pseudo || code).trim();
    if (!code) return json(res, 400, { error: 'Code manquant' });

    const existing = db.prepare('SELECT id FROM eleves WHERE code = ?').get(code);
    if (existing) return json(res, 409, { error: 'Ce code existe déjà' });

    const id = genId();
    db.prepare('INSERT INTO eleves (id, code, pseudo) VALUES (?, ?, ?)').run(id, code, pseudo);
    return json(res, 201, { ok: true, id, code, pseudo });
  }

  // ── Admin : Supprimer un élève ──
  // DELETE /api/admin/eleves/:id
  if (p.startsWith('/api/admin/eleves/') && method === 'DELETE') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    db.prepare('DELETE FROM quiz_scores WHERE eleve_id = ?').run(eleveId);
    db.prepare('DELETE FROM notes WHERE eleve_id = ?').run(eleveId);
    db.prepare('DELETE FROM progression WHERE eleve_id = ?').run(eleveId);
    db.prepare('DELETE FROM eleves WHERE id = ?').run(eleveId);
    return json(res, 200, { ok: true });
  }

  // ── Admin : Liste de tous les élèves avec leurs données ──
  // GET /api/admin/eleves
  if (p === '/api/admin/eleves' && method === 'GET') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });

    const eleves = db.prepare('SELECT * FROM eleves ORDER BY code').all();
    const result = eleves.map(e => {
      const scores = db.prepare('SELECT chapitre_id, MAX(score) as score, total FROM quiz_scores WHERE eleve_id = ? GROUP BY chapitre_id').all(e.id);
      const notes = db.prepare('SELECT type, intitule, valeur, date FROM notes WHERE eleve_id = ? ORDER BY date DESC').all(e.id);
      const lastSeen = e.last_seen;
      return { ...e, scores, notes, lastSeen };
    });
    return json(res, 200, result);
  }

  // ── Admin : Export CSV complet ──
  // GET /api/admin/export
  if (p === '/api/admin/export' && method === 'GET') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });

    const eleves = db.prepare('SELECT * FROM eleves ORDER BY code').all();
    const chapitres = Array.from({length: 15}, (_, i) => i); // ch 0 à 14

    let csv = 'Code;Pseudo;Derniere_connexion;';
    csv += chapitres.map(i => `Ch${String(i).padStart(2,'0')}_meilleur_score`).join(';');
    csv += ';Nb_notes;Moyenne_notes\n';

    eleves.forEach(e => {
      const scores = db.prepare('SELECT chapitre_id, MAX(score) as score FROM quiz_scores WHERE eleve_id = ? GROUP BY chapitre_id').all(e.id);
      const notes = db.prepare('SELECT valeur FROM notes WHERE eleve_id = ?').all(e.id);
      const avgNote = notes.length ? (notes.reduce((a,b) => a + b.valeur, 0) / notes.length).toFixed(2) : '';

      const scoreMap = {};
      scores.forEach(s => scoreMap[s.chapitre_id] = s.score);

      csv += `${e.code};${e.pseudo};${e.last_seen};`;
      csv += chapitres.map(i => scoreMap[i] !== undefined ? scoreMap[i] : '').join(';');
      csv += `;${notes.length};${avgNote}\n`;
    });

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="physichim_export_${new Date().toISOString().slice(0,10)}.csv"`,
      'Access-Control-Allow-Origin': '*'
    });
    return res.end('\uFEFF' + csv);
  }

  // ── Admin : Réinitialiser les données d'un élève ──
  // POST /api/admin/eleves/:id/reset
  if (p.match(/^\/api\/admin\/eleves\/[^/]+\/reset$/) && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    db.prepare('DELETE FROM quiz_scores WHERE eleve_id = ?').run(eleveId);
    db.prepare('DELETE FROM notes WHERE eleve_id = ?').run(eleveId);
    db.prepare('DELETE FROM progression WHERE eleve_id = ?').run(eleveId);
    return json(res, 200, { ok: true });
  }

  // ── Health check ──
  if (p === '/health') {
    return json(res, 200, { ok: true, uptime: process.uptime(), eleves: db.prepare('SELECT COUNT(*) as n FROM eleves').get().n });
  }

  return json(res, 404, { error: 'Route introuvable' });
}

// ── Lancement ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    console.error('Erreur serveur :', err);
    json(res, 500, { error: 'Erreur interne du serveur' });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 PhysiChim Server — port ${PORT}`);
  console.log(`🔑 Clé admin : ${ADMIN_KEY}`);
  console.log(`📊 /api/admin/eleves — gestion des élèves`);
  console.log(`📥 /api/admin/export  — export CSV`);
});

// ============================================================
// PhysiChim — Serveur Node.js + SQLite + PostgreSQL
// Déploiement : Railway.app
// ============================================================
//
// Deux bases, volontairement séparées :
//   - SQLite (fichier local / volume Railway) : admins, classes, classe_chapitres
//     — la configuration de l'appli et des comptes enseignants.
//   - PostgreSQL (service dédié) : eleves, quiz_scores, notes, progression
//     — les données élèves proprement dites, isolées sur un service à part.
// Conséquence : impossible de faire un JOIN SQL entre une classe et ses élèves
// (bases différentes) ; ces jointures sont donc faites en mémoire, côté JS,
// après avoir interrogé les deux bases séparément.

// Charge un .env local si présent (n'existe pas en production : Railway fournit les
// variables d'environnement directement, ce require reste alors un no-op silencieux).
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// ── Base SQLite (config appli : admins, classes, autorisations) ───────────
let db;
const DB_PATH = process.env.DB_PATH || './physichim.db';
try {
  const Database = require('better-sqlite3');
  // Sur Railway, DB_PATH pointe vers le volume persistant (/data/physichim.db) : le
  // dossier doit exister avant l'ouverture (mkdirSync est un no-op sans danger en local,
  // où le dossier courant existe déjà).
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initDB();
  console.log('✅ Base de données appli (SQLite) initialisée :', DB_PATH);
} catch (e) {
  console.error('❌ Erreur SQLite :', e.message);
  process.exit(1);
}

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      identifiant TEXT UNIQUE NOT NULL,
      code TEXT NOT NULL,
      nom TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      nom TEXT NOT NULL,
      niveau TEXT NOT NULL DEFAULT 'tle',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (admin_id) REFERENCES admins(id)
    );

    CREATE TABLE IF NOT EXISTS classe_chapitres (
      classe_id TEXT NOT NULL,
      chapitre_id INTEGER NOT NULL,
      PRIMARY KEY (classe_id, chapitre_id),
      FOREIGN KEY (classe_id) REFERENCES classes(id)
    );
  `);

  // Migration : les données élèves ont déménagé vers PostgreSQL (cf. plus haut) — on
  // supprime les anciennes tables SQLite correspondantes. Nécessaire, pas cosmétique :
  // leur contrainte FOREIGN KEY vers classes(id) bloque sinon la suppression d'une classe
  // encore référencée par ces lignes désormais orphelines et obsolètes.
  db.exec(`
    DROP TABLE IF EXISTS quiz_scores;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS progression;
    DROP TABLE IF EXISTS eleves;
  `);

  // Migration : ajouter classes.niveau si la colonne n'existe pas encore
  const classeCols = db.prepare("PRAGMA table_info(classes)").all();
  if (!classeCols.some(c => c.name === 'niveau')) {
    db.exec("ALTER TABLE classes ADD COLUMN niveau TEXT NOT NULL DEFAULT 'tle'");
  }
}

// ── Base PostgreSQL (données élèves : eleves, quiz_scores, notes, progression) ──
// STUDENT_DATABASE_URL est obligatoire (pas de repli SQLite) : la séparation
// physique des données élèves est le but de cette architecture, un repli
// silencieux la rendrait illusoire. En local, pointer vers une instance
// PostgreSQL installée sur la machine (ex: postgres://postgres:postgres@localhost:5432/physichim_eleves).
const STUDENT_DB_URL = process.env.STUDENT_DATABASE_URL || process.env.DATABASE_URL;
let pgPool;

async function initPgDB() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS eleves (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      pseudo TEXT NOT NULL,
      classe_id TEXT,
      admin_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS quiz_scores (
      id SERIAL PRIMARY KEY,
      eleve_id TEXT NOT NULL REFERENCES eleves(id) ON DELETE CASCADE,
      chapitre_id INTEGER NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL DEFAULT 10,
      date TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      eleve_id TEXT NOT NULL REFERENCES eleves(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      intitule TEXT NOT NULL,
      valeur REAL NOT NULL,
      date TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS progression (
      id SERIAL PRIMARY KEY,
      eleve_id TEXT NOT NULL REFERENCES eleves(id) ON DELETE CASCADE,
      chapitre_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      date TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Petits raccourcis pour retrouver le vocabulaire .get()/.all()/.run() de better-sqlite3
// et limiter le bruit dans les routes (qui manipulent déjà les deux bases).
async function pgGet(sql, params = []) {
  const r = await pgPool.query(sql, params);
  return r.rows[0] || null;
}
async function pgAll(sql, params = []) {
  const r = await pgPool.query(sql, params);
  return r.rows;
}
async function pgRun(sql, params = []) {
  return pgPool.query(sql, params);
}

// ── Utilitaires ───────────────────────────────────────────
// Clé maître : priorité à la variable d'environnement (obligatoire en production).
// En local, si elle n'est pas définie, on génère une clé aléatoire unique à cette
// installation et on la persiste dans un fichier — plutôt qu'un mot de passe par
// défaut identique et deviné d'avance sur toutes les installations. Le fichier est
// colocalisé avec la base de données (donc sur le volume persistant /data en
// production si DB_PATH est configuré) pour survivre aux redéploiements même si
// ADMIN_KEY n'a pas été explicitement définie.
function resolveAdminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  const keyFile = path.join(path.dirname(DB_PATH), '.admin-key');
  try {
    return fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    const generated = crypto.randomBytes(12).toString('hex');
    try { fs.writeFileSync(keyFile, generated, { mode: 0o600 }); } catch {}
    return generated;
  }
}
const ADMIN_KEY = resolveAdminKey();
const PORT = process.env.PORT || 3000;
const MAX_ADMINS = 5;

// ── Niveaux scolaires et accès en cascade ──────────────────
// Un élève d'un niveau donné peut réviser son année + les années précédentes.
// Ordre du plus ancien au plus récent : Seconde -> Première -> Terminale.
const NIVEAU_ORDER = ['2nde', '1ere', 'tle'];
const NIVEAU_RANGES = { '2nde': [21, 44], '1ere': [45, 62], tle: [0, 20] };

function isNiveauValide(niveau) {
  return NIVEAU_ORDER.includes(niveau);
}

function chapitreIdsDuNiveau(niveau) {
  const range = NIVEAU_RANGES[niveau];
  if (!range) return [];
  const [a, b] = range;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

// Niveaux déjà couverts avant celui-ci (ex: 'tle' -> ['2nde', '1ere'])
function niveauxPrecedents(niveau) {
  const idx = NIVEAU_ORDER.indexOf(niveau);
  return idx <= 0 ? [] : NIVEAU_ORDER.slice(0, idx);
}

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// ── Rate limiting simple en mémoire ─────────────────────────
// Protège les points de connexion contre le bourrinage (essayer plein de codes/mots
// de passe à la suite). Volontairement basique (pas de dépendance externe) : suffisant
// pour un usage scolaire, à revoir si l'appli est un jour exposée massivement.
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const rateLimitBuckets = new Map();

function getClientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) return { blocked: false };
  if (bucket.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return { blocked: true, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { blocked: false };
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    bucket.count++;
  }
}

function clearRateLimit(key) {
  rateLimitBuckets.delete(key);
}

// ── Clé maître (gestion des comptes enseignants uniquement) ──
function isSuperAdmin(req) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${ADMIN_KEY}`;
}

// ── Auth enseignant (identifiant + code) ──
// Le token embarque un horodatage d'émission et expire après ADMIN_TOKEN_MAX_AGE_MS :
// un token volé (ex: via une faille XSS) ne reste donc pas valable indéfiniment, et
// l'enseignant doit se reconnecter périodiquement.
const ADMIN_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function makeAdminToken(admin) {
  return Buffer.from(`${admin.id}:${admin.code}:${Date.now()}`, 'utf8').toString('base64');
}

function getAdminFromToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
  const firstSep = decoded.indexOf(':');
  const lastSep = decoded.lastIndexOf(':');
  // Un seul ':' = ancien format sans horodatage (émis avant cette version) -> rejeté,
  // ce qui force une reconnexion plutôt que d'accepter un token qui n'expire jamais.
  if (firstSep === -1 || lastSep === firstSep) return null;
  const id = decoded.slice(0, firstSep);
  const code = decoded.slice(firstSep + 1, lastSep);
  const issuedAt = parseInt(decoded.slice(lastSep + 1), 10);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > ADMIN_TOKEN_MAX_AGE_MS) return null;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
  if (!admin || admin.code !== code) return null;
  return admin;
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

// Construit une map { classe_id -> classe } à partir de la base SQLite, pour fusionner
// en mémoire avec les élèves (base Postgres) — remplace les anciens JOIN SQL devenus
// impossibles entre deux bases séparées.
function classesMapParAdmin(adminId) {
  const classes = db.prepare('SELECT * FROM classes WHERE admin_id = ?').all(adminId);
  const map = new Map();
  classes.forEach(c => map.set(c.id, c));
  return map;
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

  // ── Servir l'interface admin ──
  if (p === '/admin' || p === '/admin.html') {
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
    const rlKey = 'eleve-login:' + getClientIp(req);
    const rl = checkRateLimit(rlKey);
    if (rl.blocked) return json(res, 429, { error: `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.` });

    const body = await parseBody(req);
    const code = (body.code || '').toUpperCase().trim();
    if (!code) return json(res, 400, { error: 'Code manquant' });

    const eleve = await pgGet('SELECT * FROM eleves WHERE code = $1', [code]);
    if (!eleve) {
      recordFailedAttempt(rlKey);
      return json(res, 404, { error: 'Code inconnu. Demandez votre code à votre enseignant.' });
    }
    clearRateLimit(rlKey);

    await pgRun('UPDATE eleves SET last_seen = now() WHERE id = $1', [eleve.id]);

    const scores = await pgAll('SELECT chapitre_id, score, total, date FROM quiz_scores WHERE eleve_id = $1 ORDER BY date DESC', [eleve.id]);
    const notes = await pgAll('SELECT id, type, intitule, valeur, date FROM notes WHERE eleve_id = $1 ORDER BY date DESC', [eleve.id]);
    const progression = await pgAll('SELECT chapitre_id, action, date FROM progression WHERE eleve_id = $1 ORDER BY date DESC LIMIT 50', [eleve.id]);

    let classe = null;
    let chapitresAutorises = [];
    if (eleve.classe_id) {
      classe = db.prepare('SELECT id, nom, niveau FROM classes WHERE id = ?').get(eleve.classe_id) || null;
      if (classe) {
        chapitresAutorises = db.prepare('SELECT chapitre_id FROM classe_chapitres WHERE classe_id = ?').all(eleve.classe_id).map(r => r.chapitre_id);
      }
    }

    return json(res, 200, {
      eleve: { id: eleve.id, code: eleve.code, pseudo: eleve.pseudo },
      classe, chapitresAutorises,
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
    const eleve = await pgGet('SELECT id FROM eleves WHERE id = $1', [eleve_id]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });

    await pgRun('INSERT INTO quiz_scores (eleve_id, chapitre_id, score, total) VALUES ($1, $2, $3, $4)', [eleve_id, chapitre_id, score, total || 10]);
    await pgRun('UPDATE eleves SET last_seen = now() WHERE id = $1', [eleve_id]);

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
    const eleve = await pgGet('SELECT id FROM eleves WHERE id = $1', [eleve_id]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });

    const inserted = await pgGet('INSERT INTO notes (eleve_id, type, intitule, valeur) VALUES ($1, $2, $3, $4) RETURNING id', [eleve_id, type, intitule, valeur]);
    return json(res, 201, { ok: true, id: inserted.id });
  }

  // ── API : Supprimer une note ──
  // DELETE /api/notes/:id
  if (p.startsWith('/api/notes/') && method === 'DELETE') {
    const noteId = p.split('/')[3];
    const body = await parseBody(req);
    const note = await pgGet('SELECT * FROM notes WHERE id = $1', [noteId]);
    if (!note) return json(res, 404, { error: 'Note introuvable' });
    if (note.eleve_id !== body.eleve_id && !isSuperAdmin(req)) {
      return json(res, 403, { error: 'Non autorisé' });
    }
    await pgRun('DELETE FROM notes WHERE id = $1', [noteId]);
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
    await pgRun('INSERT INTO progression (eleve_id, chapitre_id, action) VALUES ($1, $2, $3)', [eleve_id, chapitre_id, action]);
    return json(res, 201, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // CONNEXION ENSEIGNANT (identifiant + code)
  // ══════════════════════════════════════════════════════════

  // POST /api/admin/login  { identifiant, code }
  if (p === '/api/admin/login' && method === 'POST') {
    const rlKey = 'admin-login:' + getClientIp(req);
    const rl = checkRateLimit(rlKey);
    if (rl.blocked) return json(res, 429, { error: `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.` });

    const body = await parseBody(req);
    const identifiant = (body.identifiant || '').trim();
    const code = (body.code || '').trim();
    if (!identifiant || !code) return json(res, 400, { error: 'Identifiant et code requis' });

    const admin = db.prepare('SELECT * FROM admins WHERE identifiant = ?').get(identifiant);
    if (!admin || admin.code !== code) {
      recordFailedAttempt(rlKey);
      return json(res, 401, { error: 'Identifiant ou code incorrect' });
    }
    clearRateLimit(rlKey);

    db.prepare("UPDATE admins SET last_seen = datetime('now') WHERE id = ?").run(admin.id);

    return json(res, 200, {
      token: makeAdminToken(admin),
      admin: { id: admin.id, identifiant: admin.identifiant, nom: admin.nom }
    });
  }

  // ══════════════════════════════════════════════════════════
  // GESTION DES COMPTES ENSEIGNANTS (clé maître ADMIN_KEY, max 5)
  // ══════════════════════════════════════════════════════════

  // ── Créer un compte enseignant ──
  // POST /api/admin/teachers  { identifiant, code, nom }
  if (p === '/api/admin/teachers' && method === 'POST') {
    if (!isSuperAdmin(req)) return json(res, 401, { error: 'Clé maître requise' });
    const body = await parseBody(req);
    const identifiant = (body.identifiant || '').trim();
    const code = (body.code || '').trim();
    const nom = (body.nom || identifiant).trim();
    if (!identifiant || !code) return json(res, 400, { error: 'Identifiant et code requis' });

    const count = db.prepare('SELECT COUNT(*) as n FROM admins').get().n;
    if (count >= MAX_ADMINS) return json(res, 409, { error: `Limite de ${MAX_ADMINS} comptes enseignants atteinte` });

    const existing = db.prepare('SELECT id FROM admins WHERE identifiant = ?').get(identifiant);
    if (existing) return json(res, 409, { error: 'Cet identifiant existe déjà' });

    const id = genId();
    db.prepare('INSERT INTO admins (id, identifiant, code, nom) VALUES (?, ?, ?, ?)').run(id, identifiant, code, nom);
    return json(res, 201, { ok: true, id, identifiant, nom });
  }

  // ── Liste des comptes enseignants ──
  // GET /api/admin/teachers
  if (p === '/api/admin/teachers' && method === 'GET') {
    const rlKeySuper = 'superadmin-login:' + getClientIp(req);
    const rlSuper = checkRateLimit(rlKeySuper);
    if (rlSuper.blocked) return json(res, 429, { error: `Trop de tentatives. Réessayez dans ${Math.ceil(rlSuper.retryAfterSec / 60)} min.` });
    if (!isSuperAdmin(req)) {
      recordFailedAttempt(rlKeySuper);
      return json(res, 401, { error: 'Clé maître requise' });
    }
    clearRateLimit(rlKeySuper);
    const admins = db.prepare('SELECT id, identifiant, nom, created_at, last_seen FROM admins ORDER BY identifiant').all();
    const result = await Promise.all(admins.map(async a => {
      const nbClasses = db.prepare('SELECT COUNT(*) as n FROM classes WHERE admin_id = ?').get(a.id).n;
      const classeIds = db.prepare('SELECT id FROM classes WHERE admin_id = ?').all(a.id).map(c => c.id);
      const nbElevesRow = await pgGet('SELECT COUNT(*)::int as n FROM eleves WHERE classe_id = ANY($1::text[])', [classeIds]);
      return { ...a, nbClasses, nbEleves: nbElevesRow.n };
    }));
    return json(res, 200, result);
  }

  // ── Supprimer un compte enseignant (et ses classes) ──
  // DELETE /api/admin/teachers/:id
  if (p.startsWith('/api/admin/teachers/') && method === 'DELETE') {
    if (!isSuperAdmin(req)) return json(res, 401, { error: 'Clé maître requise' });
    const adminId = p.split('/')[4];
    const classeIds = db.prepare('SELECT id FROM classes WHERE admin_id = ?').all(adminId).map(c => c.id);
    if (classeIds.length) {
      await pgRun('UPDATE eleves SET classe_id = NULL WHERE classe_id = ANY($1::text[])', [classeIds]);
    }
    classeIds.forEach(cid => {
      db.prepare('DELETE FROM classe_chapitres WHERE classe_id = ?').run(cid);
    });
    db.prepare('DELETE FROM classes WHERE admin_id = ?').run(adminId);
    db.prepare('DELETE FROM admins WHERE id = ?').run(adminId);
    return json(res, 200, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // ROUTES CLASSES (scoped à l'enseignant connecté)
  // ══════════════════════════════════════════════════════════

  // ── Créer une classe ──
  // POST /api/admin/classes  { nom, niveau }
  if (p === '/api/admin/classes' && method === 'POST') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const body = await parseBody(req);
    const nom = (body.nom || '').trim();
    const niveau = body.niveau;
    if (!nom) return json(res, 400, { error: 'Nom de classe requis' });
    if (!isNiveauValide(niveau)) return json(res, 400, { error: 'Niveau invalide (2nde, 1ere ou tle attendu)' });

    const id = genId();
    db.prepare('INSERT INTO classes (id, admin_id, nom, niveau) VALUES (?, ?, ?, ?)').run(id, admin.id, nom, niveau);

    // Pré-autorise automatiquement les chapitres des années précédentes (déjà vues) —
    // seul le programme de l'année en cours démarre décoché, à activer au fil de l'année.
    const insertCh = db.prepare('INSERT INTO classe_chapitres (classe_id, chapitre_id) VALUES (?, ?)');
    const chapitresPreAutorises = niveauxPrecedents(niveau).flatMap(chapitreIdsDuNiveau);
    chapitresPreAutorises.forEach(cid => insertCh.run(id, cid));

    return json(res, 201, { ok: true, id, nom, niveau, chapitresAutorises: chapitresPreAutorises });
  }

  // ── Liste des classes de l'enseignant ──
  // GET /api/admin/classes
  if (p === '/api/admin/classes' && method === 'GET') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });

    const classes = db.prepare('SELECT * FROM classes WHERE admin_id = ? ORDER BY nom').all(admin.id);
    const result = await Promise.all(classes.map(async c => {
      const nbElevesRow = await pgGet('SELECT COUNT(*)::int as n FROM eleves WHERE classe_id = $1', [c.id]);
      const chapitresAutorises = db.prepare('SELECT chapitre_id FROM classe_chapitres WHERE classe_id = ?').all(c.id).map(r => r.chapitre_id);
      return { ...c, nbEleves: nbElevesRow.n, chapitresAutorises };
    }));
    return json(res, 200, result);
  }

  // ── Définir les chapitres autorisés pour une classe ──
  // PUT /api/admin/classes/:id/chapitres  { chapitre_ids: [0,1,2] }
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/chapitres$/) && method === 'PUT') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = db.prepare('SELECT * FROM classes WHERE id = ?').get(classeId);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const body = await parseBody(req);
    const ids = Array.isArray(body.chapitre_ids) ? body.chapitre_ids.filter(n => Number.isInteger(n) && n >= 0 && n <= 99) : [];

    db.prepare('DELETE FROM classe_chapitres WHERE classe_id = ?').run(classeId);
    const insertCh = db.prepare('INSERT INTO classe_chapitres (classe_id, chapitre_id) VALUES (?, ?)');
    ids.forEach(cid => insertCh.run(classeId, cid));

    return json(res, 200, { ok: true, chapitresAutorises: ids });
  }

  // ── Promouvoir une classe au niveau supérieur (fin d'année) ──
  // POST /api/admin/classes/:id/promouvoir
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/promouvoir$/) && method === 'POST') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = db.prepare('SELECT * FROM classes WHERE id = ?').get(classeId);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const idx = NIVEAU_ORDER.indexOf(classe.niveau);
    if (idx === -1 || idx >= NIVEAU_ORDER.length - 1) {
      return json(res, 400, { error: 'Cette classe est déjà au niveau maximal (Terminale)' });
    }
    const nouveauNiveau = NIVEAU_ORDER[idx + 1];
    db.prepare('UPDATE classes SET niveau = ? WHERE id = ?').run(nouveauNiveau, classeId);

    // Le programme de l'année qui vient de se terminer est désormais entièrement « déjà vu » :
    // on l'auto-autorise en totalité, comme les années précédentes le sont à la création d'une classe.
    const insertCh = db.prepare('INSERT OR IGNORE INTO classe_chapitres (classe_id, chapitre_id) VALUES (?, ?)');
    chapitreIdsDuNiveau(classe.niveau).forEach(cid => insertCh.run(classeId, cid));

    const chapitresAutorises = db.prepare('SELECT chapitre_id FROM classe_chapitres WHERE classe_id = ?').all(classeId).map(r => r.chapitre_id);
    return json(res, 200, { ok: true, niveau: nouveauNiveau, chapitresAutorises });
  }

  // ── Supprimer une classe ──
  // DELETE /api/admin/classes/:id
  if (p.startsWith('/api/admin/classes/') && method === 'DELETE') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = db.prepare('SELECT * FROM classes WHERE id = ?').get(classeId);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    await pgRun('UPDATE eleves SET classe_id = NULL WHERE classe_id = $1', [classeId]);
    db.prepare('DELETE FROM classe_chapitres WHERE classe_id = ?').run(classeId);
    db.prepare('DELETE FROM classes WHERE id = ?').run(classeId);
    return json(res, 200, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // ROUTES ÉLÈVES (gestion, scoped à l'enseignant connecté)
  // ══════════════════════════════════════════════════════════

  // ── Créer un élève dans une classe ──
  // POST /api/admin/eleves  { code, pseudo, classe_id }
  if (p === '/api/admin/eleves' && method === 'POST') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const body = await parseBody(req);
    const code = (body.code || '').toUpperCase().trim();
    const pseudo = (body.pseudo || code).trim();
    const classeId = (body.classe_id || '').trim();
    if (!code) return json(res, 400, { error: 'Code manquant' });
    if (!classeId) return json(res, 400, { error: 'Classe manquante' });

    const classe = db.prepare('SELECT * FROM classes WHERE id = ?').get(classeId);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const existing = await pgGet('SELECT id FROM eleves WHERE code = $1', [code]);
    if (existing) return json(res, 409, { error: 'Ce code existe déjà' });

    const id = genId();
    await pgRun('INSERT INTO eleves (id, code, pseudo, classe_id, admin_id) VALUES ($1, $2, $3, $4, $5)', [id, code, pseudo, classeId, admin.id]);
    return json(res, 201, { ok: true, id, code, pseudo, classe_id: classeId });
  }

  // ── Déplacer un élève vers une autre classe du même enseignant ──
  // PUT /api/admin/eleves/:id/classe  { classe_id }
  if (p.match(/^\/api\/admin\/eleves\/[^/]+\/classe$/) && method === 'PUT') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await pgGet('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    const body = await parseBody(req);
    const newClasseId = (body.classe_id || '').trim();
    const newClasse = db.prepare('SELECT * FROM classes WHERE id = ?').get(newClasseId);
    if (!newClasse || newClasse.admin_id !== admin.id) return json(res, 404, { error: 'Classe cible introuvable' });

    await pgRun('UPDATE eleves SET classe_id = $1 WHERE id = $2', [newClasseId, eleveId]);
    return json(res, 200, { ok: true });
  }

  // ── Supprimer un élève ──
  // DELETE /api/admin/eleves/:id
  if (p.startsWith('/api/admin/eleves/') && method === 'DELETE') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await pgGet('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    // ON DELETE CASCADE (Postgres) nettoie automatiquement quiz_scores/notes/progression.
    await pgRun('DELETE FROM eleves WHERE id = $1', [eleveId]);
    return json(res, 200, { ok: true });
  }

  // ── Liste des élèves de l'enseignant (toutes ses classes) ──
  // GET /api/admin/eleves
  if (p === '/api/admin/eleves' && method === 'GET') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });

    // classe_id = NULL (classe supprimée) : l'élève reste rattaché à son enseignant via
    // admin_id et doit rester visible ici plutôt que de disparaître silencieusement.
    const eleves = await pgAll('SELECT * FROM eleves WHERE admin_id = $1', [admin.id]);
    const classesById = classesMapParAdmin(admin.id);

    const result = await Promise.all(eleves.map(async e => {
      const classe = e.classe_id ? classesById.get(e.classe_id) : null;
      const scores = await pgAll('SELECT chapitre_id, MAX(score) as score, MAX(total) as total FROM quiz_scores WHERE eleve_id = $1 GROUP BY chapitre_id', [e.id]);
      const notes = await pgAll('SELECT type, intitule, valeur, date FROM notes WHERE eleve_id = $1 ORDER BY date DESC', [e.id]);
      return {
        ...e,
        classe_nom: classe ? classe.nom : null,
        classe_niveau: classe ? classe.niveau : null,
        scores, notes,
        lastSeen: e.last_seen
      };
    }));
    // Tri équivalent à l'ancien ORDER BY c.nom, e.code : sans classe en dernier.
    result.sort((a, b) => (a.classe_nom || '￿').localeCompare(b.classe_nom || '￿') || a.code.localeCompare(b.code));
    return json(res, 200, result);
  }

  // ── Admin : Export CSV complet ──
  // GET /api/admin/export  (optionnel : ?classe_id=... pour limiter à une classe)
  if (p === '/api/admin/export' && method === 'GET') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });

    const classeIdFilter = url.searchParams.get('classe_id');
    let classeFilter = null;
    if (classeIdFilter) {
      classeFilter = db.prepare('SELECT * FROM classes WHERE id = ?').get(classeIdFilter);
      if (!classeFilter || classeFilter.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });
    }

    const eleves = classeFilter
      ? await pgAll('SELECT * FROM eleves WHERE admin_id = $1 AND classe_id = $2', [admin.id, classeIdFilter])
      : await pgAll('SELECT * FROM eleves WHERE admin_id = $1', [admin.id]);
    const classesById = classesMapParAdmin(admin.id);
    eleves.forEach(e => {
      const classe = e.classe_id ? classesById.get(e.classe_id) : null;
      e.classe_nom = classe ? classe.nom : null;
      e.classe_niveau = classe ? classe.niveau : null;
    });
    eleves.sort((a, b) => (a.classe_nom || '￿').localeCompare(b.classe_nom || '￿') || a.code.localeCompare(b.code));

    const chapitres = Array.from({length: 63}, (_, i) => i); // ch 0-20 Terminale, 21-44 Seconde, 45-62 Première

    let csv = 'Classe;Niveau;Code;Pseudo;Derniere_connexion;';
    csv += chapitres.map(i => `Ch${String(i).padStart(2,'0')}_meilleur_score`).join(';');
    csv += ';Nb_notes;Moyenne_notes\n';

    for (const e of eleves) {
      const scores = await pgAll('SELECT chapitre_id, MAX(score) as score FROM quiz_scores WHERE eleve_id = $1 GROUP BY chapitre_id', [e.id]);
      const notes = await pgAll('SELECT valeur FROM notes WHERE eleve_id = $1', [e.id]);
      const avgNote = notes.length ? (notes.reduce((a,b) => a + b.valeur, 0) / notes.length).toFixed(2) : '';

      const scoreMap = {};
      scores.forEach(s => scoreMap[s.chapitre_id] = s.score);

      const niveauLabelCsv = e.classe_niveau === '2nde' ? 'Seconde' : e.classe_niveau === '1ere' ? 'Première' : e.classe_niveau === 'tle' ? 'Terminale' : '';
      csv += `${e.classe_nom || 'Sans classe'};${niveauLabelCsv};${e.code};${e.pseudo};${e.last_seen};`;
      csv += chapitres.map(i => scoreMap[i] !== undefined ? scoreMap[i] : '').join(';');
      csv += `;${notes.length};${avgNote}\n`;
    }

    const slug = classeFilter
      ? '_' + classeFilter.nom.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      : '';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="physichim_export${slug}_${new Date().toISOString().slice(0,10)}.csv"`,
      'Access-Control-Allow-Origin': '*'
    });
    return res.end('﻿' + csv);
  }

  // ── Admin : Historique complet des tentatives de quiz d'un élève ──
  // GET /api/admin/eleves/:id/historique
  if (p.match(/^\/api\/admin\/eleves\/[^/]+\/historique$/) && method === 'GET') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await pgGet('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    const historique = await pgAll('SELECT chapitre_id, score, total, date FROM quiz_scores WHERE eleve_id = $1 ORDER BY date ASC', [eleveId]);
    return json(res, 200, historique);
  }

  // ── Admin : Réinitialiser les données d'un élève ──
  // POST /api/admin/eleves/:id/reset
  if (p.match(/^\/api\/admin\/eleves\/[^/]+\/reset$/) && method === 'POST') {
    const admin = getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await pgGet('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    await pgRun('DELETE FROM quiz_scores WHERE eleve_id = $1', [eleveId]);
    await pgRun('DELETE FROM notes WHERE eleve_id = $1', [eleveId]);
    await pgRun('DELETE FROM progression WHERE eleve_id = $1', [eleveId]);
    return json(res, 200, { ok: true });
  }

  // ── Health check ──
  if (p === '/health') {
    const elevesRow = await pgGet('SELECT COUNT(*)::int as n FROM eleves');
    return json(res, 200, { ok: true, uptime: process.uptime(), eleves: elevesRow.n });
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

(async () => {
  if (!STUDENT_DB_URL) {
    console.error('❌ STUDENT_DATABASE_URL (ou DATABASE_URL) non définie — la base élèves PostgreSQL est obligatoire.');
    console.error('   En local : installez PostgreSQL puis définissez par ex.');
    console.error('   STUDENT_DATABASE_URL=postgres://postgres:postgres@localhost:5432/physichim_eleves');
    process.exit(1);
  }
  try {
    pgPool = new Pool({ connectionString: STUDENT_DB_URL });
    await pgPool.query('SELECT 1'); // échoue vite si la base est injoignable
    await initPgDB();
    console.log('✅ Base de données élèves (PostgreSQL) initialisée');
  } catch (e) {
    console.error('❌ Erreur PostgreSQL (base élèves) :', e.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`🚀 PhysiChim Server — port ${PORT}`);
    console.log(`🔑 Clé admin : ${ADMIN_KEY}`);
    console.log(`📊 /api/admin/eleves — gestion des élèves`);
    console.log(`📥 /api/admin/export  — export CSV`);
  });
})();

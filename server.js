// ============================================================
// PhysiChim — Serveur Node.js + PostgreSQL (2 bases séparées)
// Déploiement : Render.com (service web) + Neon (Postgres, gratuit)
// ============================================================
//
// Deux bases PostgreSQL distinctes, volontairement séparées :
//   - APP_DATABASE_URL   : admins, classes, classe_chapitres
//     — la configuration de l'appli et des comptes enseignants.
//   - STUDENT_DATABASE_URL : eleves, quiz_scores, notes, progression, connexions, erreurs_quiz
//     — les données élèves proprement dites, isolées sur un service à part.
// Conséquence : impossible de faire un JOIN SQL entre une classe et ses élèves
// (bases différentes) ; ces jointures sont donc faites en mémoire, côté JS,
// après avoir interrogé les deux bases séparément.
// Aucun stockage sur disque local : Render (comme la plupart des hébergeurs
// gratuits) ne garantit pas de disque persistant, tout vit donc en base.

// Charge un .env local si présent (n'existe pas en production : Render fournit les
// variables d'environnement directement, ce require reste alors un no-op silencieux).
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { Pool } = require('pg');

// Petite fabrique de raccourcis .get()/.all()/.run(), pour garder le vocabulaire
// concis dans les routes et éviter de dupliquer ce code pour les deux pools.
function makeQueryHelpers(pool) {
  return {
    async get(sql, params = []) {
      const r = await pool.query(sql, params);
      return r.rows[0] || null;
    },
    async all(sql, params = []) {
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async run(sql, params = []) {
      return pool.query(sql, params);
    }
  };
}

// ── Base appli (admins, classes, classe_chapitres) ─────────────────────────
const APP_DB_URL = process.env.APP_DATABASE_URL;
let appPool, appDb;

async function initAppDB() {
  await appPool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      identifiant TEXT UNIQUE NOT NULL,
      code TEXT NOT NULL,
      nom TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      nom TEXT NOT NULL,
      niveau TEXT NOT NULL DEFAULT 'tle',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS classe_chapitres (
      classe_id TEXT NOT NULL REFERENCES classes(id),
      chapitre_id INTEGER NOT NULL,
      PRIMARY KEY (classe_id, chapitre_id)
    );

    -- Devoirs : un chapitre à travailler par toute une classe avant une date limite.
    -- date_limite est une date civile (AAAA-MM-JJ, sans heure) : le devoir est « à temps »
    -- jusqu'à la fin de cette journée, heure de Paris. created_at sert de point de départ :
    -- seul un quiz fait après l'assignation valide le devoir.
    CREATE TABLE IF NOT EXISTS devoirs (
      id TEXT PRIMARY KEY,
      classe_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      chapitre_id INTEGER NOT NULL,
      date_limite TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_devoirs_classe ON devoirs(classe_id);
  `);
}

// ── Base élèves (eleves, quiz_scores, notes, progression) ──────────────────
// Obligatoire, comme APP_DATABASE_URL : pas de repli silencieux, la séparation
// physique des données élèves est le but même de cette architecture.
const STUDENT_DB_URL = process.env.STUDENT_DATABASE_URL || process.env.DATABASE_URL;
let pgPool, studentDb;

async function initStudentDB() {
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

    -- Journal des connexions élève (une ligne par connexion réussie), distinct de
    -- eleves.last_seen (qui n'écrase qu'un seul horodatage) : nécessaire pour pouvoir
    -- compter un nombre de visites sur une période, pas seulement connaître la dernière.
    CREATE TABLE IF NOT EXISTS connexions (
      id SERIAL PRIMARY KEY,
      eleve_id TEXT NOT NULL REFERENCES eleves(id) ON DELETE CASCADE,
      date TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Erreurs fréquentes : une ligne par mauvaise réponse de quiz qui correspond à un
    -- « piège » connu (champ pieges des questions dans index.html). code = identifiant
    -- stable de l'erreur (survit à une reformulation du texte), texte = libellé affiché.
    -- date = celle du score enregistré dans le même envoi.
    CREATE TABLE IF NOT EXISTS erreurs_quiz (
      id SERIAL PRIMARY KEY,
      eleve_id TEXT NOT NULL REFERENCES eleves(id) ON DELETE CASCADE,
      chapitre_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      texte TEXT NOT NULL,
      date TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_erreurs_quiz_eleve_chapitre ON erreurs_quiz(eleve_id, chapitre_id, date);
    CREATE INDEX IF NOT EXISTS idx_connexions_date ON connexions(date);
    CREATE INDEX IF NOT EXISTS idx_quiz_scores_eleve ON quiz_scores(eleve_id);
    CREATE INDEX IF NOT EXISTS idx_notes_eleve ON notes(eleve_id);
    CREATE INDEX IF NOT EXISTS idx_eleves_admin ON eleves(admin_id);
  `);
}

// ── Utilitaires ───────────────────────────────────────────
// Clé maître : priorité à la variable d'environnement (obligatoire en production —
// sans disque persistant garanti, une génération locale ne survivrait pas à un
// redéploiement). En local uniquement, si elle n'est pas définie, on en génère une
// et on la persiste dans un fichier à côté du serveur, pour ne pas avoir à en
// choisir une à la main à chaque session de dev.
function resolveAdminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  const keyFile = path.join(__dirname, '.admin-key');
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

// ── Chapitres fusionnés ────────────────────────────────────
// Ancien id → id du chapitre qui l'a absorbé (même table dans index.html, avec le décalage
// des exercices pour les QR codes). L'ancien id n'existe plus : rien n'est plus enregistré dessus.
//   - Au démarrage, migrerChapitresFusionnes() rattache au nouvel id tout ce qui portait l'ancien.
//   - Ensuite, un ancien id reçu (page restée ouverte pendant la mise à jour, ancien lien) est
//     redirigé vers le nouvel id par chapitreIdActuel() à l'entrée des routes, puis contrôlé par
//     isChapitreIdValide(), qui refuse l'ancien id : une route oubliée refuserait au lieu d'écrire.
// Un id fusionné ne doit jamais être réutilisé pour un autre chapitre.
const CHAPITRES_FUSIONNES = {
  18: 2 // Ch.17 « Forcer une réaction chimique » → Ch.02 « Évolution spontanée et évolution forcée » (novembre 2026)
};
const estFusionne = (id) => Object.prototype.hasOwnProperty.call(CHAPITRES_FUSIONNES, id);

function chapitreIdActuel(id) {
  for (let n = 0; n < 10 && Number.isInteger(id) && estFusionne(id); n++) id = CHAPITRES_FUSIONNES[id];
  return id;
}

function chapitreIdsDuNiveau(niveau) {
  const range = NIVEAU_RANGES[niveau];
  if (!range) return [];
  const [a, b] = range;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i).filter(id => !estFusionne(id));
}

// Tous les chapitres existants, dans l'ordre des ids (colonnes de l'export CSV).
function tousLesChapitreIds() {
  return Object.keys(NIVEAU_RANGES).flatMap(chapitreIdsDuNiveau).sort((a, b) => a - b);
}

// Un chapitre_id reçu d'un élève doit correspondre à un chapitre existant d'un des niveaux
// (un id fusionné n'en est plus un : le passer d'abord par chapitreIdActuel()).
function isChapitreIdValide(id) {
  return Number.isInteger(id) && !estFusionne(id)
    && Object.values(NIVEAU_RANGES).some(([a, b]) => id >= a && id <= b);
}

// Rattache au chapitre actuel toutes les données d'un chapitre fusionné. Idempotente : relancée
// à chaque démarrage, elle ne trouve plus rien à déplacer (et rattrape une ligne qu'une ancienne
// instance du serveur aurait écrite sur l'ancien id pendant un déploiement).
// Une transaction par base : tout est déplacé, ou rien.
async function migrerChapitresFusionnes(pool, nomBase, etapes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bilan = [];
    for (const ancien of Object.keys(CHAPITRES_FUSIONNES).map(Number)) {
      const nouveau = chapitreIdActuel(ancien);
      for (const [nom, sql] of etapes) {
        const r = await client.query(sql, [ancien, nouveau]);
        if (r.rowCount) bilan.push(`${nom} ${ancien}→${nouveau} : ${r.rowCount}`);
      }
    }
    await client.query('COMMIT');
    if (bilan.length) console.log(`🔀 Chapitres fusionnés (base ${nomBase}) — ${bilan.join(', ')}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// $1 = ancien id, $2 = nouvel id.
const MIGRATION_FUSION_APPLI = [
  ['devoirs', 'UPDATE devoirs SET chapitre_id = $2 WHERE chapitre_id = $1'],
  // Une classe qui avait l'ancien chapitre autorisé obtient le nouveau (sans doublon de clé :
  // ON CONFLICT si elle l'avait déjà), puis la ligne de l'ancien chapitre est supprimée.
  ['classe_chapitres ajoutés', `INSERT INTO classe_chapitres (classe_id, chapitre_id)
     SELECT classe_id, $2 FROM classe_chapitres WHERE chapitre_id = $1 ON CONFLICT DO NOTHING`],
  ['classe_chapitres supprimés', 'DELETE FROM classe_chapitres WHERE chapitre_id = $1 AND chapitre_id <> $2'],
];
const MIGRATION_FUSION_ELEVES = [
  ['quiz_scores', 'UPDATE quiz_scores SET chapitre_id = $2 WHERE chapitre_id = $1'],
  ['progression', 'UPDATE progression SET chapitre_id = $2 WHERE chapitre_id = $1'],
  ['erreurs_quiz', 'UPDATE erreurs_quiz SET chapitre_id = $2 WHERE chapitre_id = $1'],
];

// ── Erreurs fréquentes aux quiz ────────────────────────────
// Mêmes règles que index.html (normaliserPiege) et l'outil quiz_tool.js du skill.
const PIEGE_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PIEGE_CODE_MAX = 60;
const PIEGE_TEXTE_MAX = 300;
const MAX_ERREURS_PAR_QUIZ = 10;

// Liste d'erreurs envoyée avec un score : [{ code, texte }]. Renvoie la liste nettoyée,
// [] si absente, ou null si quoi que ce soit est invalide (tout l'envoi est alors refusé).
// Pas plus d'erreurs que de mauvaises réponses (total - score).
function erreursQuizValides(erreurs, nbMauvaises) {
  if (erreurs === undefined) return [];
  if (!Array.isArray(erreurs) || erreurs.length > MAX_ERREURS_PAR_QUIZ || erreurs.length > nbMauvaises) return null;
  const out = [];
  for (const e of erreurs) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const { code, texte } = e;
    if (typeof code !== 'string' || code.length > PIEGE_CODE_MAX || !PIEGE_CODE_RE.test(code)) return null;
    if (typeof texte !== 'string') return null;
    const t = texte.trim();
    if (!t || t.length > PIEGE_TEXTE_MAX) return null;
    out.push({ code, texte: t });
  }
  return out;
}

// Niveaux déjà couverts avant celui-ci (ex: 'tle' -> ['2nde', '1ere'])
function niveauxPrecedents(niveau) {
  const idx = NIVEAU_ORDER.indexOf(niveau);
  return idx <= 0 ? [] : NIVEAU_ORDER.slice(0, idx);
}

// ── Devoirs ────────────────────────────────────────────────
// Un devoir non fait reste affiché « en retard » à l'élève pendant ce délai après la date limite.
const DEVOIR_AFFICHAGE_RETARD_JOURS = 14;

function isDateIso(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Instant (ms) où se termine la journée `dateIso` à Paris, quel que soit le fuseau du serveur.
function finJourneeParis(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const minuitUtc = Date.UTC(y, m - 1, d + 1);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(minuitUtc));
  const v = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  const decalage = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - minuitUtc;
  return minuitUtc - decalage;
}

// Statut d'un devoir pour un élève, à partir des dates de ses quiz sur ce chapitre :
//   a_temps   : quiz fait après l'assignation, avant la fin de la date limite
//   en_retard : quiz fait après l'assignation, mais après la date limite
//   a_faire   : pas encore fait, date limite pas dépassée
//   non_fait  : pas fait, date limite dépassée
function statutDevoir(devoir, datesQuiz, now) {
  const debut = new Date(devoir.created_at).getTime();
  const limite = finJourneeParis(devoir.date_limite);
  const premier = datesQuiz.map(d => new Date(d).getTime()).filter(t => t >= debut).sort((a, b) => a - b)[0];
  if (premier !== undefined) {
    return { statut: premier < limite ? 'a_temps' : 'en_retard', fait_le: new Date(premier).toISOString() };
  }
  return { statut: now < limite ? 'a_faire' : 'non_fait', fait_le: null };
}

// Devoirs à montrer à un élève : un devoir fait reste visible jusqu'à sa date limite,
// un devoir non fait reste visible (en retard) encore quelques jours après.
function devoirsPourEleve(devoirs, scores, now) {
  return devoirs.map(d => {
    const dates = scores.filter(s => s.chapitre_id === d.chapitre_id).map(s => s.date);
    return { id: d.id, chapitre_id: d.chapitre_id, date_limite: d.date_limite, ...statutDevoir(d, dates, now) };
  }).filter(d => {
    const limite = finJourneeParis(d.date_limite);
    const fait = d.statut === 'a_temps' || d.statut === 'en_retard';
    return now < (fait ? limite : limite + DEVOIR_AFFICHAGE_RETARD_JOURS * 86400000);
  });
}

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// ── Rate limiting simple en mémoire ─────────────────────────
// Protège les points de connexion contre le bourrinage (essayer plein de codes/mots
// de passe à la suite). Volontairement basique (pas de dépendance externe) : suffisant
// pour un usage scolaire, à revoir si l'appli est un jour exposée massivement. Se
// réinitialise à chaque redémarrage/réveil du service — acceptable ici.
const RATE_LIMIT_MAX_ATTEMPTS = 5;
// Connexion élève : seuil bien plus large, car tout un lycée sort sur Internet avec la
// même adresse IP — à 5, quelques codes mal tapés dans une salle bloquaient toute la
// classe pendant 15 minutes, y compris les élèves ayant le bon code.
const RATE_LIMIT_MAX_ATTEMPTS_ELEVE = 60;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const rateLimitBuckets = new Map();

// Limite supplémentaire par « préfixe » de code (les 2 initiales), qui ne dépend pas de
// l'adresse IP : même un attaquant qui change d'adresse ne peut pas essayer plus de
// 20 codes ratés par heure pour une même paire d'initiales. Elle ne vise que les anciens
// codes courts (2 lettres + 4 chiffres, 10 000 possibilités par paire) : les nouveaux codes
// longs sont hors de portée d'un essai systématique, et une attaque sur « ML » ne bloque
// donc jamais les élèves qui ont un code long. Les élèves d'une même classe ont des
// initiales variées : quelques fautes de frappe n'atteignent pas ce seuil.
const RATE_LIMIT_MAX_FAILS_PREFIXE = 20;
const RATE_LIMIT_WINDOW_PREFIXE_MS = 60 * 60 * 1000; // 1 heure
const ANCIEN_CODE_ELEVE = /^\p{L}{2}\d{4}$/u;

// Render passe par Cloudflare puis par son propre proxy : remoteAddress est l'adresse
// interne du proxy, et X-Forwarded-For n'est pas fiable, car Render garde la valeur
// envoyée par le client et y AJOUTE les maillons suivants. Sa PREMIÈRE valeur est donc
// choisie par le client (contournement de la limite), et la dernière est celle du relais
// Cloudflare, partagée par beaucoup de visiteurs.
// On lit donc CF-Connecting-IP, que Cloudflare remplit lui-même avec l'adresse du visiteur
// (et écrase si le client l'envoie) ; c'est ce que recommande le support de Render.
// À défaut (si Render retirait Cloudflare), la DERNIÈRE valeur de X-Forwarded-For, celle
// ajoutée par le proxy de Render ; et en local, remoteAddress.
let ipSourceLogged = false;
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const xff = req.headers['x-forwarded-for'];
  let source, ip;
  if (cf) { source = 'CF-Connecting-IP'; ip = String(cf).trim(); }
  else if (xff) { source = 'dernière valeur de X-Forwarded-For'; ip = String(xff).split(',').pop().trim(); }
  else { source = 'adresse de connexion directe'; ip = req.socket.remoteAddress; }
  if (!ipSourceLogged) {
    ipSourceLogged = true;
    // Une seule ligne par démarrage, sans l'adresse elle-même : permet de vérifier dans
    // les journaux Render quelle source est réellement utilisée en production.
    console.log(`🔒 Limite de tentatives : IP du visiteur lue depuis ${source}.`);
  }
  return ip || 'unknown';
}

function checkRateLimit(key, maxAttempts = RATE_LIMIT_MAX_ATTEMPTS) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) return { blocked: false };
  if (bucket.count >= maxAttempts) {
    return { blocked: true, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { blocked: false };
}

function recordFailedAttempt(key, windowMs = RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();
  // Ménage occasionnel des compteurs expirés, pour que la table ne grossisse pas
  // indéfiniment entre deux redémarrages.
  if (rateLimitBuckets.size > 5000) {
    for (const [k, b] of rateLimitBuckets) if (now > b.resetAt) rateLimitBuckets.delete(k);
  }
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    bucket.count++;
  }
}

function clearRateLimit(key) {
  rateLimitBuckets.delete(key);
}

// ── Clé maître (gestion des comptes enseignants uniquement) ──
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isSuperAdmin(req) {
  const auth = req.headers['authorization'] || '';
  return safeEqual(auth, `Bearer ${ADMIN_KEY}`);
}

// ── Codes enseignants : stockés hachés (scrypt + sel), jamais en clair ──
// Format en base : scrypt$<sel hex>$<empreinte hex>. Une fuite de la base ne révèle
// donc plus les codes (souvent réutilisés ailleurs par leurs propriétaires).
const scrypt = util.promisify(crypto.scrypt);
const CODE_HASH_PREFIX = 'scrypt$';

async function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(code, salt, 32)).toString('hex');
  return `${CODE_HASH_PREFIX}${salt}$${hash}`;
}

async function verifyCode(code, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const got = await scrypt(code, salt, expected.length || 32);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// Au démarrage : hache les codes encore en clair (comptes créés avant ce changement).
// Sans effet une fois tous les comptes migrés.
async function migrerCodesEnseignants() {
  const enClair = await appDb.all(`SELECT id, code FROM admins WHERE code NOT LIKE '${CODE_HASH_PREFIX}%'`);
  for (const a of enClair) {
    await appDb.run('UPDATE admins SET code = $1 WHERE id = $2', [await hashCode(a.code), a.id]);
  }
  if (enClair.length) console.log(`🔒 ${enClair.length} code(s) enseignant haché(s)`);
}

// ── Auth enseignant (identifiant + code) ──
// Token signé (HMAC-SHA256, secret = ADMIN_KEY) plutôt qu'un simple encodage : le
// payload ne contient que id+horodatage (jamais le code en clair), donc un token qui
// fuite (poste partagé, faille XSS future) n'expose pas le mot de passe enseignant.
// Expire après ADMIN_TOKEN_MAX_AGE_MS, forçant une reconnexion périodique.
const ADMIN_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function signPayload(payload) {
  return crypto.createHmac('sha256', ADMIN_KEY).update(payload).digest('hex');
}

function makeAdminToken(admin) {
  const payload = `${admin.id}:${Date.now()}`;
  return Buffer.from(payload, 'utf8').toString('base64') + '.' + signPayload(payload);
}

async function getAdminFromToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  const [encoded, sig] = m[1].split('.');
  if (!encoded || !sig) return null;
  let payload;
  try { payload = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return null; }
  const expected = signPayload(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [id, issuedAtStr] = payload.split(':');
  const issuedAt = parseInt(issuedAtStr, 10);
  if (!id || !Number.isFinite(issuedAt) || Date.now() - issuedAt > ADMIN_TOKEN_MAX_AGE_MS) return null;
  return appDb.get('SELECT * FROM admins WHERE id = $1', [id]);
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

// Neutralise l'injection de formule (=,+,-,@ en tête -> Excel/Sheets l'exécuterait) et
// entoure de guillemets si le champ contient le séparateur, des guillemets ou un saut de ligne.
function csvField(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[;"\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const MAX_BODY_CHARS = 100000;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // Aucune requête légitime n'approche cette taille : on coupe pour ne pas remplir la mémoire.
      if (body.length > MAX_BODY_CHARS) { body = ''; req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Pages HTML : lues une fois, puis servies avec une empreinte (ETag) ──
// Le navigateur garde la page (~935 Ko) et se contente de demander « a-t-elle changé ? » :
// si non, le serveur répond 304 sans renvoyer le contenu. Un nouveau déploiement change
// l'empreinte, donc les élèves reçoivent toujours la dernière version.
const pagesCache = new Map();
function servirPage(req, res, fichier) {
  let page = pagesCache.get(fichier);
  if (!page) {
    const htmlPath = path.join(__dirname, fichier);
    if (!fs.existsSync(htmlPath)) return json(res, 404, { error: `${fichier} introuvable` });
    const contenu = fs.readFileSync(htmlPath);
    page = { contenu, etag: '"' + crypto.createHash('sha1').update(contenu).digest('hex').slice(0, 20) + '"' };
    pagesCache.set(fichier, page);
  }
  const entetes = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': page.etag };
  const demande = (req.headers['if-none-match'] || '').replace(/^W\//, '');
  if (demande === page.etag) {
    res.writeHead(304, entetes);
    return res.end();
  }
  res.writeHead(200, entetes);
  return res.end(page.contenu);
}

// Regroupe des lignes SQL par valeur d'une colonne : Map { valeur -> [lignes] }.
function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
}

// Construit une map { classe_id -> classe } à partir de la base appli, pour fusionner
// en mémoire avec les élèves (base élèves) — remplace les anciens JOIN SQL devenus
// impossibles entre deux bases séparées.
async function classesMapParAdmin(adminId) {
  const classes = await appDb.all('SELECT * FROM classes WHERE admin_id = $1', [adminId]);
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
  if (p === '/' || p === '/index.html') return servirPage(req, res, 'index.html');

  // ── Servir l'interface admin ──
  if (p === '/admin' || p === '/admin.html') return servirPage(req, res, 'admin.html');

  // ── Réveil : répond sans toucher aux bases ──
  // Appelé régulièrement par la tâche GitHub « keep-alive » pour que Render ne mette pas
  // le service en veille. Ne réveille pas Neon, qui peut continuer à s'endormir sans gêne.
  if (p === '/ping') return json(res, 200, { ok: true });

  // ── API : Connexion élève par code ──
  // POST /api/login  { code: "E01" }
  if (p === '/api/login' && method === 'POST') {
    const rlKey = 'eleve-login:' + getClientIp(req);
    const rl = checkRateLimit(rlKey, RATE_LIMIT_MAX_ATTEMPTS_ELEVE);
    if (rl.blocked) return json(res, 429, { error: `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.` });

    const body = await parseBody(req);
    const code = String(body.code || '').toUpperCase().trim();
    if (!code) return json(res, 400, { error: 'Code manquant' });

    const rlKeyPrefixe = ANCIEN_CODE_ELEVE.test(code) ? 'eleve-login-prefixe:' + code.slice(0, 2) : null;
    if (rlKeyPrefixe) {
      const rlp = checkRateLimit(rlKeyPrefixe, RATE_LIMIT_MAX_FAILS_PREFIXE);
      if (rlp.blocked) return json(res, 429, { error: `Trop de tentatives pour ce code. Réessayez dans ${Math.ceil(rlp.retryAfterSec / 60)} min, ou demandez de l'aide à votre enseignant.` });
    }

    const eleve = await studentDb.get('SELECT * FROM eleves WHERE code = $1', [code]);
    if (!eleve) {
      recordFailedAttempt(rlKey);
      if (rlKeyPrefixe) recordFailedAttempt(rlKeyPrefixe, RATE_LIMIT_WINDOW_PREFIXE_MS);
      return json(res, 404, { error: 'Code inconnu. Demandez votre code à votre enseignant.' });
    }
    // Pas de remise à zéro du compteur ici : l'IP est partagée par tout l'établissement,
    // un seul code valide ne doit pas effacer les essais ratés des autres postes.

    await studentDb.run('UPDATE eleves SET last_seen = now() WHERE id = $1', [eleve.id]);
    await studentDb.run('INSERT INTO connexions (eleve_id) VALUES ($1)', [eleve.id]);

    const scores = await studentDb.all('SELECT chapitre_id, score, total, date FROM quiz_scores WHERE eleve_id = $1 ORDER BY date DESC', [eleve.id]);
    const notes = await studentDb.all('SELECT id, type, intitule, valeur, date FROM notes WHERE eleve_id = $1 ORDER BY date DESC', [eleve.id]);
    const progression = await studentDb.all('SELECT chapitre_id, action, date FROM progression WHERE eleve_id = $1 ORDER BY date DESC LIMIT 50', [eleve.id]);

    let classe = null;
    let chapitresAutorises = [];
    let devoirs = [];
    if (eleve.classe_id) {
      classe = await appDb.get('SELECT id, nom, niveau FROM classes WHERE id = $1', [eleve.classe_id]);
      if (classe) {
        const rows = await appDb.all('SELECT chapitre_id FROM classe_chapitres WHERE classe_id = $1', [eleve.classe_id]);
        chapitresAutorises = rows.map(r => r.chapitre_id);
        const devoirsClasse = await appDb.all('SELECT id, chapitre_id, date_limite, created_at FROM devoirs WHERE classe_id = $1 ORDER BY date_limite, created_at', [eleve.classe_id]);
        devoirs = devoirsPourEleve(devoirsClasse, scores, Date.now());
      }
    }

    return json(res, 200, {
      eleve: { id: eleve.id, code: eleve.code, pseudo: eleve.pseudo },
      classe, chapitresAutorises, devoirs,
      scores, notes, progression
    });
  }

  // ── API : Sauvegarder un score de quiz (et les erreurs fréquentes commises) ──
  // POST /api/quiz  { eleve_id, chapitre_id, score, total, erreurs?: [{ code, texte }] }
  if (p === '/api/quiz' && method === 'POST') {
    const body = await parseBody(req);
    const { eleve_id, score, total } = body;
    if (!eleve_id || body.chapitre_id === undefined || score === undefined) {
      return json(res, 400, { error: 'Données manquantes' });
    }
    const chapitre_id = chapitreIdActuel(body.chapitre_id); // ancien chapitre fusionné → chapitre actuel
    // Refuse les valeurs impossibles (999/10, texte, chapitre inexistant) : sans ce
    // contrôle elles étaient enregistrées telles quelles ou faisaient planter la requête.
    const totalQuiz = total === undefined ? 10 : total;
    if (typeof eleve_id !== 'string' || !isChapitreIdValide(chapitre_id)
      || !Number.isInteger(totalQuiz) || totalQuiz < 1 || totalQuiz > 100
      || !Number.isInteger(score) || score < 0 || score > totalQuiz) {
      return json(res, 400, { error: 'Données invalides' });
    }
    const erreurs = erreursQuizValides(body.erreurs, totalQuiz - score);
    if (!erreurs) return json(res, 400, { error: 'Données invalides' });
    const eleve = await studentDb.get('SELECT id FROM eleves WHERE id = $1', [eleve_id]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });

    if (erreurs.length) {
      // Une seule requête : score et erreurs sont enregistrés ensemble ou pas du tout
      // (sinon un échec sur les erreurs, suivi d'un « Réessayer », doublerait le score).
      await studentDb.run(
        `WITH s AS (
           INSERT INTO quiz_scores (eleve_id, chapitre_id, score, total) VALUES ($1, $2, $3, $4) RETURNING date
         )
         INSERT INTO erreurs_quiz (eleve_id, chapitre_id, code, texte, date)
         SELECT $1, $2, x.code, x.texte, (SELECT date FROM s) FROM unnest($5::text[], $6::text[]) AS x(code, texte)`,
        [eleve_id, chapitre_id, score, totalQuiz, erreurs.map(e => e.code), erreurs.map(e => e.texte)]
      );
    } else {
      await studentDb.run('INSERT INTO quiz_scores (eleve_id, chapitre_id, score, total) VALUES ($1, $2, $3, $4)', [eleve_id, chapitre_id, score, totalQuiz]);
    }
    await studentDb.run('UPDATE eleves SET last_seen = now() WHERE id = $1', [eleve_id]);

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
    if (typeof eleve_id !== 'string' || typeof type !== 'string' || type.length > 40
      || typeof intitule !== 'string' || intitule.length > 120
      || typeof valeur !== 'number' || !Number.isFinite(valeur) || valeur < 0 || valeur > 20) {
      return json(res, 400, { error: 'Données invalides (note attendue entre 0 et 20)' });
    }
    const eleve = await studentDb.get('SELECT id FROM eleves WHERE id = $1', [eleve_id]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });

    const inserted = await studentDb.get('INSERT INTO notes (eleve_id, type, intitule, valeur) VALUES ($1, $2, $3, $4) RETURNING id', [eleve_id, type, intitule, valeur]);
    return json(res, 201, { ok: true, id: inserted.id });
  }

  // ── API : Supprimer une note ──
  // DELETE /api/notes/:id
  if (p.match(/^\/api\/notes\/[^/]+$/) && method === 'DELETE') {
    const noteId = p.split('/')[3];
    const body = await parseBody(req);
    const note = await studentDb.get('SELECT * FROM notes WHERE id = $1', [noteId]);
    if (!note) return json(res, 404, { error: 'Note introuvable' });
    if (note.eleve_id !== body.eleve_id && !isSuperAdmin(req)) {
      return json(res, 403, { error: 'Non autorisé' });
    }
    await studentDb.run('DELETE FROM notes WHERE id = $1', [noteId]);
    return json(res, 200, { ok: true });
  }

  // ── API : Enregistrer une progression ──
  // POST /api/progression  { eleve_id, chapitre_id, action }
  if (p === '/api/progression' && method === 'POST') {
    const body = await parseBody(req);
    const { eleve_id, action } = body;
    if (!eleve_id || body.chapitre_id === undefined || !action) {
      return json(res, 400, { error: 'Données manquantes' });
    }
    const chapitre_id = chapitreIdActuel(body.chapitre_id); // ancien chapitre fusionné → chapitre actuel
    if (typeof eleve_id !== 'string' || !isChapitreIdValide(chapitre_id)
      || typeof action !== 'string' || action.length > 60) {
      return json(res, 400, { error: 'Données invalides' });
    }
    const eleve = await studentDb.get('SELECT id FROM eleves WHERE id = $1', [eleve_id]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    await studentDb.run('INSERT INTO progression (eleve_id, chapitre_id, action) VALUES ($1, $2, $3)', [eleve_id, chapitre_id, action]);
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

    const admin = await appDb.get('SELECT * FROM admins WHERE identifiant = $1', [identifiant]);
    if (!admin || !(await verifyCode(code, admin.code))) {
      recordFailedAttempt(rlKey);
      return json(res, 401, { error: 'Identifiant ou code incorrect' });
    }
    clearRateLimit(rlKey);

    await appDb.run('UPDATE admins SET last_seen = now() WHERE id = $1', [admin.id]);

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

    // Limite de comptes + unicité de l'identifiant vérifiées dans la requête d'insertion
    // elle-même (WHERE ... < MAX_ADMINS + contrainte UNIQUE) plutôt que par un
    // COUNT/SELECT préalable séparé : deux créations concurrentes ne peuvent donc plus
    // dépasser la limite (le check-then-insert précédent n'était pas atomique).
    const id = genId();
    let inserted;
    try {
      inserted = await appDb.get(
        `INSERT INTO admins (id, identifiant, code, nom)
         SELECT $1, $2, $3, $4 WHERE (SELECT COUNT(*) FROM admins) < $5
         RETURNING id`,
        [id, identifiant, await hashCode(code), nom, MAX_ADMINS]
      );
    } catch (e) {
      if (e.code === '23505') return json(res, 409, { error: 'Cet identifiant existe déjà' });
      throw e;
    }
    if (!inserted) return json(res, 409, { error: `Limite de ${MAX_ADMINS} comptes enseignants atteinte` });
    return json(res, 201, { ok: true, id, identifiant, nom });
  }

  // ── Rapport d'activité globale (toutes classes, tous enseignants) ──
  // GET /api/admin/rapport-activite  (optionnel : ?depuis=ISO&jusqua=ISO, sinon 7 derniers jours)
  if (p === '/api/admin/rapport-activite' && method === 'GET') {
    const rlKeySuper = 'superadmin-login:' + getClientIp(req);
    const rlSuper = checkRateLimit(rlKeySuper);
    if (rlSuper.blocked) return json(res, 429, { error: `Trop de tentatives. Réessayez dans ${Math.ceil(rlSuper.retryAfterSec / 60)} min.` });
    if (!isSuperAdmin(req)) {
      recordFailedAttempt(rlKeySuper);
      return json(res, 401, { error: 'Clé maître requise' });
    }
    clearRateLimit(rlKeySuper);

    const jusquaParam = url.searchParams.get('jusqua');
    const depuisParam = url.searchParams.get('depuis');
    const jusqua = jusquaParam ? new Date(jusquaParam) : new Date();
    const depuis = depuisParam ? new Date(depuisParam) : new Date(jusqua.getTime() - 7 * 24 * 60 * 60 * 1000);

    const visitesRow = await studentDb.get(
      'SELECT COUNT(*)::int as n FROM connexions WHERE date >= $1 AND date < $2',
      [depuis.toISOString(), jusqua.toISOString()]
    );
    const quizRows = await studentDb.all(
      'SELECT eleve_id, COUNT(*)::int as nb_quiz FROM quiz_scores WHERE date >= $1 AND date < $2 GROUP BY eleve_id',
      [depuis.toISOString(), jusqua.toISOString()]
    );
    const connexionRows = await studentDb.all(
      'SELECT eleve_id, COUNT(*)::int as nb_connexions FROM connexions WHERE date >= $1 AND date < $2 GROUP BY eleve_id',
      [depuis.toISOString(), jusqua.toISOString()]
    );
    const quizMap = new Map(quizRows.map(r => [r.eleve_id, r.nb_quiz]));
    const connexionMap = new Map(connexionRows.map(r => [r.eleve_id, r.nb_connexions]));

    // Tous les élèves sont inclus (même à 0 activité) : un élève inactif sur la
    // période est une information utile pour l'enseignant, pas un cas à masquer.
    const eleves = await studentDb.all('SELECT id, code, pseudo, classe_id, admin_id FROM eleves');
    const classes = await appDb.all('SELECT id, nom, admin_id FROM classes');
    const classesById = new Map(classes.map(c => [c.id, c]));
    const admins = await appDb.all('SELECT id, nom FROM admins');
    const adminsById = new Map(admins.map(a => [a.id, a]));

    const result = eleves.map(e => {
      const classe = e.classe_id ? classesById.get(e.classe_id) : null;
      const admin = adminsById.get(e.admin_id) || (classe ? adminsById.get(classe.admin_id) : null);
      return {
        pseudo: e.pseudo,
        code: e.code,
        classe: classe ? classe.nom : 'Sans classe',
        professeur: admin ? admin.nom : '',
        nbQuiz: quizMap.get(e.id) || 0,
        nbConnexions: connexionMap.get(e.id) || 0
      };
    });
    result.sort((a, b) => a.classe.localeCompare(b.classe) || a.pseudo.localeCompare(b.pseudo));

    return json(res, 200, {
      periode: { depuis: depuis.toISOString(), jusqua: jusqua.toISOString() },
      visitesGlobales: visitesRow.n,
      eleves: result
    });
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
    const admins = await appDb.all('SELECT id, identifiant, nom, created_at, last_seen FROM admins ORDER BY identifiant');
    // Élèves comptés par admin_id (et non par classe) : ceux dont la classe a été
    // supprimée restent rattachés à leur enseignant et doivent être comptés ici.
    const result = await Promise.all(admins.map(async a => {
      const nbClassesRow = await appDb.get('SELECT COUNT(*)::int as n FROM classes WHERE admin_id = $1', [a.id]);
      const nbElevesRow = await studentDb.get('SELECT COUNT(*)::int as n FROM eleves WHERE admin_id = $1', [a.id]);
      return { ...a, nbClasses: nbClassesRow.n, nbEleves: nbElevesRow.n };
    }));
    // Élèves « fantômes » : rattachés à un compte enseignant qui n'existe plus (ou à aucun).
    // Invisibles pour tout le monde tant qu'ils ne sont pas repris par un enseignant.
    const orphelinsRow = await studentDb.get(
      'SELECT COUNT(*)::int as n FROM eleves WHERE admin_id IS NULL OR NOT (admin_id = ANY($1::text[]))',
      [admins.map(a => a.id)]
    );
    res.setHeader('X-Eleves-Sans-Enseignant', String(orphelinsRow.n));
    return json(res, 200, result);
  }

  // ── Rattacher les élèves sans enseignant à un compte existant ──
  // POST /api/admin/teachers/:id/reprendre-orphelins
  if (p.match(/^\/api\/admin\/teachers\/[^/]+\/reprendre-orphelins$/) && method === 'POST') {
    if (!isSuperAdmin(req)) return json(res, 401, { error: 'Clé maître requise' });
    const adminId = p.split('/')[4];
    const cible = await appDb.get('SELECT id FROM admins WHERE id = $1', [adminId]);
    if (!cible) return json(res, 404, { error: 'Compte enseignant introuvable' });
    const admins = await appDb.all('SELECT id FROM admins');
    const classes = await appDb.all('SELECT id FROM classes');
    // La classe d'origine n'existe plus forcément : on détache alors l'élève, que
    // l'enseignant réaffectera depuis son onglet Élèves (« Assigner à… »).
    await studentDb.run(
      'UPDATE eleves SET classe_id = NULL WHERE (admin_id IS NULL OR NOT (admin_id = ANY($1::text[]))) AND classe_id IS NOT NULL AND NOT (classe_id = ANY($2::text[]))',
      [admins.map(a => a.id), classes.map(c => c.id)]
    );
    const r = await studentDb.run(
      'UPDATE eleves SET admin_id = $1 WHERE admin_id IS NULL OR NOT (admin_id = ANY($2::text[]))',
      [adminId, admins.map(a => a.id)]
    );
    return json(res, 200, { ok: true, nbRepris: r.rowCount });
  }

  // ── Supprimer un compte enseignant (et ses classes) ──
  // DELETE /api/admin/teachers/:id
  if (p.match(/^\/api\/admin\/teachers\/[^/]+$/) && method === 'DELETE') {
    if (!isSuperAdmin(req)) return json(res, 401, { error: 'Clé maître requise' });
    const adminId = p.split('/')[4];
    const admin = await appDb.get('SELECT id FROM admins WHERE id = $1', [adminId]);
    if (!admin) return json(res, 404, { error: 'Compte enseignant introuvable' });

    // Un compte qui a encore des élèves ne peut être supprimé qu'en les transférant
    // (avec ses classes) à un autre enseignant : sinon ils resteraient rattachés à un
    // compte inexistant, invisibles pour tous, avec des codes bloqués à jamais.
    const cibleId = url.searchParams.get('transferer_a');
    const nbElevesRow = await studentDb.get('SELECT COUNT(*)::int as n FROM eleves WHERE admin_id = $1', [adminId]);
    if (nbElevesRow.n > 0 && !cibleId) {
      return json(res, 409, { error: `Ce compte a encore ${nbElevesRow.n} élève(s) : choisissez l'enseignant qui les reprend.`, nbEleves: nbElevesRow.n });
    }
    if (cibleId) {
      if (cibleId === adminId) return json(res, 400, { error: 'Le compte de reprise doit être un autre enseignant' });
      const cible = await appDb.get('SELECT id FROM admins WHERE id = $1', [cibleId]);
      if (!cible) return json(res, 404, { error: 'Compte de reprise introuvable' });
      await appDb.run('UPDATE classes SET admin_id = $1 WHERE admin_id = $2', [cibleId, adminId]);
      await studentDb.run('UPDATE eleves SET admin_id = $1 WHERE admin_id = $2', [cibleId, adminId]);
    } else {
      const classeRows = await appDb.all('SELECT id FROM classes WHERE admin_id = $1', [adminId]);
      const classeIds = classeRows.map(c => c.id);
      if (classeIds.length) {
        await appDb.run('DELETE FROM classe_chapitres WHERE classe_id = ANY($1::text[])', [classeIds]);
      }
      await appDb.run('DELETE FROM classes WHERE admin_id = $1', [adminId]);
    }
    await appDb.run('DELETE FROM admins WHERE id = $1', [adminId]);
    return json(res, 200, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // ROUTES CLASSES (scoped à l'enseignant connecté)
  // ══════════════════════════════════════════════════════════

  // ── Créer une classe ──
  // POST /api/admin/classes  { nom, niveau }
  if (p === '/api/admin/classes' && method === 'POST') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const body = await parseBody(req);
    const nom = (body.nom || '').trim();
    const niveau = body.niveau;
    if (!nom) return json(res, 400, { error: 'Nom de classe requis' });
    if (!isNiveauValide(niveau)) return json(res, 400, { error: 'Niveau invalide (2nde, 1ere ou tle attendu)' });

    const id = genId();
    await appDb.run('INSERT INTO classes (id, admin_id, nom, niveau) VALUES ($1, $2, $3, $4)', [id, admin.id, nom, niveau]);

    // Pré-autorise automatiquement les chapitres des années précédentes (déjà vues) —
    // seul le programme de l'année en cours démarre décoché, à activer au fil de l'année.
    const chapitresPreAutorises = niveauxPrecedents(niveau).flatMap(chapitreIdsDuNiveau);
    for (const cid of chapitresPreAutorises) {
      await appDb.run('INSERT INTO classe_chapitres (classe_id, chapitre_id) VALUES ($1, $2)', [id, cid]);
    }

    return json(res, 201, { ok: true, id, nom, niveau, chapitresAutorises: chapitresPreAutorises });
  }

  // ── Liste des classes de l'enseignant ──
  // GET /api/admin/classes
  if (p === '/api/admin/classes' && method === 'GET') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });

    const classes = await appDb.all('SELECT * FROM classes WHERE admin_id = $1 ORDER BY nom', [admin.id]);
    // Deux requêtes pour toutes les classes (au lieu de deux par classe).
    const classeIds = classes.map(c => c.id);
    const nbRows = await studentDb.all('SELECT classe_id, COUNT(*)::int as n FROM eleves WHERE classe_id = ANY($1::text[]) GROUP BY classe_id', [classeIds]);
    const nbParClasse = new Map(nbRows.map(r => [r.classe_id, r.n]));
    const chapParClasse = groupBy(
      await appDb.all('SELECT classe_id, chapitre_id FROM classe_chapitres WHERE classe_id = ANY($1::text[])', [classeIds]),
      'classe_id'
    );
    const result = classes.map(c => ({
      ...c,
      nbEleves: nbParClasse.get(c.id) || 0,
      chapitresAutorises: (chapParClasse.get(c.id) || []).map(r => r.chapitre_id)
    }));
    return json(res, 200, result);
  }

  // ── Définir les chapitres autorisés pour une classe ──
  // PUT /api/admin/classes/:id/chapitres  { chapitre_ids: [0,1,2] }
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/chapitres$/) && method === 'PUT') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const body = await parseBody(req);
    // Ancien chapitre fusionné → chapitre actuel (page enseignant restée ouverte), sans doublon ;
    // un id qui ne correspond à aucun chapitre existant est ignoré.
    const ids = Array.isArray(body.chapitre_ids)
      ? [...new Set(body.chapitre_ids.filter(Number.isInteger).map(chapitreIdActuel))].filter(isChapitreIdValide)
      : [];

    await appDb.run('DELETE FROM classe_chapitres WHERE classe_id = $1', [classeId]);
    for (const cid of ids) {
      await appDb.run('INSERT INTO classe_chapitres (classe_id, chapitre_id) VALUES ($1, $2)', [classeId, cid]);
    }

    return json(res, 200, { ok: true, chapitresAutorises: ids });
  }

  // ── Promouvoir une classe au niveau supérieur (fin d'année) ──
  // POST /api/admin/classes/:id/promouvoir
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/promouvoir$/) && method === 'POST') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const idx = NIVEAU_ORDER.indexOf(classe.niveau);
    if (idx === -1 || idx >= NIVEAU_ORDER.length - 1) {
      return json(res, 400, { error: 'Cette classe est déjà au niveau maximal (Terminale)' });
    }
    const nouveauNiveau = NIVEAU_ORDER[idx + 1];
    await appDb.run('UPDATE classes SET niveau = $1 WHERE id = $2', [nouveauNiveau, classeId]);

    // Le programme de l'année qui vient de se terminer est désormais entièrement « déjà vu » :
    // on l'auto-autorise en totalité, comme les années précédentes le sont à la création d'une classe.
    for (const cid of chapitreIdsDuNiveau(classe.niveau)) {
      await appDb.run('INSERT INTO classe_chapitres (classe_id, chapitre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [classeId, cid]);
    }

    const rows = await appDb.all('SELECT chapitre_id FROM classe_chapitres WHERE classe_id = $1', [classeId]);
    return json(res, 200, { ok: true, niveau: nouveauNiveau, chapitresAutorises: rows.map(r => r.chapitre_id) });
  }

  // ── Supprimer une classe ──
  // DELETE /api/admin/classes/:id
  if (p.match(/^\/api\/admin\/classes\/[^/]+$/) && method === 'DELETE') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    await studentDb.run('UPDATE eleves SET classe_id = NULL WHERE classe_id = $1', [classeId]);
    await appDb.run('DELETE FROM classe_chapitres WHERE classe_id = $1', [classeId]);
    await appDb.run('DELETE FROM classes WHERE id = $1', [classeId]);
    return json(res, 200, { ok: true });
  }

  // ══════════════════════════════════════════════════════════
  // ROUTES DEVOIRS (scoped à l'enseignant connecté)
  // ══════════════════════════════════════════════════════════

  // ── Donner un devoir à une classe ──
  // POST /api/admin/classes/:id/devoirs  { chapitre_id, date_limite: "AAAA-MM-JJ" }
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/devoirs$/) && method === 'POST') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const body = await parseBody(req);
    const { date_limite } = body;
    const chapitre_id = chapitreIdActuel(body.chapitre_id); // ancien chapitre fusionné → chapitre actuel
    const chapitresDeLaClasse = [...niveauxPrecedents(classe.niveau), classe.niveau].flatMap(chapitreIdsDuNiveau);
    if (!Number.isInteger(chapitre_id) || !chapitresDeLaClasse.includes(chapitre_id)) {
      return json(res, 400, { error: 'Chapitre invalide pour cette classe' });
    }
    if (!isDateIso(date_limite)) return json(res, 400, { error: 'Date limite invalide (AAAA-MM-JJ attendu)' });

    const id = genId();
    await appDb.run('INSERT INTO devoirs (id, classe_id, chapitre_id, date_limite) VALUES ($1, $2, $3, $4)', [id, classeId, chapitre_id, date_limite]);
    // Un devoir sur un chapitre verrouillé serait infaisable : on l'ouvre à la classe.
    await appDb.run('INSERT INTO classe_chapitres (classe_id, chapitre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [classeId, chapitre_id]);
    return json(res, 201, { ok: true, id, chapitre_id, date_limite });
  }

  // ── Devoirs d'une classe, avec le suivi élève par élève ──
  // GET /api/admin/classes/:id/devoirs
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/devoirs$/) && method === 'GET') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const devoirs = await appDb.all('SELECT id, chapitre_id, date_limite, created_at FROM devoirs WHERE classe_id = $1 ORDER BY date_limite DESC, created_at DESC', [classeId]);
    if (!devoirs.length) return json(res, 200, []);

    const eleves = await studentDb.all('SELECT id, code, pseudo FROM eleves WHERE classe_id = $1 ORDER BY pseudo', [classeId]);
    const tentatives = groupBy(
      await studentDb.all(
        'SELECT eleve_id, chapitre_id, date FROM quiz_scores WHERE eleve_id = ANY($1::text[]) AND chapitre_id = ANY($2::int[])',
        [eleves.map(e => e.id), [...new Set(devoirs.map(d => d.chapitre_id))]]
      ),
      'eleve_id'
    );
    const now = Date.now();
    const result = devoirs.map(d => {
      const suivi = eleves.map(e => {
        const dates = (tentatives.get(e.id) || []).filter(t => t.chapitre_id === d.chapitre_id).map(t => t.date);
        return { id: e.id, code: e.code, pseudo: e.pseudo, ...statutDevoir(d, dates, now) };
      });
      const compte = { a_temps: 0, en_retard: 0, a_faire: 0, non_fait: 0 };
      suivi.forEach(s => compte[s.statut]++);
      return { ...d, compte, eleves: suivi };
    });
    return json(res, 200, result);
  }

  // ══════════════════════════════════════════════════════════
  // ERREURS FRÉQUENTES AUX QUIZ (scoped à l'enseignant connecté)
  // ══════════════════════════════════════════════════════════

  // ── Erreurs fréquentes d'une classe ──
  // GET /api/admin/classes/:id/erreurs?periode=tout|30j[&chapitre_id=7]
  // Toujours : par chapitre, le nombre d'élèves distincts de la classe ayant commis au moins
  // une erreur repérée. Avec chapitre_id : chaque erreur de ce chapitre, avec le nombre et le
  // pourcentage d'élèves distincts concernés et leur liste, triée par fréquence.
  if (p.match(/^\/api\/admin\/classes\/[^/]+\/erreurs$/) && method === 'GET') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const classeId = p.split('/')[4];
    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const periode = url.searchParams.get('periode') || 'tout';
    if (periode !== 'tout' && periode !== '30j') return json(res, 400, { error: 'Période invalide (tout ou 30j)' });
    const chapitreParam = url.searchParams.get('chapitre_id');
    const chapitreId = chapitreParam === null ? null : chapitreIdActuel(Number(chapitreParam));
    if (chapitreParam !== null && (!/^\d{1,3}$/.test(chapitreParam) || !isChapitreIdValide(chapitreId))) {
      return json(res, 400, { error: 'Chapitre invalide' });
    }
    const depuis = periode === '30j' ? new Date(Date.now() - 30 * 86400000).toISOString() : null;

    const eleves = await studentDb.all('SELECT id, code, pseudo FROM eleves WHERE classe_id = $1 ORDER BY pseudo', [classeId]);
    const eleveIds = eleves.map(e => e.id);
    const nbEleves = eleves.length;
    const pct = n => (nbEleves ? Math.round((100 * n) / nbEleves) : 0);

    const parChapitre = await studentDb.all(
      `SELECT chapitre_id, COUNT(DISTINCT eleve_id)::int AS nb_eleves, COUNT(*)::int AS nb_erreurs
       FROM erreurs_quiz WHERE eleve_id = ANY($1::text[]) AND ($2::timestamptz IS NULL OR date >= $2)
       GROUP BY chapitre_id ORDER BY nb_eleves DESC, chapitre_id`,
      [eleveIds, depuis]
    );
    const result = {
      classe: { id: classe.id, nom: classe.nom, niveau: classe.niveau },
      periode, nbEleves,
      chapitres: parChapitre.map(c => ({ ...c, pct: pct(c.nb_eleves) })),
      chapitre: null
    };

    if (chapitreId !== null) {
      const rows = await studentDb.all(
        `SELECT eleve_id, code, texte, date FROM erreurs_quiz
         WHERE eleve_id = ANY($1::text[]) AND chapitre_id = $2 AND ($3::timestamptz IS NULL OR date >= $3)
         ORDER BY date DESC`,
        [eleveIds, chapitreId, depuis]
      );
      const quizRow = await studentDb.get(
        `SELECT COUNT(DISTINCT eleve_id)::int AS n FROM quiz_scores
         WHERE eleve_id = ANY($1::text[]) AND chapitre_id = $2 AND ($3::timestamptz IS NULL OR date >= $3)`,
        [eleveIds, chapitreId, depuis]
      );
      const elevesById = new Map(eleves.map(e => [e.id, e]));
      const parCode = new Map();
      for (const r of rows) {
        if (!parCode.has(r.code)) parCode.set(r.code, { code: r.code, textes: new Map(), eleves: new Map(), nb_fois: 0 });
        const g = parCode.get(r.code);
        g.nb_fois++;
        g.textes.set(r.texte, (g.textes.get(r.texte) || 0) + 1); // lignes triées par date décroissante
        g.eleves.set(r.eleve_id, (g.eleves.get(r.eleve_id) || 0) + 1);
      }
      const erreurs = [...parCode.values()].map(g => {
        // Libellé : le plus fréquent ; à égalité, le plus court, en général la formulation
        // générale plutôt que le calcul erroné d'une question précise (même code dans plusieurs questions).
        const texte = [...g.textes.entries()]
          .reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0].length < a[0].length) ? b : a))[0];
        const liste = [...g.eleves.entries()]
          .map(([id, nb]) => ({ id, code: elevesById.get(id).code, pseudo: elevesById.get(id).pseudo, nb_fois: nb }))
          .sort((a, b) => b.nb_fois - a.nb_fois || a.pseudo.localeCompare(b.pseudo));
        return { code: g.code, texte, nb_eleves: liste.length, pct: pct(liste.length), nb_fois: g.nb_fois, eleves: liste };
      }).sort((a, b) => b.nb_eleves - a.nb_eleves || b.nb_fois - a.nb_fois || a.code.localeCompare(b.code));
      result.chapitre = { chapitre_id: chapitreId, nb_eleves_quiz: quizRow ? quizRow.n : 0, erreurs };
    }
    return json(res, 200, result);
  }

  // ── Changer la date limite d'un devoir ──
  // PUT /api/admin/devoirs/:id  { date_limite }
  // ── Supprimer un devoir ──
  // DELETE /api/admin/devoirs/:id
  if (p.match(/^\/api\/admin\/devoirs\/[^/]+$/) && (method === 'PUT' || method === 'DELETE')) {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const devoirId = p.split('/')[4];
    const devoir = await appDb.get('SELECT d.id, c.admin_id FROM devoirs d JOIN classes c ON c.id = d.classe_id WHERE d.id = $1', [devoirId]);
    if (!devoir || devoir.admin_id !== admin.id) return json(res, 404, { error: 'Devoir introuvable' });

    if (method === 'DELETE') {
      await appDb.run('DELETE FROM devoirs WHERE id = $1', [devoirId]);
      return json(res, 200, { ok: true });
    }
    const body = await parseBody(req);
    if (!isDateIso(body.date_limite)) return json(res, 400, { error: 'Date limite invalide (AAAA-MM-JJ attendu)' });
    await appDb.run('UPDATE devoirs SET date_limite = $1 WHERE id = $2', [body.date_limite, devoirId]);
    return json(res, 200, { ok: true, date_limite: body.date_limite });
  }

  // ══════════════════════════════════════════════════════════
  // ROUTES ÉLÈVES (gestion, scoped à l'enseignant connecté)
  // ══════════════════════════════════════════════════════════

  // ── Créer un élève dans une classe ──
  // POST /api/admin/eleves  { code, pseudo, classe_id }
  if (p === '/api/admin/eleves' && method === 'POST') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const body = await parseBody(req);
    const code = (body.code || '').toUpperCase().trim();
    const pseudo = (body.pseudo || code).trim();
    const classeId = (body.classe_id || '').trim();
    if (!code) return json(res, 400, { error: 'Code manquant' });
    if (!classeId) return json(res, 400, { error: 'Classe manquante' });

    const classe = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeId]);
    if (!classe || classe.admin_id !== admin.id) return json(res, 404, { error: 'Classe introuvable' });

    const existing = await studentDb.get('SELECT id FROM eleves WHERE code = $1', [code]);
    if (existing) return json(res, 409, { error: 'Ce code existe déjà' });

    const id = genId();
    await studentDb.run('INSERT INTO eleves (id, code, pseudo, classe_id, admin_id) VALUES ($1, $2, $3, $4, $5)', [id, code, pseudo, classeId, admin.id]);
    return json(res, 201, { ok: true, id, code, pseudo, classe_id: classeId });
  }

  // ── Déplacer un élève vers une autre classe du même enseignant ──
  // PUT /api/admin/eleves/:id/classe  { classe_id }
  if (p.match(/^\/api\/admin\/eleves\/[^/]+\/classe$/) && method === 'PUT') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await studentDb.get('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    const body = await parseBody(req);
    const newClasseId = (body.classe_id || '').trim();
    const newClasse = await appDb.get('SELECT * FROM classes WHERE id = $1', [newClasseId]);
    if (!newClasse || newClasse.admin_id !== admin.id) return json(res, 404, { error: 'Classe cible introuvable' });

    await studentDb.run('UPDATE eleves SET classe_id = $1 WHERE id = $2', [newClasseId, eleveId]);
    return json(res, 200, { ok: true });
  }

  // ── Supprimer un élève ──
  // DELETE /api/admin/eleves/:id
  if (p.match(/^\/api\/admin\/eleves\/[^/]+$/) && method === 'DELETE') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await studentDb.get('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    // ON DELETE CASCADE (Postgres) nettoie automatiquement quiz_scores/notes/progression,
    // connexions et erreurs_quiz.
    await studentDb.run('DELETE FROM eleves WHERE id = $1', [eleveId]);
    return json(res, 200, { ok: true });
  }

  // ── Liste des élèves de l'enseignant (toutes ses classes) ──
  // GET /api/admin/eleves
  if (p === '/api/admin/eleves' && method === 'GET') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });

    // classe_id = NULL (classe supprimée) : l'élève reste rattaché à son enseignant via
    // admin_id et doit rester visible ici plutôt que de disparaître silencieusement.
    const eleves = await studentDb.all('SELECT * FROM eleves WHERE admin_id = $1', [admin.id]);
    const classesById = await classesMapParAdmin(admin.id);

    // Deux requêtes pour tous les élèves (au lieu de deux par élève : plus de 200
    // allers-retours vers la base à chaque ouverture du tableau de bord).
    const eleveIds = eleves.map(e => e.id);
    const scoresParEleve = groupBy(
      await studentDb.all('SELECT eleve_id, chapitre_id, MAX(score) as score, MAX(total) as total FROM quiz_scores WHERE eleve_id = ANY($1::text[]) GROUP BY eleve_id, chapitre_id', [eleveIds]),
      'eleve_id'
    );
    const notesParEleve = groupBy(
      await studentDb.all('SELECT eleve_id, type, intitule, valeur, date FROM notes WHERE eleve_id = ANY($1::text[]) ORDER BY date DESC', [eleveIds]),
      'eleve_id'
    );

    const result = eleves.map(e => {
      const classe = e.classe_id ? classesById.get(e.classe_id) : null;
      return {
        ...e,
        classe_nom: classe ? classe.nom : null,
        classe_niveau: classe ? classe.niveau : null,
        scores: (scoresParEleve.get(e.id) || []).map(({ eleve_id, ...s }) => s),
        notes: (notesParEleve.get(e.id) || []).map(({ eleve_id, ...n }) => n),
        lastSeen: e.last_seen
      };
    });
    // Tri équivalent à l'ancien ORDER BY c.nom, e.code : sans classe en dernier.
    result.sort((a, b) => (a.classe_nom || '￿').localeCompare(b.classe_nom || '￿') || a.code.localeCompare(b.code));
    return json(res, 200, result);
  }

  // ── Admin : Export CSV complet ──
  // GET /api/admin/export  (optionnel : ?classe_id=... pour limiter à une classe)
  if (p === '/api/admin/export' && method === 'GET') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });

    const classeIdFilter = url.searchParams.get('classe_id');
    let classeFilter = null;
    if (classeIdFilter) {
      classeFilter = await appDb.get('SELECT * FROM classes WHERE id = $1', [classeIdFilter]);
      if (!classeFilter || classeFilter.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });
    }

    const eleves = classeFilter
      ? await studentDb.all('SELECT * FROM eleves WHERE admin_id = $1 AND classe_id = $2', [admin.id, classeIdFilter])
      : await studentDb.all('SELECT * FROM eleves WHERE admin_id = $1', [admin.id]);
    const classesById = await classesMapParAdmin(admin.id);
    eleves.forEach(e => {
      const classe = e.classe_id ? classesById.get(e.classe_id) : null;
      e.classe_nom = classe ? classe.nom : null;
      e.classe_niveau = classe ? classe.niveau : null;
    });
    eleves.sort((a, b) => (a.classe_nom || '￿').localeCompare(b.classe_nom || '￿') || a.code.localeCompare(b.code));

    // Une colonne par chapitre existant (ids 0-20 Terminale, 21-44 Seconde, 45-62 Première),
    // sans les ids fusionnés : les scores de l'ancien Ch18 sont dans Ch02.
    const chapitres = tousLesChapitreIds();

    let csv = 'Classe;Niveau;Code;Pseudo;Derniere_connexion;';
    csv += chapitres.map(i => `Ch${String(i).padStart(2,'0')}_meilleur_score`).join(';');
    csv += ';Nb_notes;Moyenne_notes;Nb_erreurs_quiz;Erreurs_principales\n';

    const eleveIds = eleves.map(e => e.id);
    const scoresParEleve = groupBy(
      await studentDb.all('SELECT eleve_id, chapitre_id, MAX(score) as score FROM quiz_scores WHERE eleve_id = ANY($1::text[]) GROUP BY eleve_id, chapitre_id', [eleveIds]),
      'eleve_id'
    );
    const notesParEleve = groupBy(
      await studentDb.all('SELECT eleve_id, valeur FROM notes WHERE eleve_id = ANY($1::text[])', [eleveIds]),
      'eleve_id'
    );
    // Erreurs fréquentes : total par élève et ses 3 erreurs les plus répétées (« Ch07 ph-7-equivalence ×3 »).
    const erreursParEleve = groupBy(
      await studentDb.all(
        `SELECT eleve_id, chapitre_id, code, COUNT(*)::int AS n FROM erreurs_quiz
         WHERE eleve_id = ANY($1::text[]) GROUP BY eleve_id, chapitre_id, code
         ORDER BY n DESC, chapitre_id, code`,
        [eleveIds]
      ),
      'eleve_id'
    );

    const rows = eleves.map(e => {
      const scores = scoresParEleve.get(e.id) || [];
      const notes = notesParEleve.get(e.id) || [];
      const erreurs = erreursParEleve.get(e.id) || [];
      const nbErreurs = erreurs.reduce((a, r) => a + r.n, 0);
      const erreursPrincipales = erreurs.slice(0, 3)
        .map(r => `Ch${String(r.chapitre_id).padStart(2, '0')} ${r.code} ×${r.n}`).join(' | ');
      const avgNote = notes.length ? (notes.reduce((a,b) => a + b.valeur, 0) / notes.length).toFixed(2) : '';

      const scoreMap = {};
      scores.forEach(s => scoreMap[s.chapitre_id] = s.score);

      const niveauLabelCsv = e.classe_niveau === '2nde' ? 'Seconde' : e.classe_niveau === '1ere' ? 'Première' : e.classe_niveau === 'tle' ? 'Terminale' : '';
      const cells = [csvField(e.classe_nom || 'Sans classe'), niveauLabelCsv, csvField(e.code), csvField(e.pseudo), e.last_seen,
        ...chapitres.map(i => scoreMap[i] !== undefined ? scoreMap[i] : ''), notes.length, avgNote,
        nbErreurs, csvField(erreursPrincipales)];
      return cells.join(';');
    });
    csv += rows.join('\n') + '\n';

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
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await studentDb.get('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    const historique = await studentDb.all('SELECT chapitre_id, score, total, date FROM quiz_scores WHERE eleve_id = $1 ORDER BY date ASC', [eleveId]);
    return json(res, 200, historique);
  }

  // ── Admin : Réinitialiser les données d'un élève ──
  // POST /api/admin/eleves/:id/reset
  if (p.match(/^\/api\/admin\/eleves\/[^/]+\/reset$/) && method === 'POST') {
    const admin = await getAdminFromToken(req);
    if (!admin) return json(res, 401, { error: 'Non autorisé' });
    const eleveId = p.split('/')[4];
    const eleve = await studentDb.get('SELECT * FROM eleves WHERE id = $1', [eleveId]);
    if (!eleve) return json(res, 404, { error: 'Élève introuvable' });
    if (eleve.admin_id !== admin.id) return json(res, 403, { error: 'Non autorisé' });

    await studentDb.run('DELETE FROM quiz_scores WHERE eleve_id = $1', [eleveId]);
    await studentDb.run('DELETE FROM erreurs_quiz WHERE eleve_id = $1', [eleveId]);
    await studentDb.run('DELETE FROM notes WHERE eleve_id = $1', [eleveId]);
    await studentDb.run('DELETE FROM progression WHERE eleve_id = $1', [eleveId]);
    return json(res, 200, { ok: true });
  }

  // ── Health check ──
  if (p === '/health') {
    const elevesRow = await studentDb.get('SELECT COUNT(*)::int as n FROM eleves');
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
  if (!APP_DB_URL) {
    console.error('❌ APP_DATABASE_URL non définie — la base appli PostgreSQL est obligatoire.');
    console.error('   En local : STUDENT_DATABASE_URL=postgres://postgres:MOTDEPASSE@localhost:5432/physichim_app');
    process.exit(1);
  }
  if (!STUDENT_DB_URL) {
    console.error('❌ STUDENT_DATABASE_URL (ou DATABASE_URL) non définie — la base élèves PostgreSQL est obligatoire.');
    console.error('   En local : STUDENT_DATABASE_URL=postgres://postgres:MOTDEPASSE@localhost:5432/physichim_eleves');
    process.exit(1);
  }
  try {
    // Neon coupe les connexions restées inactives : sans écouteur 'error', pg remonte
    // l'événement comme une exception non gérée et le serveur redémarre. On se contente
    // de le noter — le pool rouvre une connexion à la requête suivante.
    appPool = new Pool({ connectionString: APP_DB_URL });
    appPool.on('error', e => console.error('Connexion inactive perdue (base appli) :', e.message));
    await appPool.query('SELECT 1'); // échoue vite si la base est injoignable
    appDb = makeQueryHelpers(appPool);
    await initAppDB();
    await migrerCodesEnseignants();
    await migrerChapitresFusionnes(appPool, 'appli', MIGRATION_FUSION_APPLI);
    console.log('✅ Base de données appli (PostgreSQL) initialisée');

    pgPool = new Pool({ connectionString: STUDENT_DB_URL });
    pgPool.on('error', e => console.error('Connexion inactive perdue (base élèves) :', e.message));
    await pgPool.query('SELECT 1');
    studentDb = makeQueryHelpers(pgPool);
    await initStudentDB();
    await migrerChapitresFusionnes(pgPool, 'élèves', MIGRATION_FUSION_ELEVES);
    console.log('✅ Base de données élèves (PostgreSQL) initialisée');
  } catch (e) {
    console.error('❌ Erreur PostgreSQL :', e.message);
    process.exit(1);
  }

  // '0.0.0.0' explicite : certains hébergeurs (dont Render) attendent une écoute sur
  // toutes les interfaces pour détecter correctement le port ouvert.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 PhysiChim Server — port ${PORT}`);
    // La clé elle-même n'est jamais écrite dans les logs (ils sont conservés chez l'hébergeur).
    console.log(process.env.ADMIN_KEY ? '🔑 Clé admin : définie par ADMIN_KEY' : '🔑 Clé admin locale : voir le fichier .admin-key');
    console.log(`📊 /api/admin/eleves — gestion des élèves`);
    console.log(`📥 /api/admin/export  — export CSV`);
  });
})();

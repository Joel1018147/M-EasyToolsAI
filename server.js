/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║     M-EasyTools AI — Full Production Server v4.0                   ║
 * ║     PostgreSQL + Groq AI + Google OAuth + Stripe            ║
 * ║     WordPress/Shopify Integration + Developer API           ║
 * ║     Seller Panel + Team Workspaces + Analytics             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const session   = require('express-session');
const passport  = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const crypto    = require('crypto');
const fs        = require('fs');
const { pool }  = require('./db');
const { checkSub, updateExpiredSubscriptions, sendTrialReminders } = require('./middleware/checkSub');
const subscriptionRoutes = require('./routes/subscription');
const { Resend } = require('resend');
// Resend throws if constructed without a key, so only init when configured.
// When unset, PR distribution still records but skips the email blast.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'pr@modusaiassociates.com';

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_KEY      = process.env.GROQ_API_KEY;
const GOOGLE_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const APP_URL_RAW   = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL       = APP_URL_RAW.startsWith('http') ? APP_URL_RAW : `https://${APP_URL_RAW}`;

// ── Startup checks ────────────────────────────────────────────────────────────
if (!process.env.GOOGLE_CLIENT_ID) {
  console.error('❌  GOOGLE_CLIENT_ID is missing from .env');
  process.exit(1);
}
if (!process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌  GOOGLE_CLIENT_SECRET is missing from .env');
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('❌  SESSION_SECRET must be at least 32 characters long.');
  console.error('    Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;

// ════════════════════════════════════════════════════
//  POSTGRESQL
// ════════════════════════════════════════════════════
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(255) NOT NULL,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password      VARCHAR(255),
        google_id     VARCHAR(255) UNIQUE,
        avatar        TEXT,
        plan          VARCHAR(50) DEFAULT 'free',
        role          VARCHAR(20) DEFAULT 'user',
        groq_key      TEXT,
        wp_url        TEXT,
        wp_username   TEXT,
        wp_password   TEXT,
        shopify_store TEXT,
        shopify_token TEXT,
        brand_name    VARCHAR(255),
        brand_desc    TEXT,
        brand_tone    VARCHAR(100) DEFAULT 'Professional',
        team_id       INTEGER,
        api_key       VARCHAR(64) UNIQUE,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login    TIMESTAMP,
        is_active     BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS teams (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        owner_id    INTEGER REFERENCES users(id),
        plan        VARCHAR(50) DEFAULT 'agency',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS team_members (
        id        SERIAL PRIMARY KEY,
        team_id   INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role      VARCHAR(20) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS documents (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id     INTEGER REFERENCES teams(id),
        title       VARCHAR(500) NOT NULL,
        content     TEXT,
        tool_id     VARCHAR(100),
        tool_name   VARCHAR(255),
        word_count  INTEGER DEFAULT 0,
        seo_score   INTEGER DEFAULT 0,
        geo_score   INTEGER DEFAULT 0,
        readability INTEGER DEFAULT 0,
        published_wp    BOOLEAN DEFAULT FALSE,
        published_shopify BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_team ON documents(team_id);
      CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);

      CREATE TABLE IF NOT EXISTS platform_modules (
        id         SERIAL PRIMARY KEY,
        module_id  VARCHAR(50) UNIQUE NOT NULL,
        name       VARCHAR(255) NOT NULL,
        is_enabled BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS media_outlets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        website VARCHAR(500) NOT NULL,
        contact_email VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        region VARCHAR(100) DEFAULT 'Malaysia',
        tier VARCHAR(50) DEFAULT 'starter',
        reach_estimate INTEGER DEFAULT 0,
        language VARCHAR(20) DEFAULT 'en',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS journalists (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        outlet_id INTEGER REFERENCES media_outlets(id) ON DELETE SET NULL,
        beat VARCHAR(255),
        region VARCHAR(100) DEFAULT 'Malaysia',
        tier VARCHAR(50) DEFAULT 'starter',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pr_releases (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
        company_name VARCHAR(255) NOT NULL,
        headline VARCHAR(500) NOT NULL,
        spokesperson VARCHAR(255),
        audience VARCHAR(100),
        region VARCHAR(100),
        word_count INTEGER DEFAULT 0,
        seo_score INTEGER DEFAULT 0,
        geo_score INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS pr_distributions (
        id SERIAL PRIMARY KEY,
        pr_id INTEGER NOT NULL REFERENCES pr_releases(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        package_name VARCHAR(100) NOT NULL,
        package_price DECIMAL(10,2) NOT NULL,
        target_outlets INTEGER DEFAULT 0,
        emails_sent INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMP,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS pr_outlet_reports (
        id SERIAL PRIMARY KEY,
        distribution_id INTEGER NOT NULL REFERENCES pr_distributions(id) ON DELETE CASCADE,
        outlet_id INTEGER REFERENCES media_outlets(id) ON DELETE SET NULL,
        outlet_name VARCHAR(255) NOT NULL,
        publication_url TEXT,
        published_at TIMESTAMP,
        reach_estimate INTEGER DEFAULT 0,
        confirmed_by VARCHAR(100) DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_pr_releases_user ON pr_releases(user_id);
      CREATE INDEX IF NOT EXISTS idx_pr_distributions_pr ON pr_distributions(pr_id);
      CREATE INDEX IF NOT EXISTS idx_pr_outlet_reports_dist ON pr_outlet_reports(distribution_id);
      CREATE INDEX IF NOT EXISTS idx_media_outlets_tier ON media_outlets(tier, region);
      CREATE INDEX IF NOT EXISTS idx_journalists_tier ON journalists(tier, region);
    `);

    await client.query(`
      INSERT INTO platform_modules (module_id, name, sort_order) VALUES
        ('content',  'M-EasyContent AI+',       1),
        ('social',   'M-EasySocial AI+',        2),
        ('mail',     'M-EasyMail AI+',          3),
        ('ads',      'M-EasyAds AI+',           4),
        ('seo',      'M-EasySEO AI+',           5),
        ('commerce', 'M-EasyCommerce AI+',      6),
        ('sales',    'M-EasySales AI+',         7),
        ('aichat',   'M-EasyTools AI+ System',  8),
        ('gao',      'M-EasyGAO AI+',           9),
        ('pr',       'M-EasyPR AI+',           10),
        ('audiobook','M-EasyAudiobook AI+',    11)
      ON CONFLICT (module_id) DO NOTHING;
    `);

    // Seed the Modus media database (10 real Malaysian / SEA outlets to start)
    await client.query(`
      INSERT INTO media_outlets (name, website, contact_email, category, region, tier, reach_estimate, language) VALUES
        ('The Edge Malaysia', 'theedgemalaysia.com', 'newsdesk@theedge.com.my', 'Business & Finance', 'Malaysia', 'starter', 280000, 'en'),
        ('The Star Online', 'thestar.com.my', 'star2@thestar.com.my', 'General News', 'Malaysia', 'starter', 1200000, 'en'),
        ('Malay Mail', 'malaymail.com', 'editor@malaymail.com', 'General News', 'Malaysia', 'starter', 350000, 'en'),
        ('Digital News Asia', 'digitalnewsasia.com', 'editor@digitalnewsasia.com', 'Technology', 'Malaysia', 'starter', 120000, 'en'),
        ('SoyaCincau', 'soyacincau.com', 'editor@soyacincau.com', 'Technology', 'Malaysia', 'starter', 200000, 'en'),
        ('Business Today Malaysia', 'businesstoday.com.my', 'editor@businesstoday.com.my', 'Business', 'Malaysia', 'starter', 95000, 'en'),
        ('Tech in Asia', 'techinasia.com', 'editorial@techinasia.com', 'Technology', 'Southeast Asia', 'growth', 800000, 'en'),
        ('e27', 'e27.co', 'editorial@e27.co', 'Startup & Tech', 'Southeast Asia', 'growth', 450000, 'en'),
        ('Vulcan Post', 'vulcanpost.com', 'editor@vulcanpost.com', 'Startup & Tech', 'Southeast Asia', 'growth', 180000, 'en'),
        ('KrASIA', 'kr-asia.com', 'editorial@kr-asia.com', 'Business & Tech', 'Asia Pacific', 'enterprise', 320000, 'en')
      ON CONFLICT DO NOTHING;
    `);

    // Make first user admin
    await client.query(`
      UPDATE users SET role = 'admin' 
      WHERE id = (SELECT MIN(id) FROM users) AND role = 'user'
    `);

    console.log('✓ PostgreSQL database ready');
  } finally { client.release(); }
}

initDB().catch(err => console.error('✗ DB init failed:', err.message));

const db = {
  pool,
  query:  (t, p) => pool.query(t, p),
  getOne: async (t, p) => { const r = await pool.query(t, p); return r.rows[0] || null; },
  getAll: async (t, p) => { const r = await pool.query(t, p); return r.rows; },
  run:    async (t, p) => pool.query(t, p)
};

// ════════════════════════════════════════════════════
//  PASSPORT CONFIG
// ════════════════════════════════════════════════════
passport.use(new GoogleStrategy({
  clientID: GOOGLE_ID,
  clientSecret: GOOGLE_SECRET,
  callbackURL: APP_URL + '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value.toLowerCase();
    let user = await db.getOne('SELECT * FROM users WHERE google_id = $1', [profile.id]);
    if (!user) {
      user = await db.getOne('SELECT * FROM users WHERE email = $1', [email]);
      if (user) {
        user = await db.getOne('UPDATE users SET google_id=$1,avatar=$2,last_login=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *', [profile.id, profile.photos?.[0]?.value, user.id]);
      } else {
        const isFirst = !(await db.getOne('SELECT id FROM users LIMIT 1'));
        const apiKey = crypto.randomBytes(32).toString('hex');
        user = await db.getOne(
          'INSERT INTO users (name,email,google_id,avatar,plan,api_key,role) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [profile.displayName, email, profile.id, profile.photos?.[0]?.value, 'free', apiKey, isFirst ? 'admin' : 'user']
        );
      }
    } else {
      user = await db.getOne('UPDATE users SET last_login=CURRENT_TIMESTAMP,avatar=$1 WHERE id=$2 RETURNING *', [profile.photos?.[0]?.value, user.id]);
    }
    if (!user.is_active) return done(null, false, { message: 'account_disabled' });
    done(null, user);
  } catch (err) { done(err); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.getOne('SELECT * FROM users WHERE id = $1 AND is_active = TRUE', [id]);
    done(null, user || false);
  } catch (err) { done(err); }
});

// ════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════
app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'msm.sid',
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts.' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many requests.' } });

// ════════════════════════════════════════════════════
//  AUTH HELPERS
// ════════════════════════════════════════════════════
function safeUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, plan: u.plan, role: u.role,
    avatar: u.avatar,
    brand_name: u.brand_name, brand_desc: u.brand_desc, brand_tone: u.brand_tone,
    api_key: u.api_key, team_id: u.team_id,
    has_wp: !!(u.wp_url), has_shopify: !!(u.shopify_store)
  };
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.accepts('json')) return res.status(401).json({ error: 'Please log in' });
  res.redirect('/login');
}

function requireSeller(req, res, next) {
  const key = req.query.key || req.headers['x-seller-key'];
  const SELLER_KEY = process.env.SELLER_KEY;
  if (!SELLER_KEY) return res.status(500).json({ error: 'SELLER_KEY not configured' });
  if (key !== SELLER_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Subscription expiry scheduler ────────────────────────────────────────────
async function runScheduledTasks() {
  await updateExpiredSubscriptions(pool).catch(console.error);
  await sendTrialReminders(pool).catch(console.error);
}
runScheduledTasks();
setInterval(runScheduledTasks, 60 * 60 * 1000);

// Developer API Key auth
async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return requireAuth(req, res, next);
  const user = await db.getOne('SELECT * FROM users WHERE api_key = $1 AND is_active = TRUE', [key]);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });
  req.user = user;
  req.isApiKey = true;
  next();
}

// ════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, plan = 'free' } = req.body;
    if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (await db.getOne('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const apiKey = crypto.randomBytes(32).toString('hex');
    const isFirst = !(await db.getOne('SELECT id FROM users LIMIT 1'));
    const result = await db.getOne(
      'INSERT INTO users (name, email, password, plan, api_key, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name.trim(), email.toLowerCase(), hash, plan, apiKey, isFirst ? 'admin' : 'user']
    );
    req.login(result, err => {
      if (err) return res.status(500).json({ error: 'Login failed after registration' });
      res.status(201).json({ user: safeUser(result) });
    });
  } catch (err) { res.status(500).json({ error: 'Registration failed: ' + err.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await db.getOne('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email.toLowerCase()]);
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid email or password' });
    await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    req.login(user, err => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      res.json({ user: safeUser(user) });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_ID) return res.status(500).send('Google OAuth not configured');
  const redirect = req.query.redirect || '';
  passport.authenticate('google', {
    scope: ['openid', 'email', 'profile'],
    accessType: 'offline',
    prompt: 'select_account',
    state: redirect ? Buffer.from(redirect).toString('base64url') : undefined
  })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google_cancelled' }),
  (req, res) => {
    let redirect = '/app';
    try {
      if (req.query.state) {
        const r = Buffer.from(req.query.state, 'base64url').toString();
        if (r.startsWith('/') && !r.startsWith('//')) redirect = r;
      }
    } catch {}
    res.redirect(redirect);
  }
);

app.get('/api/auth/me', requireAuth, (req, res) => res.json(safeUser(req.user)));

app.post('/api/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    req.session.destroy();
    res.json({ success: true });
  });
});

app.put('/api/auth/me', requireAuth, async (req, res) => {
  const { name, brand_name, brand_desc, brand_tone, groq_key } = req.body;
  const user = await db.getOne(
    'UPDATE users SET name=COALESCE($1,name),brand_name=COALESCE($2,brand_name),brand_desc=COALESCE($3,brand_desc),brand_tone=COALESCE($4,brand_tone),groq_key=COALESCE($5,groq_key) WHERE id=$6 RETURNING *',
    [name, brand_name, brand_desc, brand_tone, groq_key, req.user.id]
  );
  res.json({ success: true, user: safeUser(user) });
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!req.user.password) return res.status(400).json({ error: 'This account uses Google login.' });
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Min 8 characters' });
  if (!(await bcrypt.compare(currentPassword, req.user.password))) return res.status(401).json({ error: 'Current password incorrect' });
  await db.run('UPDATE users SET password=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), req.user.id]);
  res.json({ success: true });
});

// Regenerate API Key
app.post('/api/auth/regenerate-key', requireAuth, async (req, res) => {
  const newKey = crypto.randomBytes(32).toString('hex');
  await db.run('UPDATE users SET api_key=$1 WHERE id=$2', [newKey, req.user.id]);
  res.json({ success: true, api_key: newKey });
});

// ════════════════════════════════════════════════════
//  AI CHAT — Groq
// ════════════════════════════════════════════════════
app.post('/api/chat', requireApiKey, apiLimiter, async (req, res) => {
  try {
    const { messages, model = 'llama-3.3-70b-versatile' } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });
    const groqKey = req.user.groq_key || GROQ_KEY;
    if (!groqKey) return res.status(400).json({ error: 'Groq API key not configured' });
    const systemPrompt = `You are M-EasyTools AI, an expert marketing strategist and copywriter. Help with content creation, SEO, email marketing, social media, ad campaigns, and brand strategy. Be specific and actionable. User brand: ${req.user.brand_name || 'Not set'}. Tone: ${req.user.brand_tone || 'Professional'}.`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1024, temperature: 0.7, messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)] })
    });
    if (!response.ok) { const e = await response.json(); throw new Error(e.error?.message || 'Groq error'); }
    const data = await response.json();
    res.json({ success: true, message: data.choices[0].message.content, model: data.model });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════
//  CONTENT GENERATION — Groq
// ════════════════════════════════════════════════════
async function generateWithGroq(user, prompt, toolId, toolName, tone, variants = 1) {
  const groqKey = user.groq_key || GROQ_KEY;
  if (!groqKey) throw new Error('Groq API key not configured');

  const fullPrompt = variants > 1
    ? prompt + `\n\nGenerate ${variants} distinct variants labeled: ═══ VARIANT 1 ═══, ═══ VARIANT 2 ═══, etc.`
    : prompt;

  const systemPrompt = `You are M-EasyTools AI, an elite marketing copywriter with 15+ years experience. Tone: ${tone || 'Professional'}. Brand: ${user.brand_desc || 'General marketing'}. Be persuasive, specific, and conversion-focused.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2500, temperature: 0.75, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: fullPrompt }] })
  });

  if (!response.ok) { const e = await response.json(); throw new Error(e.error?.message || 'Groq error'); }
  const data = await response.json();
  const text = data.choices[0].message.content;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Deterministic content score based on measurable signals
  const sentences = text.split(/[.!?]+/).filter(s => s.trim()).length || 1;
  const avgWordsPerSentence = wordCount / sentences;
  const hasStructure = /#{1,3}\s|^[*-]\s/m.test(text);
  const seoScore = Math.min(100, Math.max(40,
    (wordCount >= 300 ? 25 : Math.floor(wordCount / 12)) +
    (wordCount >= 800 ? 15 : 0) +
    (hasStructure ? 15 : 5) +
    (avgWordsPerSentence < 20 ? 15 : avgWordsPerSentence < 30 ? 10 : 5) + 20
  ));
  const syllables = text.split(/\s+/).reduce((acc, w) => acc + Math.max(1, w.replace(/[^aeiouy]/gi, '').length), 0);
  const readability = Math.min(100, Math.max(30, Math.round(
    206.835 - 1.015 * avgWordsPerSentence - 84.6 * (syllables / (wordCount || 1))
  )));

  // Auto-save document
  const doc = await pool.query(
    'INSERT INTO documents (user_id,title,content,tool_id,tool_name,word_count,seo_score,readability) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [user.id, `${toolName || 'Content'} — ${new Date().toLocaleDateString()}`, text, toolId, toolName, wordCount, seoScore, readability]
  );

  return { text, wordCount, docId: doc.rows[0].id, seoScore, readability };
}

app.post('/api/generate', requireApiKey, apiLimiter, async (req, res) => {
  try {
    const { prompt, toolId, toolName, tone = 'Professional', variants = 1 } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' });

    const result = await generateWithGroq(req.user, prompt, toolId, toolName, tone, variants);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════
//  CONTENT SCORING
// ════════════════════════════════════════════════════
app.post('/api/score', requireAuth, checkSub, async (req, res) => {
  const { content, keyword, targetLength } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });

  const words = content.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  const avgWordsPerSentence = sentences > 0 ? wordCount / sentences : 0;
  const paragraphs = content.split(/\n\n+/).filter(p => p.trim()).length;

  // Keyword density
  let keywordDensity = 0;
  let keywordCount = 0;
  if (keyword) {
    const kw = keyword.toLowerCase();
    keywordCount = words.filter(w => w.toLowerCase().includes(kw)).length;
    keywordDensity = ((keywordCount / wordCount) * 100).toFixed(2);
  }

  // Readability score (Flesch-Kincaid simplified)
  const avgSyllables = 1.5; // approximation
  const readabilityScore = Math.max(0, Math.min(100, Math.round(
    206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllables
  )));

  // SEO Score calculation
  let seoScore = 0;
  const seoFeedback = [];
  if (wordCount >= 300) { seoScore += 20; } else { seoFeedback.push('❌ Content too short — aim for 300+ words'); }
  if (wordCount >= 800) { seoScore += 10; seoFeedback.push('✅ Good length for SEO'); }
  if (keyword && keywordDensity >= 0.5 && keywordDensity <= 2.5) { seoScore += 25; seoFeedback.push('✅ Keyword density is optimal'); }
  else if (keyword) { seoFeedback.push('⚠️ Keyword density should be 0.5–2.5%'); }
  if (content.includes('##') || content.includes('**')) { seoScore += 15; seoFeedback.push('✅ Good use of headings/formatting'); }
  else { seoFeedback.push('⚠️ Add headings (##) to improve structure'); }
  if (avgWordsPerSentence < 20) { seoScore += 15; seoFeedback.push('✅ Sentence length is readable'); }
  else { seoFeedback.push('⚠️ Shorten sentences for better readability'); }
  if (paragraphs >= 3) { seoScore += 15; } else { seoFeedback.push('⚠️ Add more paragraphs to improve readability'); }

  res.json({
    wordCount, sentences, paragraphs,
    keywordDensity: parseFloat(keywordDensity),
    keywordCount,
    readabilityScore,
    seoScore: Math.min(100, seoScore),
    feedback: seoFeedback,
    grade: seoScore >= 80 ? 'A' : seoScore >= 60 ? 'B' : seoScore >= 40 ? 'C' : 'D'
  });
});

// ════════════════════════════════════════════════════
//  M-EasyPR AI+ — WRITE · BLAST · REPORT (Modus is the wire service)
// ════════════════════════════════════════════════════

// WRITE — reuses generateWithGroq() for the release; adds an AI GEO score.
app.post('/api/pr/generate', requireAuth, checkSub, apiLimiter, async (req, res) => {
  try {
    const { company, headline, keyMessages, quote, spokesperson, audience, region, cta, tone } = req.body;
    if (!company?.trim() || !headline?.trim() || !keyMessages?.trim()) {
      return res.status(400).json({ error: 'Company name, headline, and key messages are required' });
    }

    const prPrompt = `You are an expert PR writer specialising in Malaysian and Southeast Asian business press releases for distribution to journalists and media outlets across the region.

Write a complete, professional press release ready for immediate distribution.

COMPANY: ${company}
HEADLINE: ${headline}
KEY MESSAGES: ${keyMessages}
SPOKESPERSON QUOTE: "${quote || 'No quote provided'}" — ${spokesperson || 'Company Spokesperson'}
TARGET AUDIENCE: ${audience || 'General Business Media'}
DISTRIBUTION REGION: ${region || 'Malaysia'}
CALL TO ACTION: ${cta || 'Contact us for more information'}
TONE: ${tone || 'Professional'}

Write the press release in this EXACT format:

FOR IMMEDIATE RELEASE

[HEADLINE IN TITLE CASE — newsworthy, specific, SEO-optimized]

[Compelling one-sentence subheadline]

KUALA LUMPUR, Malaysia, ${new Date().toLocaleDateString('en-MY', {day:'numeric',month:'long',year:'numeric'})} — [Opening paragraph: 50-60 words answering Who, What, When, Where, Why. Lead with the most important news.]

[Second paragraph: Context and industry significance. Why does this matter? What problem does it solve?]

[Third paragraph — REQUIRED FORMAT: "Direct quote from the announcement," said ${spokesperson || 'Spokesperson Name'}, ${spokesperson ? 'their title' : 'Title'} at ${company}. "Continue the quote if needed."]

[Fourth paragraph: Specific product, service, or initiative details. Include facts, figures, features.]

[Fifth paragraph: Market context, future roadmap, or customer impact. Include a forward-looking statement.]

[Sixth paragraph: Clear call to action — what should readers, investors, or journalists do next?]

About ${company}
[2-3 sentence company boilerplate: what the company does, its mission, and one key fact about reach or impact.]

###

Media Contact:
${spokesperson || '[Spokesperson Name]'}
[Title, ${company}]
[Email]
[Phone]
[Website]

Optimise this press release to rank in search engines AND be cited in AI-generated answers (ChatGPT, Perplexity, Google AI Overviews). Use specific named entities, quotable statistics, clear subject-predicate-object sentences, and factual claims that AI systems can reference.`;

    // Reuse existing generateWithGroq function
    const result = await generateWithGroq(req.user, prPrompt, 'press-release', 'Press Release', tone || 'Professional');

    // GEO score — separate quick call, silent fallback
    let geoScore = 0;
    let geoReason = 'GEO score unavailable';
    try {
      const groqKey = req.user.groq_key || GROQ_KEY;
      if (groqKey) {
        const geoRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 80,
            temperature: 0.1,
            messages: [{
              role: 'user',
              content: `Rate this press release 0-100 for likelihood of being cited in AI-generated answers. Consider: named entities, specific facts/numbers, quotable statements, newsworthiness, clear subject-predicate-object sentences. Return ONLY valid JSON, no other text: {"score":number,"reason":"one sentence"}\n\nPRESS RELEASE (first 1000 chars):\n${result.text.substring(0, 1000)}`
            }]
          })
        });
        if (geoRes.ok) {
          const geoData = await geoRes.json();
          const raw = geoData.choices[0].message.content.trim();
          const parsed = JSON.parse(raw);
          geoScore = Math.min(100, Math.max(0, parseInt(parsed.score) || 0));
          geoReason = parsed.reason || '';
        }
      }
    } catch (e) { /* silent fallback */ }

    // Save to pr_releases table
    const pr = await pool.query(
      `INSERT INTO pr_releases (user_id, doc_id, company_name, headline, spokesperson, audience, region, word_count, seo_score, geo_score, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING id`,
      [req.user.id, result.docId, company.trim(), headline.trim(), spokesperson?.trim(), audience, region, result.wordCount, result.seoScore, geoScore]
    );

    // Update documents table with geo_score (column added above)
    await pool.query('UPDATE documents SET geo_score=$1 WHERE id=$2', [geoScore, result.docId]);

    res.json({ success: true, text: result.text, wordCount: result.wordCount, docId: result.docId, prId: pr.rows[0].id, seoScore: result.seoScore, geoScore, geoReason });
  } catch (err) {
    console.error('PR generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List this user's press releases (+ any distribution attached).
app.get('/api/pr/releases', requireAuth, checkSub, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const releases = await pool.query(
      `SELECT pr.id, pr.company_name, pr.headline, pr.word_count, pr.seo_score, pr.geo_score, pr.status, pr.created_at,
              d.title AS doc_title,
              pd.id AS dist_id, pd.package_name, pd.package_price, pd.status AS dist_status, pd.emails_sent, pd.submitted_at
       FROM pr_releases pr
       LEFT JOIN documents d ON d.id = pr.doc_id
       LEFT JOIN pr_distributions pd ON pd.pr_id = pr.id
       WHERE pr.user_id = $1
       ORDER BY pr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), offset]
    );
    const total = await pool.query('SELECT COUNT(*) AS c FROM pr_releases WHERE user_id=$1', [req.user.id]);
    res.json({ releases: releases.rows, total: parseInt(total.rows[0].c) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BLAST — match media DB by package tier/region, fire Resend emails, record distribution.
app.post('/api/pr/distribute', requireAuth, checkSub, async (req, res) => {
  try {
    const { prId, package: pkg } = req.body;

    const PACKAGES = {
      starter:    { name: 'Starter',    price: 149, tiers: ['starter'],                    label: '10 Media Outlets — Malaysia' },
      growth:     { name: 'Growth',     price: 299, tiers: ['starter','growth'],            label: '25 Media Outlets — Malaysia + SEA' },
      enterprise: { name: 'Enterprise', price: 599, tiers: ['starter','growth','enterprise'],label: '50+ Media Outlets — Asia Pacific' }
    };

    if (!PACKAGES[pkg]) return res.status(400).json({ error: 'Invalid package' });
    if (!prId) return res.status(400).json({ error: 'Press release ID required' });

    const pkgConfig = PACKAGES[pkg];

    // Verify PR belongs to user
    const pr = await pool.query(
      'SELECT pr.id, pr.headline, pr.company_name, pr.spokesperson, pr.region, d.content FROM pr_releases pr LEFT JOIN documents d ON d.id = pr.doc_id WHERE pr.id=$1 AND pr.user_id=$2',
      [prId, req.user.id]
    );
    if (!pr.rows[0]) return res.status(404).json({ error: 'Press release not found' });
    const prData = pr.rows[0];

    // Get matching outlets and journalists
    const outlets = await pool.query(
      'SELECT id, name, website, contact_email, category, reach_estimate FROM media_outlets WHERE tier = ANY($1) AND is_active=TRUE ORDER BY reach_estimate DESC',
      [pkgConfig.tiers]
    );
    const journalists = await pool.query(
      'SELECT j.id, j.name, j.email, j.beat, m.name AS outlet_name FROM journalists j LEFT JOIN media_outlets m ON m.id=j.outlet_id WHERE j.tier = ANY($1) AND j.is_active=TRUE',
      [pkgConfig.tiers]
    );

    // Create distribution record
    const dist = await pool.query(
      `INSERT INTO pr_distributions (pr_id, user_id, package_name, package_price, target_outlets, status)
       VALUES ($1,$2,$3,$4,$5,'processing') RETURNING id`,
      [prId, req.user.id, pkgConfig.name, pkgConfig.price, outlets.rows.length]
    );
    const distId = dist.rows[0].id;

    // Update PR status
    await pool.query("UPDATE pr_releases SET status='submitted', updated_at=NOW() WHERE id=$1", [prId]);

    // Fire emails via Resend (async — don't block response)
    const prContent = prData.content || 'Press release content not available.';
    const prHeadline = prData.headline;
    const prCompany = prData.company_name;
    let emailsSent = 0;

    const emailTargets = [
      ...outlets.rows.map(o => ({ email: o.contact_email, name: o.name, type: 'outlet' })),
      ...journalists.rows.map(j => ({ email: j.email, name: j.name, type: 'journalist', outlet: j.outlet_name, beat: j.beat }))
    ];

    // Send emails in background
    (async () => {
      if (!resend) {
        console.warn(`RESEND_API_KEY not set — skipping email blast for distribution ${distId}`);
        await pool.query('UPDATE pr_distributions SET status=$1 WHERE id=$2', ['pending', distId]);
        return;
      }
      for (const target of emailTargets) {
        try {
          const subject = `[PRESS RELEASE] ${prHeadline} — ${prCompany}`;
          const pitchIntro = target.type === 'journalist'
            ? `Dear ${target.name},\n\nI'm sharing a press release from ${prCompany} that may be relevant to your coverage${target.beat ? ` of ${target.beat}` : ''}.\n\n`
            : `Dear ${target.name} Editorial Team,\n\nPlease find below a press release from ${prCompany} for your consideration.\n\n`;

          await resend.emails.send({
            from: EMAIL_FROM,
            to: target.email,
            subject,
            text: `${pitchIntro}---\n\n${prContent}\n\n---\nDistributed via M-EasyPR AI+ by Modus AI Associates\nwww.modusaiassociates.com`
          });
          emailsSent++;
        } catch (e) {
          console.error(`PR email failed to ${target.email}:`, e.message);
        }
      }
      // Update emails_sent count
      await pool.query('UPDATE pr_distributions SET emails_sent=$1, status=$2 WHERE id=$3', [emailsSent, 'sent', distId]);
    })();

    res.json({
      success: true,
      distributionId: distId,
      targetCount: emailTargets.length,
      message: `Your press release is being distributed to ${emailTargets.length} media contacts. Our team will update your report as outlets publish your story.`
    });
  } catch (err) {
    console.error('PR distribute error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// REPORT — publications + reach for a distribution the user owns.
app.get('/api/pr/report/:distributionId', requireAuth, checkSub, async (req, res) => {
  try {
    const dist = await pool.query(
      `SELECT pd.id, pd.package_name, pd.package_price, pd.target_outlets, pd.emails_sent, pd.status, pd.submitted_at, pd.published_at,
              pr.headline, pr.company_name, pr.spokesperson, pr.word_count, pr.seo_score, pr.geo_score
       FROM pr_distributions pd
       JOIN pr_releases pr ON pr.id = pd.pr_id
       WHERE pd.id=$1 AND pd.user_id=$2`,
      [req.params.distributionId, req.user.id]
    );
    if (!dist.rows[0]) return res.status(404).json({ error: 'Distribution not found' });

    const outlets = await pool.query(
      `SELECT outlet_name, publication_url, published_at, reach_estimate
       FROM pr_outlet_reports
       WHERE distribution_id=$1
       ORDER BY reach_estimate DESC`,
      [req.params.distributionId]
    );

    const totalReach = outlets.rows.reduce((sum, o) => sum + (o.reach_estimate || 0), 0);

    res.json({
      distribution: dist.rows[0],
      outlets: outlets.rows,
      totalReach,
      publishedCount: outlets.rows.filter(o => o.publication_url).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seller/admin: media database + publication confirmation ─────────────────────
app.get('/api/seller/pr/outlets', requireSeller, async (req, res) => {
  try {
    const outlets = await pool.query('SELECT id, name, website, contact_email, category, region, tier, reach_estimate, is_active FROM media_outlets ORDER BY tier, reach_estimate DESC');
    res.json({ outlets: outlets.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/pr/outlets', requireSeller, async (req, res) => {
  try {
    const { name, website, contact_email, category, region, tier, reach_estimate, language } = req.body;
    if (!name || !website || !contact_email) return res.status(400).json({ error: 'Name, website, and email required' });
    const outlet = await pool.query(
      'INSERT INTO media_outlets (name, website, contact_email, category, region, tier, reach_estimate, language) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, website, contact_email, category || 'General', region || 'Malaysia', tier || 'starter', reach_estimate || 0, language || 'en']
    );
    res.json({ success: true, id: outlet.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seller/pr/journalists', requireSeller, async (req, res) => {
  try {
    const journalists = await pool.query(
      'SELECT j.id, j.name, j.email, j.beat, j.region, j.tier, j.is_active, m.name AS outlet_name FROM journalists j LEFT JOIN media_outlets m ON m.id=j.outlet_id ORDER BY j.tier, j.name'
    );
    res.json({ journalists: journalists.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/pr/journalists', requireSeller, async (req, res) => {
  try {
    const { name, email, outlet_id, beat, region, tier } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    const j = await pool.query(
      'INSERT INTO journalists (name, email, outlet_id, beat, region, tier) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, email, outlet_id || null, beat || null, region || 'Malaysia', tier || 'starter']
    );
    res.json({ success: true, id: j.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seller/pr/distributions', requireSeller, async (req, res) => {
  try {
    const dists = await pool.query(
      `SELECT pd.id, pd.package_name, pd.package_price, pd.target_outlets, pd.emails_sent, pd.status, pd.submitted_at,
              pr.headline, pr.company_name, u.name AS user_name, u.email AS user_email
       FROM pr_distributions pd
       JOIN pr_releases pr ON pr.id = pd.pr_id
       JOIN users u ON u.id = pd.user_id
       ORDER BY pd.submitted_at DESC`
    );
    res.json({ distributions: dists.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/pr/confirm-publication', requireSeller, async (req, res) => {
  try {
    const { distribution_id, outlet_name, publication_url, reach_estimate } = req.body;
    if (!distribution_id || !outlet_name || !publication_url) return res.status(400).json({ error: 'distribution_id, outlet_name, and publication_url required' });

    // Find outlet_id if it exists
    const outlet = await pool.query('SELECT id, reach_estimate FROM media_outlets WHERE name ILIKE $1 LIMIT 1', [outlet_name]);
    const outletId = outlet.rows[0]?.id || null;
    const reach = reach_estimate || outlet.rows[0]?.reach_estimate || 0;

    await pool.query(
      `INSERT INTO pr_outlet_reports (distribution_id, outlet_id, outlet_name, publication_url, published_at, reach_estimate)
       VALUES ($1,$2,$3,$4,NOW(),$5)
       ON CONFLICT DO NOTHING`,
      [distribution_id, outletId, outlet_name, publication_url, reach]
    );

    // Update distribution published_at if first publication
    await pool.query(
      "UPDATE pr_distributions SET published_at=COALESCE(published_at,NOW()), status='published' WHERE id=$1",
      [distribution_id]
    );
    await pool.query(
      "UPDATE pr_releases SET status='published', updated_at=NOW() WHERE id=(SELECT pr_id FROM pr_distributions WHERE id=$1)",
      [distribution_id]
    );

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════
//  WORDPRESS INTEGRATION
// ════════════════════════════════════════════════════
app.post('/api/integrations/wordpress/connect', requireAuth, checkSub, async (req, res) => {
  const { url, username, password } = req.body;
  if (!url || !username || !password) return res.status(400).json({ error: 'URL, username and app password required' });

  const cleanUrl = url.replace(/\/$/, '');
  try {
    // Test the connection
    const testRes = await fetch(`${cleanUrl}/wp-json/wp/v2/users/me`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }
    });
    if (!testRes.ok) throw new Error('Could not connect to WordPress. Check your URL and credentials.');
    const wpUser = await testRes.json();
    await db.run('UPDATE users SET wp_url=$1, wp_username=$2, wp_password=$3 WHERE id=$4', [cleanUrl, username, password, req.user.id]);
    res.json({ success: true, message: `Connected to WordPress as ${wpUser.name}`, site: cleanUrl });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/integrations/wordpress/publish', requireAuth, checkSub, async (req, res) => {
  const { docId, title, status = 'draft', categories = [], tags = [] } = req.body;
  if (!req.user.wp_url) return res.status(400).json({ error: 'WordPress not connected. Go to Settings → Integrations.' });

  const doc = await db.getOne('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [docId, req.user.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  try {
    const response = await fetch(`${req.user.wp_url}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${req.user.wp_username}:${req.user.wp_password}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: title || doc.title, content: doc.content, status, categories, tags })
    });
    if (!response.ok) { const e = await response.json(); throw new Error(e.message || 'WordPress publish failed'); }
    const post = await response.json();
    await db.run('UPDATE documents SET published_wp = TRUE WHERE id = $1', [docId]);
    res.json({ success: true, postId: post.id, url: post.link, editUrl: `${req.user.wp_url}/wp-admin/post.php?post=${post.id}&action=edit` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/integrations/wordpress/disconnect', requireAuth, checkSub, async (req, res) => {
  await db.run('UPDATE users SET wp_url=NULL, wp_username=NULL, wp_password=NULL WHERE id=$1', [req.user.id]);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════
//  SHOPIFY INTEGRATION
// ════════════════════════════════════════════════════
app.post('/api/integrations/shopify/connect', requireAuth, checkSub, async (req, res) => {
  const { store, token } = req.body;
  if (!store || !token) return res.status(400).json({ error: 'Store domain and access token required' });

  const cleanStore = store.replace('https://', '').replace('http://', '').replace(/\/$/, '');
  try {
    const testRes = await fetch(`https://${cleanStore}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    if (!testRes.ok) throw new Error('Could not connect to Shopify. Check your store URL and token.');
    const shopData = await testRes.json();
    await db.run('UPDATE users SET shopify_store=$1, shopify_token=$2 WHERE id=$3', [cleanStore, token, req.user.id]);
    res.json({ success: true, message: `Connected to ${shopData.shop.name}`, store: cleanStore });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/integrations/shopify/publish', requireAuth, checkSub, async (req, res) => {
  const { docId, productId, field = 'body_html' } = req.body;
  if (!req.user.shopify_store) return res.status(400).json({ error: 'Shopify not connected. Go to Settings → Integrations.' });

  const doc = await db.getOne('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [docId, req.user.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  try {
    let url, body;
    if (productId) {
      url = `https://${req.user.shopify_store}/admin/api/2024-01/products/${productId}.json`;
      body = JSON.stringify({ product: { id: productId, [field]: doc.content } });
    } else {
      url = `https://${req.user.shopify_store}/admin/api/2024-01/products.json`;
      body = JSON.stringify({ product: { title: doc.title, body_html: doc.content, status: 'draft' } });
    }
    const response = await fetch(url, {
      method: productId ? 'PUT' : 'POST',
      headers: { 'X-Shopify-Access-Token': req.user.shopify_token, 'Content-Type': 'application/json' },
      body
    });
    if (!response.ok) { const e = await response.json(); throw new Error(JSON.stringify(e.errors) || 'Shopify publish failed'); }
    const result = await response.json();
    await db.run('UPDATE documents SET published_shopify = TRUE WHERE id = $1', [docId]);
    const product = result.product;
    res.json({ success: true, productId: product.id, title: product.title, adminUrl: `https://${req.user.shopify_store}/admin/products/${product.id}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/integrations/shopify/products', requireAuth, checkSub, async (req, res) => {
  if (!req.user.shopify_store) return res.status(400).json({ error: 'Shopify not connected' });
  try {
    const response = await fetch(`https://${req.user.shopify_store}/admin/api/2024-01/products.json?limit=20&fields=id,title,status`, {
      headers: { 'X-Shopify-Access-Token': req.user.shopify_token }
    });
    const data = await response.json();
    res.json({ products: data.products || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/integrations/shopify/disconnect', requireAuth, checkSub, async (req, res) => {
  await db.run('UPDATE users SET shopify_store=NULL, shopify_token=NULL WHERE id=$1', [req.user.id]);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════
//  TEAM WORKSPACES
// ════════════════════════════════════════════════════
app.post('/api/teams', requireAuth, checkSub, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Team name required' });
  const team = await db.getOne('INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING *', [name.trim(), req.user.id]);
  await db.run('UPDATE users SET team_id = $1, role = $2 WHERE id = $3', [team.id, 'owner', req.user.id]);
  await db.run('INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)', [team.id, req.user.id, 'owner']);
  res.status(201).json({ team });
});

app.get('/api/teams/mine', requireAuth, checkSub, async (req, res) => {
  if (!req.user.team_id) return res.json({ team: null, members: [] });
  const team = await db.getOne('SELECT * FROM teams WHERE id = $1', [req.user.team_id]);
  const members = await db.getAll('SELECT u.id, u.name, u.email, u.avatar, tm.role, tm.joined_at FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1', [req.user.team_id]);
  res.json({ team, members });
});

app.post('/api/teams/invite', requireAuth, checkSub, async (req, res) => {
  const { email, role = 'member' } = req.body;
  if (!req.user.team_id) return res.status(400).json({ error: 'You are not in a team' });
  const invitee = await db.getOne('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!invitee) return res.status(404).json({ error: 'No user found with that email. They must sign up first.' });
  if (invitee.team_id) return res.status(409).json({ error: 'User is already in a team' });
  await db.run('UPDATE users SET team_id = $1 WHERE id = $2', [req.user.team_id, invitee.id]);
  await db.run('INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.user.team_id, invitee.id, role]);
  res.json({ success: true, message: `${invitee.name} added to your team` });
});

app.delete('/api/teams/members/:userId', requireAuth, checkSub, async (req, res) => {
  if (!req.user.team_id) return res.status(400).json({ error: 'Not in a team' });
  await db.run('UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2', [req.params.userId, req.user.team_id]);
  await db.run('DELETE FROM team_members WHERE user_id = $1 AND team_id = $2', [req.params.userId, req.user.team_id]);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════
//  DOCUMENTS CRUD
// ════════════════════════════════════════════════════
app.get('/api/documents', requireApiKey, async (req, res) => {
  const { page = 1, limit = 30, type } = req.query;
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM documents WHERE user_id=$1';
  const params = [req.user.id];
  if (type) { query += ` AND tool_name=$${params.length + 1}`; params.push(type); }
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  const docs = await db.getAll(query, params);
  const total = await db.getOne('SELECT COUNT(*) as c FROM documents WHERE user_id=$1', [req.user.id]);
  res.json({ documents: docs, total: parseInt(total.c) });
});

app.get('/api/documents/:id', requireAuth, checkSub, async (req, res) => {
  const doc = await db.getOne('SELECT * FROM documents WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

app.post('/api/documents', requireAuth, checkSub, async (req, res) => {
  const { title, content, tool_id, tool_name } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const wc = (content || '').split(/\s+/).filter(Boolean).length;
  const doc = await db.getOne('INSERT INTO documents (user_id,title,content,tool_id,tool_name,word_count) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.user.id, title, content || '', tool_id, tool_name, wc]);
  res.status(201).json({ id: doc.id, success: true });
});

app.put('/api/documents/:id', requireAuth, checkSub, async (req, res) => {
  const { title, content } = req.body;
  const wc = (content || '').split(/\s+/).filter(Boolean).length;
  await db.run('UPDATE documents SET title=COALESCE($1,title),content=COALESCE($2,content),word_count=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4 AND user_id=$5', [title, content, wc, req.params.id, req.user.id]);
  res.json({ success: true });
});

app.delete('/api/documents/:id', requireAuth, checkSub, async (req, res) => {
  await db.run('DELETE FROM documents WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════
//  STATS & ANALYTICS
// ════════════════════════════════════════════════════
app.get('/api/stats', requireAuth, checkSub, async (req, res) => {
  const uid = req.user.id;
  const [totalDocs, totalWords, weekDocs, topTool, recentDocs, dailyUsage] = await Promise.all([
    db.getOne('SELECT COUNT(*) as c FROM documents WHERE user_id=$1', [uid]),
    db.getOne('SELECT COALESCE(SUM(word_count),0) as w FROM documents WHERE user_id=$1', [uid]),
    db.getOne("SELECT COUNT(*) as c FROM documents WHERE user_id=$1 AND created_at>=NOW()-INTERVAL '7 days'", [uid]),
    db.getOne('SELECT tool_name, COUNT(*) as uses FROM documents WHERE user_id=$1 AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY uses DESC LIMIT 1', [uid]),
    db.getAll('SELECT * FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [uid]),
    db.getAll("SELECT DATE(created_at) as date, COUNT(*) as docs, COALESCE(SUM(word_count),0) as words FROM documents WHERE user_id=$1 AND created_at>=NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date", [uid])
  ]);
  res.json({
    totalDocuments: parseInt(totalDocs.c), totalWords: parseInt(totalWords.w),
    docsThisWeek: parseInt(weekDocs.c), topTool: topTool?.tool_name || 'None yet',
    recentDocuments: recentDocs, dailyUsage
  });
});

// ════════════════════════════════════════════════════
//  API KEYS MANAGEMENT
// ════════════════════════════════════════════════════
app.get('/api/keys', requireAuth, checkSub, (req, res) => {
  res.json({ has_groq: !!(req.user.groq_key || GROQ_KEY), api_key: req.user.api_key, groq_preview: req.user.groq_key ? req.user.groq_key.slice(0,12)+'…' : (GROQ_KEY ? '✓ Server key active' : null) });
});

app.put('/api/keys', requireAuth, checkSub, async (req, res) => {
  const { groq_key } = req.body;
  await db.run('UPDATE users SET groq_key=COALESCE($1,groq_key) WHERE id=$2', [groq_key || null, req.user.id]);
  res.json({ success: true });
});


// ════════════════════════════════════════════════════
//  DEVELOPER API DOCS
// ════════════════════════════════════════════════════
app.get('/api/docs', (req, res) => {
  res.json({
    name: 'M-EasyTools AI Developer API',
    version: '4.0.0',
    baseUrl: APP_URL,
    authentication: 'Add header: X-API-Key: your_api_key',
    rateLimit: '120 requests per minute',
    endpoints: [
      { method: 'POST', path: '/api/generate', description: 'Generate marketing content', body: { prompt: 'string (required)', toolId: 'string', toolName: 'string', tone: 'string', variants: 'number (1-3)' } },
      { method: 'POST', path: '/api/chat', description: 'AI chat message', body: { messages: 'array of {role, content}' } },
      { method: 'GET',  path: '/api/documents', description: 'List your documents', params: { page: 'number', limit: 'number', type: 'string' } },
      { method: 'POST', path: '/api/score', description: 'Score content for SEO', body: { content: 'string', keyword: 'string' } },
      { method: 'GET',  path: '/api/stats', description: 'Your usage statistics' },
    ],
    example: {
      request: `fetch('${APP_URL}/api/generate', { method: 'POST', headers: { 'X-API-Key': 'your_key', 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Write a blog post about AI marketing', toolId: 'blog-writer', tone: 'Professional' }) })`,
      response: { success: true, text: 'Generated content...', wordCount: 850 }
    }
  });
});

// ════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  try {
    const users = await db.getOne('SELECT COUNT(*) as c FROM users');
    const docs  = await db.getOne('SELECT COUNT(*) as c FROM documents');
    res.json({ status: 'ok', app: 'M-EasyTools AI', version: '4.0.0', database: 'PostgreSQL', users: parseInt(users.c), documents: parseInt(docs.c), groq: !!GROQ_KEY, google: !!GOOGLE_ID, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', app: 'M-EasyTools AI', database: 'unavailable', error: err.message, timestamp: new Date().toISOString() });
  }
});

// ════════════════════════════════════════════════════
//  SELLER PANEL
// ════════════════════════════════════════════════════
app.get('/api/seller/verify', requireSeller, (req, res) => res.json({ ok: true }));

app.get('/api/seller/stats', requireSeller, async (req, res) => {
  try {
    const [totalUsers, activeUsers, totalDocs, modules, recentSignups, topTools] = await Promise.all([
      db.getOne('SELECT COUNT(*) as c FROM users'),
      db.getOne('SELECT COUNT(*) as c FROM users WHERE is_active = TRUE'),
      db.getOne('SELECT COUNT(*) as c FROM documents'),
      db.getAll('SELECT module_id, name, is_enabled FROM platform_modules ORDER BY sort_order'),
      db.getAll('SELECT id, name, email, plan, role, created_at, is_active FROM users ORDER BY created_at DESC LIMIT 10'),
      db.getAll('SELECT tool_name, COUNT(*) as uses FROM documents WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY uses DESC LIMIT 5'),
    ]);
    res.json({
      totalUsers: parseInt(totalUsers.c),
      activeUsers: parseInt(activeUsers.c),
      totalDocs: parseInt(totalDocs.c),
      activeModules: modules.filter(m => m.is_enabled).length,
      totalModules: modules.length,
      recentSignups,
      topTools,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seller/users', requireSeller, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, plan } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const where = [];
    if (search) { params.push(`%${search}%`); where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
    if (plan) { params.push(plan); where.push(`plan = $${params.length}`); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const users = await db.getAll(
      `SELECT id,name,email,plan,role,created_at,last_login,is_active FROM users ${whereClause} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const total = await db.getOne(`SELECT COUNT(*) as c FROM users ${whereClause}`, params);
    res.json({ users, total: parseInt(total.c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seller/users/:id', requireSeller, async (req, res) => {
  try {
    const user = await db.getOne('SELECT id,name,email,plan,role,created_at,last_login,is_active FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const docs = await db.getOne('SELECT COUNT(*) as c FROM documents WHERE user_id=$1', [req.params.id]);
    res.json({ ...user, docCount: parseInt(docs.c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seller/users/:id', requireSeller, async (req, res) => {
  try {
    const { plan, role, is_active } = req.body;
    await db.run(
      'UPDATE users SET plan=COALESCE($1,plan), role=COALESCE($2,role), is_active=COALESCE($3,is_active) WHERE id=$4',
      [plan || null, role || null, is_active ?? null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/users/:id/toggle-active', requireSeller, async (req, res) => {
  try {
    const user = await db.getOne('SELECT is_active FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.run('UPDATE users SET is_active=$1 WHERE id=$2', [!user.is_active, req.params.id]);
    res.json({ success: true, is_active: !user.is_active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/modules', async (req, res) => {
  try {
    const modules = await db.getAll('SELECT module_id, name, is_enabled, sort_order FROM platform_modules ORDER BY sort_order');
    res.json({ modules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Seller panel reads the module list from here (public /api/modules omits nothing,
// but the panel authenticates with the seller key like every other seller route).
app.get('/api/seller/modules', requireSeller, async (req, res) => {
  try {
    const modules = await db.getAll('SELECT module_id, name, is_enabled, sort_order FROM platform_modules ORDER BY sort_order');
    res.json({ modules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seller/modules/:moduleId', requireSeller, async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { is_enabled } = req.body;
    const mod = await db.getOne('SELECT id FROM platform_modules WHERE module_id = $1', [moduleId]);
    if (!mod) return res.status(404).json({ error: 'Module not found' });
    await db.run('UPDATE platform_modules SET is_enabled=$1, updated_at=CURRENT_TIMESTAMP WHERE module_id=$2', [!!is_enabled, moduleId]);
    res.json({ success: true, module_id: moduleId, is_enabled: !!is_enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seller/documents', requireSeller, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const docs = await db.getAll(
      `SELECT d.id, d.title, d.tool_name, d.word_count, d.created_at, u.name as user_name, u.email as user_email
       FROM documents d JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await db.getOne('SELECT COUNT(*) as c FROM documents');
    res.json({ documents: docs, total: parseInt(total.c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════
//  MODULE PAGE ROUTES
// ════════════════════════════════════════════════════
const moduleCache = new Map();
const MODULE_CACHE_TTL = 60_000;

function checkModule(moduleId) {
  return async (req, res, next) => {
    try {
      const cached = moduleCache.get(moduleId);
      if (cached && Date.now() - cached.at < MODULE_CACHE_TTL) {
        if (!cached.enabled) return res.sendFile(path.join(__dirname, 'public', 'module-unavailable.html'));
        return next();
      }
      const mod = await db.getOne('SELECT is_enabled FROM platform_modules WHERE module_id = $1', [moduleId]);
      const enabled = !mod || mod.is_enabled;
      moduleCache.set(moduleId, { enabled, at: Date.now() });
      if (!enabled) return res.sendFile(path.join(__dirname, 'public', 'module-unavailable.html'));
      next();
    } catch { next(); }
  };
}

// ── Subscription router (payment callbacks — no auth required) ────────────────
app.use('/', subscriptionRoutes);

// ── Billing & subscription routes ─────────────────────────────────────────────
app.get('/billing', requireAuth, checkSub, (req, res) => res.sendFile(path.join(__dirname, 'public', 'billing.html')));
app.post('/billing/checkout', requireAuth, checkSub, subscriptionRoutes.checkoutHandler);
app.get('/api/subscription/status', requireAuth, checkSub, subscriptionRoutes.statusHandler);
app.get('/api/subscription/invoices', requireAuth, checkSub, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Could not fetch invoices.' }); }
});

// ── Seller subscription routes ────────────────────────────────────────────────
app.get('/api/seller/subscription/stats', requireSeller, async (req, res) => {
  try {
    const [total, active, trial, grace, expired] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM subscriptions"),
      pool.query("SELECT COUNT(*) FROM subscriptions WHERE status='active'"),
      pool.query("SELECT COUNT(*) FROM subscriptions WHERE status='trial'"),
      pool.query("SELECT COUNT(*) FROM subscriptions WHERE status='grace'"),
      pool.query("SELECT COUNT(*) FROM subscriptions WHERE status='expired'"),
    ]);
    const revenue = await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status='success'");
    res.json({
      total:   parseInt(total.rows[0].count),
      active:  parseInt(active.rows[0].count),
      trial:   parseInt(trial.rows[0].count),
      grace:   parseInt(grace.rows[0].count),
      expired: parseInt(expired.rows[0].count),
      revenue: parseFloat(revenue.rows[0].total).toFixed(2),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seller/subscription/users', requireSeller, async (req, res) => {
  try {
    const { search } = req.query;
    let q = `SELECT u.id, u.name, u.email, s.status, s.plan, s.billing_cycle,
                    s.trial_ends_at, s.paid_until, s.grace_until, s.created_at
             FROM subscriptions s JOIN users u ON u.id = s.user_id`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` WHERE u.name ILIKE $1 OR u.email ILIKE $1`; }
    q += ' ORDER BY s.created_at DESC LIMIT 100';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/subscription/extend-trial', requireSeller, async (req, res) => {
  try {
    const { user_id, days = 7 } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await pool.query(
      `UPDATE subscriptions SET trial_ends_at = GREATEST(trial_ends_at, NOW()) + make_interval(days => $1), updated_at = NOW() WHERE user_id = $2`,
      [days, user_id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/subscription/activate', requireSeller, async (req, res) => {
  try {
    const { user_id, days = 365, billing_cycle = 'yearly' } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, billing_cycle, status, trial_starts_at, trial_ends_at, paid_until)
       VALUES ($1, $2, $2, 'active', NOW(), NOW(), NOW() + make_interval(days => $3))
       ON CONFLICT (user_id) DO UPDATE
         SET status = 'active', billing_cycle = $2, plan = $2,
             paid_until = NOW() + make_interval(days => $3), updated_at = NOW()`,
      [user_id, billing_cycle, days]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seller/subscription/reset', requireSeller, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await pool.query(
      `UPDATE subscriptions SET status='trial', trial_starts_at=NOW(), trial_ends_at=NOW()+INTERVAL '30 days', paid_until=NULL, grace_until=NULL, updated_at=NOW() WHERE user_id=$1`,
      [user_id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Run migrations on startup ──────────────────────────────────────────────────
(async () => {
  const migrationFiles = ['migrations/003_subscriptions.sql'];
  for (const file of migrationFiles) {
    try {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      await pool.query(sql);
      console.log(`✅ Migration applied: ${file}`);
    } catch (err) {
      console.error(`❌ Migration failed (${file}):`, err.message);
    }
  }
  // Ensure reminder_sent column exists on already-migrated deployments
  try {
    await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_sent JSONB DEFAULT '{}'`);
  } catch (err) {
    console.error('reminder_sent column migration failed:', err.message);
  }
  // Ensure geo_score column exists on already-created documents tables
  try {
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS geo_score INTEGER DEFAULT 0`);
  } catch (err) {
    console.error('geo_score column migration failed:', err.message);
  }
})();

// ── System landing gate ──────────────────────────────────────────────────────
// Visiting a tool's URL (e.g. /content) always shows that tool's tailored
// landing page first — for everyone, signed in or out. "Open Tool" adds
// ?enter=1 to proceed into the module. The /app hub is exempt so login and the
// homepage's ?goto deep-links load the SPA directly.
const subsystemPages = require('./routes/subsystemPages');
app.use((req, res, next) => {
  if (req.method === 'GET' && req.query.enter === undefined && req.path !== '/app') {
    const sys = subsystemPages.SYSTEMS.find(s => s.appUrl === req.path);
    if (sys) return res.send(subsystemPages.buildSystemPage(sys));
  }
  next();
});

// Page routes
app.get('/app',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/admin',    (req, res) => res.redirect('/seller'));
app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/seller',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'seller.html')));
app.get('/content',  checkModule('content'),  (req, res) => res.sendFile(path.join(__dirname, 'public', 'content.html')));
app.get('/social',   checkModule('social'),   (req, res) => res.sendFile(path.join(__dirname, 'public', 'social.html')));
app.get('/mail',     checkModule('mail'),     (req, res) => res.sendFile(path.join(__dirname, 'public', 'mail.html')));
app.get('/ads',      checkModule('ads'),      (req, res) => res.sendFile(path.join(__dirname, 'public', 'ads.html')));
app.get('/seo',      checkModule('seo'),      (req, res) => res.sendFile(path.join(__dirname, 'public', 'seo.html')));
app.get('/commerce', checkModule('commerce'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'commerce.html')));
app.get('/sales',    checkModule('sales'),    (req, res) => res.sendFile(path.join(__dirname, 'public', 'sales.html')));
app.get('/aichat',   checkModule('aichat'),   (req, res) => res.sendFile(path.join(__dirname, 'public', 'aichat.html')));
app.get('/gao',      checkModule('gao'),      (req, res) => res.sendFile(path.join(__dirname, 'public', 'gao.html')));
app.get('/pr',       checkModule('pr'),       (req, res) => res.redirect('/app?goto=pr'));
app.get('/audiobook', checkModule('audiobook'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'audiobook.html')));

// Public per-system landing pages (no auth)
app.use('/systems', require('./routes/subsystemPages'));

// Ecosystem-consistent alias: every Modus platform answers /modules/<slug>.
// Canonical per-system pages live at /systems; these redirect there so shared
// /modules links resolve. Slug guarded to a single safe segment.
app.get('/modules', (_req, res) => res.redirect(302, '/systems'));
app.get('/modules/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return res.redirect(302, '/systems');
  res.redirect(302, '/systems/' + slug);
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║       M-EasyTools AI — Full Platform Server v4.0       ║
╠══════════════════════════════════════════════════╣
║  URL:  http://localhost:${PORT}                      ║
╠══════════════════════════════════════════════════╣
║  Groq AI:        ${GROQ_KEY    ? '✓ Ready (FREE)        ' : '✗ Add GROQ_API_KEY     '}  ║
║  Google OAuth:   ${GOOGLE_ID   ? '✓ Configured          ' : '✗ Add GOOGLE_CLIENT_ID '}  ║
║  WordPress API:  ✓ Ready                        ║
║  Shopify API:    ✓ Ready                        ║
║  Developer API:  ✓ Ready                        ║
║  Seller Panel:   ✓ Ready (/seller)              ║
║  Team Workspaces:✓ Ready                        ║
║  Content Scoring:✓ Ready                        ║
║  Billing System: ✓ Ready (/billing)             ║
╚══════════════════════════════════════════════════╝
`);
});

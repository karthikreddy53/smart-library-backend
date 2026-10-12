const { existsSync, mkdirSync } = require("node:fs");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const cors = require("cors");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const bundledFrontendRoot = __dirname;
const siblingFrontendRoot = path.resolve(__dirname, "..", "frontend");
const frontendRoot = existsSync(path.join(bundledFrontendRoot, "index.html"))
  ? bundledFrontendRoot
  : siblingFrontendRoot;
const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
const allowedOrigins = new Set([
  frontendUrl,
  "http://localhost:3000",
  "http://localhost:5173",
]);
const dataDirectory = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "data"),
);
const adminUsername = process.env.LIBRARY_ADMIN_USERNAME;
const adminPassword = process.env.LIBRARY_ADMIN_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
const sessionCookieName = "library_session";
const sessionDurationSeconds = 8 * 60 * 60;
const loginAttemptWindowMs = 15 * 60 * 1000;
const maxLoginAttempts = 10;
const loginAttempts = new Map();
const activeSessions = new Map();
const publicPaths = new Set([
  "/login",
  "/app.js",
  "/styles.css",
  "/api/login",
  "/api/health",
]);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
if (!adminUsername || adminUsername.length > 128) {
  throw new Error("Set LIBRARY_ADMIN_USERNAME to a value of 1 to 128 characters.");
}
if (!adminPassword || adminPassword.length < 12 || adminPassword.length > 1024) {
  throw new Error("Set LIBRARY_ADMIN_PASSWORD to a value of 12 to 1024 characters.");
}
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signSession(payload) {
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookiePrefix = `${sessionCookieName}=`;
  const cookie = cookieHeader.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(cookiePrefix));
  if (!cookie) return null;

  const token = cookie.slice(cookiePrefix.length);
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expectedSignature = signSession(payload);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (session.username !== adminUsername || !Number.isFinite(session.expiresAt)
        || session.expiresAt <= Date.now() || typeof session.nonce !== "string"
        || activeSessions.get(session.nonce) !== session.expiresAt) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDurationSeconds}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  );
}

mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(path.join(dataDirectory, "library.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    isbn TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    shelf_location TEXT NOT NULL DEFAULT '',
    published_year INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS books_title_idx ON books(title);
  CREATE INDEX IF NOT EXISTS books_author_idx ON books(author);
  CREATE INDEX IF NOT EXISTS books_isbn_idx ON books(isbn);
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
    issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    due_at TEXT NOT NULL,
    returned_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS loans_one_active_per_book_idx
    ON loans(book_id) WHERE returned_at IS NULL;
  CREATE INDEX IF NOT EXISTS loans_member_idx ON loans(member_id);
  CREATE INDEX IF NOT EXISTS loans_due_at_idx ON loans(due_at) WHERE returned_at IS NULL;
`);

const listBooks = database.prepare(`
  SELECT id, title, author, isbn, category, shelf_location, published_year,
         created_at, updated_at,
         CASE WHEN EXISTS (
           SELECT 1 FROM loans l WHERE l.book_id = books.id AND l.returned_at IS NULL
         ) THEN 0 ELSE 1 END AS available
  FROM books
  WHERE (? = '' OR title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\'
         OR isbn LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
         OR shelf_location LIKE ? ESCAPE '\\')
  ORDER BY title COLLATE NOCASE, author COLLATE NOCASE, id DESC
`);
const getBook = database.prepare(`
  SELECT id, title, author, isbn, category, shelf_location, published_year,
         created_at, updated_at
  FROM books
  WHERE id = ?
`);
const insertBook = database.prepare(`
  INSERT INTO books (title, author, isbn, category, shelf_location, published_year)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const updateBook = database.prepare(`
  UPDATE books
  SET title = ?, author = ?, isbn = ?, category = ?, shelf_location = ?,
      published_year = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);
const deleteBook = database.prepare("DELETE FROM books WHERE id = ?");
const listMembers = database.prepare(`
  SELECT m.id, m.name, m.email, m.phone, m.created_at,
         COUNT(l.id) AS loan_count,
         COUNT(CASE WHEN l.id IS NOT NULL AND l.returned_at IS NULL THEN 1 END) AS active_loan_count
  FROM members m
  LEFT JOIN loans l ON l.member_id = m.id
  WHERE (? = '' OR m.name LIKE ? ESCAPE '\\' OR m.email LIKE ? ESCAPE '\\' OR m.phone LIKE ? ESCAPE '\\')
  GROUP BY m.id
  ORDER BY m.name COLLATE NOCASE, m.id DESC
`);
const getMember = database.prepare(
  "SELECT id, name, email, phone, created_at FROM members WHERE id = ?",
);
const insertMember = database.prepare(
  "INSERT INTO members (name, email, phone) VALUES (?, ?, ?)",
);
const updateMember = database.prepare(`
  UPDATE members
  SET name = ?, email = ?, phone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);
const deleteMember = database.prepare("DELETE FROM members WHERE id = ?");
const listLoans = database.prepare(`
  SELECT l.id, l.book_id, l.member_id, b.title, b.author, b.isbn,
         m.name AS member_name, m.email AS member_email,
         l.issued_at, l.due_at, l.returned_at,
         CASE
           WHEN l.returned_at IS NOT NULL THEN 'returned'
           WHEN date(l.due_at) < date('now') THEN 'overdue'
           ELSE 'active'
         END AS status
  FROM loans l
  JOIN books b ON b.id = l.book_id
  JOIN members m ON m.id = l.member_id
  WHERE (? = 'all' OR
         (? = 'active' AND l.returned_at IS NULL AND date(l.due_at) >= date('now')) OR
         (? = 'overdue' AND l.returned_at IS NULL AND date(l.due_at) < date('now')) OR
         (? = 'returned' AND l.returned_at IS NOT NULL))
  ORDER BY CASE WHEN l.returned_at IS NULL THEN 0 ELSE 1 END,
           l.due_at ASC, l.issued_at DESC
`);
const getLoan = database.prepare(`
  SELECT l.id, l.book_id, l.member_id, b.title, b.author,
         m.name AS member_name, m.email AS member_email,
         l.issued_at, l.due_at, l.returned_at,
         CASE
           WHEN l.returned_at IS NOT NULL THEN 'returned'
           WHEN date(l.due_at) < date('now') THEN 'overdue'
           ELSE 'active'
         END AS status
  FROM loans l
  JOIN books b ON b.id = l.book_id
  JOIN members m ON m.id = l.member_id
  WHERE l.id = ?
`);
const getBookAvailability = database.prepare(`
  SELECT b.id, b.title, b.author,
         CASE WHEN EXISTS (
           SELECT 1 FROM loans l WHERE l.book_id = b.id AND l.returned_at IS NULL
         ) THEN 0 ELSE 1 END AS available
  FROM books b
  ORDER BY b.title COLLATE NOCASE, b.id
`);
const getMemberAvailability = database.prepare(
  "SELECT id, name, email FROM members ORDER BY name COLLATE NOCASE, id",
);
const getStats = database.prepare(`
  SELECT
    (SELECT COUNT(*) FROM books) AS total_books,
    (SELECT COUNT(*) FROM books b WHERE NOT EXISTS (
      SELECT 1 FROM loans l WHERE l.book_id = b.id AND l.returned_at IS NULL
    )) AS available_books,
    (SELECT COUNT(*) FROM members) AS total_members,
    (SELECT COUNT(*) FROM loans WHERE returned_at IS NULL) AS active_loans,
    (SELECT COUNT(*) FROM loans WHERE returned_at IS NULL AND date(due_at) < date('now')) AS overdue_loans
`);
const findBook = database.prepare("SELECT id FROM books WHERE id = ?");
const findMember = database.prepare("SELECT id FROM members WHERE id = ?");
const findActiveLoan = database.prepare(
  "SELECT id FROM loans WHERE book_id = ? AND returned_at IS NULL",
);
const insertLoan = database.prepare(
  "INSERT INTO loans (book_id, member_id, due_at) VALUES (?, ?, ?)",
);
const returnLoan = database.prepare(`
  UPDATE loans
  SET returned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ? AND returned_at IS NULL
`);

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(express.json({ limit: "32kb" }));
app.use(cors({
  origin(origin, callback) {
    return callback(null, !origin || allowedOrigins.has(origin));
  },
  credentials: true,
}));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const sameOrigin = origin === `${req.protocol}://${req.get("host")}`;
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Requests from this origin are not allowed." });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  for (const [nonce, expiresAt] of activeSessions) {
    if (expiresAt <= now) activeSessions.delete(nonce);
  }
  if (publicPaths.has(req.path)) return next();
  if (getSessionToken(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Please log in to continue." });
  }
  return res.redirect("/login");
});

app.post("/api/login", (req, res) => {
  const now = Date.now();
  for (const [ip, attempts] of loginAttempts) {
    if (attempts.resetAt <= now) loginAttempts.delete(ip);
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const attempts = loginAttempts.get(ip);
  if (attempts && attempts.count >= maxLoginAttempts) {
    return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });
  }

  const username = req.body && typeof req.body.username === "string" ? req.body.username : "";
  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!safeEqual(username, adminUsername) || !safeEqual(password, adminPassword)) {
    if (!attempts && loginAttempts.size >= 10000) {
      return res.status(429).json({ error: "Login is temporarily unavailable. Try again shortly." });
    }
    loginAttempts.set(ip, {
      count: (attempts && attempts.resetAt > now ? attempts.count : 0) + 1,
      resetAt: attempts && attempts.resetAt > now ? attempts.resetAt : now + loginAttemptWindowMs,
    });
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  loginAttempts.delete(ip);
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = now + sessionDurationSeconds * 1000;
  activeSessions.set(nonce, expiresAt);
  const payload = Buffer.from(JSON.stringify({
    username: adminUsername,
    expiresAt,
    nonce,
  })).toString("base64url");
  setSessionCookie(res, `${payload}.${signSession(payload)}`);
  return res.json({ authenticated: true });
});

app.post("/api/logout", (req, res) => {
  const session = getSessionToken(req);
  if (session) activeSessions.delete(session.nonce);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/health", (req, res) => {
  database.prepare("SELECT 1").get();
  res.json({ status: "ok", database: "connected" });
});

app.get("/api/session", (req, res) => {
  res.json({ authenticated: true });
});

app.get("/api/stats", (req, res) => {
  res.json({ stats: getStats.get() });
});

app.get("/api/books", (req, res) => {
  if (req.query.search !== undefined && typeof req.query.search !== "string") {
    return res.status(400).json({ error: "Search must be a single text value." });
  }

  const search = (req.query.search || "").trim();
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const books = listBooks.all(search, pattern, pattern, pattern, pattern, pattern);
  res.json({ books });
});

app.post("/api/books", (req, res) => {
  const book = validateBook(req.body);
  if (book.error) return res.status(400).json({ error: book.error });

  const result = insertBook.run(...book.values);
  res.status(201).json({ book: getBook.get(Number(result.lastInsertRowid)) });
});

app.put("/api/books/:id", (req, res) => {
  const id = parseBookId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Book ID must be a positive integer." });
  }

  const book = validateBook(req.body);
  if (book.error) return res.status(400).json({ error: book.error });

  const result = updateBook.run(...book.values, id);
  if (result.changes === 0) {
    return res.status(404).json({ error: "Book not found." });
  }
  res.json({ book: getBook.get(id) });
});

app.delete("/api/books/:id", (req, res) => {
  const id = parseBookId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Book ID must be a positive integer." });
  }
  try {
    if (deleteBook.run(id).changes === 0) {
      return res.status(404).json({ error: "Book not found." });
    }
  } catch (error) {
    if (error.errcode === 787 || error.errcode === 1811) {
      return res.status(409).json({ error: "This book has loan history and cannot be deleted." });
    }
    throw error;
  }
  res.status(204).end();
});

app.get("/api/members", (req, res) => {
  if (req.query.search !== undefined && typeof req.query.search !== "string") {
    return res.status(400).json({ error: "Search must be a single text value." });
  }

  const search = (req.query.search || "").trim();
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  res.json({ members: listMembers.all(search, pattern, pattern, pattern) });
});

app.post("/api/members", (req, res) => {
  const member = validateMember(req.body);
  if (member.error) return res.status(400).json({ error: member.error });

  try {
    const result = insertMember.run(...member.values);
    return res.status(201).json({ member: getMember.get(Number(result.lastInsertRowid)) });
  } catch (error) {
    if (error.errcode === 2067) {
      return res.status(409).json({ error: "A member with that email already exists." });
    }
    throw error;
  }
});

app.put("/api/members/:id", (req, res) => {
  const id = parseBookId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Member ID must be a positive integer." });
  }
  const member = validateMember(req.body);
  if (member.error) return res.status(400).json({ error: member.error });

  try {
    if (updateMember.run(...member.values, id).changes === 0) {
      return res.status(404).json({ error: "Member not found." });
    }
    return res.json({ member: getMember.get(id) });
  } catch (error) {
    if (error.errcode === 2067) {
      return res.status(409).json({ error: "A member with that email already exists." });
    }
    throw error;
  }
});

app.delete("/api/members/:id", (req, res) => {
  const id = parseBookId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Member ID must be a positive integer." });
  }
  try {
    if (deleteMember.run(id).changes === 0) {
      return res.status(404).json({ error: "Member not found." });
    }
  } catch (error) {
    if (error.errcode === 787 || error.errcode === 1811) {
      return res.status(409).json({ error: "This member has loan history and cannot be deleted." });
    }
    throw error;
  }
  res.status(204).end();
});

app.get("/api/loans", (req, res) => {
  const status = req.query.status === undefined ? "all" : req.query.status;
  if (!["all", "active", "overdue", "returned"].includes(status)) {
    return res.status(400).json({ error: "Status must be all, active, overdue, or returned." });
  }
  res.json({ loans: listLoans.all(status, status, status, status) });
});

app.get("/api/loan-options", (req, res) => {
  res.json({
    books: getBookAvailability.all(),
    members: getMemberAvailability.all(),
  });
});

app.post("/api/loans", (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object." });
  }
  const bookId = parseBookId(String(req.body.book_id ?? ""));
  const memberId = parseBookId(String(req.body.member_id ?? ""));
  const dueAt = req.body.due_at;
  if (bookId === null || memberId === null) {
    return res.status(400).json({ error: "Select a valid book and member." });
  }
  if (typeof dueAt !== "string" || !isValidDateOnly(dueAt)) {
    return res.status(400).json({ error: "Due date must be a valid date in YYYY-MM-DD format." });
  }
  if (dueAt < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: "Due date cannot be in the past." });
  }
  if (!findBook.get(bookId)) {
    return res.status(404).json({ error: "Book not found." });
  }
  if (!findMember.get(memberId)) {
    return res.status(404).json({ error: "Member not found." });
  }
  if (findActiveLoan.get(bookId)) {
    return res.status(409).json({ error: "That book is already checked out." });
  }

  try {
    const result = insertLoan.run(bookId, memberId, dueAt);
    return res.status(201).json({ loan: getLoan.get(Number(result.lastInsertRowid)) });
  } catch (error) {
    if (error.errcode === 2067) {
      return res.status(409).json({ error: "That book is already checked out." });
    }
    throw error;
  }
});

app.post("/api/loans/:id/return", (req, res) => {
  const id = parseBookId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Loan ID must be a positive integer." });
  }
  const result = returnLoan.run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: "Active loan not found; it may already be returned." });
  }
  res.json({ loan: getLoan.get(id) });
});

app.get("/api/books/:id/availability", (req, res) => {
  const id = parseBookId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Book ID must be a positive integer." });
  }
  const book = getBookAvailability.get(id);
  if (!book) {
    return res.status(404).json({ error: "Book not found." });
  }
  res.json({ book });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.get("/login", (req, res) => {
  if (existsSync(path.join(frontendRoot, "index.html"))) {
    return res.sendFile(path.join(frontendRoot, "index.html"));
  }
  res.redirect(frontendUrl);
});

app.get("/login.html", (req, res) => {
  res.redirect(frontendUrl);
});

app.get("/", (req, res) => {
  if (existsSync(path.join(frontendRoot, "index.html"))) {
    return res.sendFile(path.join(frontendRoot, "index.html"));
  }
  res.json({ name: "Smart Library Management API", status: "ok" });
});

app.get("/styles.css", (req, res) => {
  if (!existsSync(path.join(frontendRoot, "styles.css"))) {
    return res.status(404).end();
  }
  res.sendFile(path.join(frontendRoot, "styles.css"));
});

app.get("/app.js", (req, res) => {
  if (!existsSync(path.join(frontendRoot, "app.js"))) {
    return res.status(404).end();
  }
  res.sendFile(path.join(frontendRoot, "app.js"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must contain valid JSON." });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
  console.error(error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

function validateBook(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const fields = [
    ["title", "Title", 255],
    ["author", "Author", 255],
    ["isbn", "ISBN", 32],
    ["category", "Category", 100],
    ["shelf_location", "Shelf location", 80],
  ];
  const values = {};

  for (const [key, label, maximum] of fields) {
    const value = body[key] === undefined && key !== "title" && key !== "author"
      ? ""
      : body[key];
    if (typeof value !== "string") {
      return { error: `${label} must be text.` };
    }
    values[key] = value.trim();
    if ((key === "title" || key === "author") && !values[key]) {
      return { error: `${label} is required.` };
    }
    if (values[key].length > maximum) {
      return { error: `${label} must be ${maximum} characters or fewer.` };
    }
  }

  const yearValue = body.published_year;
  let publishedYear = null;
  if (yearValue !== undefined && yearValue !== null && yearValue !== "") {
    publishedYear = Number(yearValue);
    if (!Number.isInteger(publishedYear) || publishedYear < 1000 || publishedYear > 2100) {
      return { error: "Publication year must be a whole number between 1000 and 2100." };
    }
  }

  return {
    values: [
      values.title,
      values.author,
      values.isbn,
      values.category,
      values.shelf_location,
      publishedYear,
    ],
  };
}

function validateMember(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = body.phone === undefined ? "" : body.phone;

  if (!name) return { error: "Member name is required." };
  if (name.length > 160) return { error: "Member name must be 160 characters or fewer." };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (typeof phone !== "string") return { error: "Phone must be text." };
  if (phone.trim().length > 40) return { error: "Phone must be 40 characters or fewer." };

  return { values: [name, email, phone.trim()] };
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseBookId(value) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

const server = app.listen(port, host, () => {
  console.log(`Library server listening at http://localhost:${port}`);
  console.log(`SQLite database: ${path.join(dataDirectory, "library.sqlite")}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

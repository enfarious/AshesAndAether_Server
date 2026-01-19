import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import connectPg from "connect-pg-simple";
import crypto from "crypto";
import { logger } from "@/utils/logger";

function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    logger.warn("SESSION_SECRET is not set; using an ephemeral secret for this session");
  }

  const pgStore = connectPg(session);
  const sessionStore = process.env.DATABASE_URL
    ? new pgStore({
        conString: process.env.DATABASE_URL,
        createTableIfMissing: true,
        ttl: sessionTtl,
        tableName: "sessions",
      })
    : undefined;

  return session({
    secret: sessionSecret ?? crypto.randomBytes(32).toString("hex"),
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: sessionTtl,
    },
  });
}

function buildFakeUser(req: { query?: Record<string, unknown> }) {
  const query = req.query ?? {};
  const name = typeof query.name === "string" ? query.name : "Dev Player";
  const email = typeof query.email === "string" ? query.email : "dev@ashesandaether.local";
  const avatar = typeof query.avatar === "string" ? query.avatar : undefined;

  return {
    claims: {
      first_name: name,
      email,
      profile_image_url: avatar,
    },
    accountId: "dev-account",
    expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  } as Express.User;
}

export async function setupAuth(app: Express): Promise<void> {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    const user = buildFakeUser(req);
    req.login(user, (err) => {
      if (err) return next(err);
      return res.redirect("/");
    });
  });

  app.get("/api/callback", (req, res, next) => {
    const user = buildFakeUser(req);
    req.login(user, (err) => {
      if (err) return next(err);
      return res.redirect("/");
    });
  });

  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect("/");
    });
  });

  logger.info("Fake auth configured (dev mode)");
}

export function registerAuthRoutes(app: Express): void {
  app.get("/api/auth/user", (req, res) => {
    if (req.isAuthenticated() && req.user) {
      res.json(req.user);
    } else {
      res.status(401).json({ message: "Not authenticated" });
    }
  });
}

export const isAuthenticated: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated() && req.user) {
    return next();
  }
  return res.status(401).json({ message: "Unauthorized" });
};

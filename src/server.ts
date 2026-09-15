import express from "express";
import dotenv from "dotenv";

dotenv.config();
// Global output directory setup -1
declare global {
  const outputDirectory: string;
}

// Extend express-session SessionData to include testData
declare module "express-session" {
  interface SessionData {
    testData?: {
      created: string;
      sessionId: string;
      testValue: string;
    };
  }
}

//LOAD SECRETS FIRST - Before any other imports that use config
import { loadSecrets, areSecretsLoaded } from "./config/config";

import prismaSqlServer from "./config/sqlServerClient";
import prismaPostgres from "./config/postgresClient";

export { prismaSqlServer, prismaPostgres };

const startServer = async () => {
  try {
    console.log("Loading secrets from AWS Secrets Manager...");
    await loadSecrets();

    if (!areSecretsLoaded()) {
      throw new Error("Failed to load secrets from AWS Secrets Manager");
    }
    console.log("All secrets loaded successfully");


    //SET ENVIRONMENT VARIABLES HERE - BEFORE DYNAMIC IMPORTS
    // const configDB = await import('./config/config').then(m => m.default);
    // process.env.DATABASE_URL = configDB.prismaDbUrl;
    // process.env.DATABASE_URL2 = configDB.prismaPostgresDbUrl;
    // await updateEnvFile(configDB);
    // console.log('Set DATABASE_URL:', process.env.DATABASE_URL ? "***" : 'NOT SET');
    // console.log('Set DATABASE_URL2:', process.env.DATABASE_URL2 ? "***" : 'NOT SET');

    //NOW DYNAMICALLY IMPORT ALL MODULES THAT USE CONFIG
    const allRoutes = await import("./api/routes/index").then((m) => m.default);
    const helmet = await import("helmet").then((m) => m.default);
    const SwaggerUi = await import("swagger-ui-express").then((m) => m.default);
    const swaggerDocs = await import("../swagger/rule.json").then((m) => m);
    // const swaggerDocs = await import("../swagger/pivvot_rules.json").then(m => m);
    const config = await import("./config/config").then((m) => m.default);


    const { connectDB } = await import("./config/config");
    const momentTimeZone = await import("moment-timezone").then(
      (m) => m.default,
    );
    const firebaseInit = await import("./config/firebase");
    const fs = await import("fs").then((m) => m.default);
    const path = await import("path").then((m) => m.default);
    const { connectToMySQLDatabase } = await import("./config/mysqlConnection");
    const { Server } = require("socket.io");
    const logger = await import("morgan").then((m) => m.default);
    const ssoRoutes = await import("./api/routes/ssoRoute").then(
      (m) => m.default,
    );
    const session = await import("express-session").then((m) => m.default);
    const { fetchPrivateKey } = await import("./config/fetchPrivateKey");
    const logsService = await import("./api/services/logsService").then(
      (m) => m.default,
    );
    const { isValidJSON } = await import("./api/core/common");
    const MySQLStoreFactory = await import("express-mysql-session").then(
      (m) => m.default,
    );
    const { startChallengeReminderJob } =
      await import("./jobs/challengeReminderJob");
    const { startLeaderboardCron, startEodNotificationCron } = await import("./jobs/leaderboardJob");
    const { processUserChallengeNotifications, getUserIdByExternalId } = await import("./jobs/leaderboardJob");

    const { startWellnessPromptCron } = await import("./jobs/wellnessPromptCron");
    const { PrismaClient } = await import("@prisma/client");
    const crashProofSystem = await import("./api/lib/crash-proof-system");
    const cronService = await import("./api/services/cronService").then(
      (m) => m.default,
    );
    const { SERVER_CONFIG } = await import("./config/serverConfig");
    const { initTokenRefreshCron, stopTokenRefreshCron } =
      await import("./jobs/xoxodayJob");
    const { startEventReminderJob, stopEventReminderJob } =
      await import("./jobs/eventReminderJob");
    const { warmVoucherCache, startVoucherCacheRefresh, stopVoucherCacheRefresh } = await import('./api/cache/voucherCacheService');


    // NOW INITIALIZE YOUR SERVER WITH ALL IMPORTED MODULES
    const app = express();

    const timezone = momentTimeZone.tz.guess();
    console.log("Server timezone:", timezone);

    // Initialize crash-proof system
    crashProofSystem.x();
    const appLogger = crashProofSystem.ApplicationLogger.getInstance();
    const dbManager = crashProofSystem.DatabaseConnectionManager.getInstance();

    // Log server startup
    appLogger.info("system", "Server starting", {
      port: process.env.PORT_NO || 3001,
      environment: process.env.NODE_ENV,
      timezone: timezone,
    });

    // Connect to MySQL (SQL Server) with error handling
    connectToMySQLDatabase()
      .then(() => {
        appLogger.info("system", "MySQL connection established");
      })
      .catch((err) => {
        appLogger.error("system", "MySQL Connection Error", {
          error: err.message,
        });
      });

    // Initialize database connection
    dbManager.connect().then((connected) => {
      if (connected) {
        appLogger.info("system", "Initial database connection successful");
      } else {
        appLogger.warn(
          "system",
          "Initial database connection failed - will retry automatically",
        );
      }
    });

    // Initialize mongodb
    connectDB()
      .then(() => {
        appLogger.info(
          "mongodb connection",
          "Initial mongodb database connection successful",
        );
      })
      .catch((err: any) => {
        console.error("❌ Failed to connect to DB", err);
      });

    // CORS configuration
    const apiCorsOptions = {
      origin: [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5000",
        "http://localhost:3002",
        "http://localhost:8000",
        "http://localhost:5001",
        `${config.frontendServerUrl}`,
        `${config.backendServerUrl}`,
        `${SERVER_CONFIG?.BACKEND_SERVER_URL}`,
        `${SERVER_CONFIG?.FRONTEND_SERVER_URL}`,
        `https://fe-dev.pivvot.life`,
        `https://fe-uat.pivvot.life`,
        "https://be-uat.pivvot.life",
        "https://be-dev.pivvot.life",
        "52.76.120.90" // xoxoday webhook IP
      ],
    };

    const ssoCorsOptions = {
      origin: [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://localhost:5000",
        "http://localhost:8000",
        `${config.frontendServerUrl}`,
        `${config.backendServerUrl}`,
        `${SERVER_CONFIG?.BACKEND_SERVER_URL}`,
        `${SERVER_CONFIG?.FRONTEND_SERVER_URL}`,
        `https://fe-dev.pivvot.life`,
        `https://fe-uat.pivvot.life`,
        "https://be-uat.pivvot.life",
        "https://be-dev.pivvot.life",
        "52.76.120.90" // xoxoday webhook IP
      ],
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Cookie",
        "token",
        "azureLogin",
        "Accept",
        "timezone",
        "X-Requested-With",
        "Strict-Transport-Security",
      ],
      exposedHeaders: ["Set-Cookie"],
      optionsSuccessStatus: 200,
      preflightContinue: false,
    };

    // Apply basic CORS globally
    const cors = require("cors");
    app.use(cors(apiCorsOptions));

    // Trust proxy for Azure
    app.set("trust proxy", 1);

    const port = process.env.PORT_NO || 3000;

    // Server timeout middleware
    const SERVER_TIMEOUT = 60000;
    app.use((req, res, next) => {
      req.setTimeout(SERVER_TIMEOUT, () => {
        appLogger.warn("system", "Request timed out", {
          url: req.url,
          method: req.method,
        });
        res.status(408).send("Request Timeout");
      });
      next();
    });

    // Basic middleware setup
    // app.use(express.json());
    // app.use(express.urlencoded({ extended: true }));
    app.use(express.json({ limit: "20mb" }));
    app.use(express.urlencoded({ limit: "20mb", extended: true }));

    app.set("views", path.join(__dirname, "views"));
    app.set("view engine", "hbs");
    app.use(logger("dev"));

    // Use crash-proof session store
    const sessionStore = new crashProofSystem.CrashProofSessionStore();
    appLogger.info("system", "Crash-proof session store initialized");

    // Session middleware configuration
    const sessionMiddleware = session({
      // config.ssoConfig.expressSecret already has its own safe placeholder
      // fallback (SSO_EXPRESS_SECRET env var, else "dev-local-sso-secret-
      // change-me" — see config/config.ts) — a second hardcoded secret-shaped
      // string here was dead code in normal operation and tripped GitHub's
      // push-protection secret scanner (flagged as an Azure AD app secret).
      secret: config.ssoConfig.expressSecret,
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        domain:
          process.env.NODE_ENV === "production" ? ".evvosports.com" : undefined,
      },
      store: sessionStore,
      name: "wms.session.id",
      genid: function (req) {
        const sessionId = require("crypto").randomBytes(16).toString("hex");
        appLogger.debug("session", "Generated new SSO session ID", {
          sessionId,
        });
        return sessionId;
      },
    });

    // Enhanced session debugging middleware
    const sessionDebugMiddleware = (req: any, res: any, next: any) => {
      const originalSave = req.session.save;
      const originalDestroy = req.session.destroy;

      req.session.save = function (callback: any) {
        appLogger.debug("session", "Session SAVE called", {
          sessionId: req.sessionID,
          sessionKeys: Object.keys(this),
        });
        return originalSave.call(this, callback);
      };

      req.session.destroy = function (callback: any) {
        appLogger.debug("session", "Session DESTROY called", {
          sessionId: req.sessionID,
        });
        return originalDestroy.call(this, callback);
      };

      next();
    };

    // Auth route debugging middleware
    const authDebugMiddleware = (req: any, res: any, next: any) => {
      appLogger.debug("auth", "Auth route accessed", {
        sessionId: req.sessionID,
        sessionExists: !!req.session,
        sessionKeys: req.session ? Object.keys(req.session) : "none",
        cookies: req.headers.cookie ? "present" : "none",
        url: req.url,
        method: req.method,
      });
      next();
    };

    // cron job
    cronService.initializeCronJob();

    // Placeholder meal-photo image, served at the root (no /api/v1 prefix) —
    // ported from backend-node's app.ts (`sendDemoMealImage`). scanMeal /
    // getUpcomingRoutine's default_demo_image_path fallback (used whenever
    // a real product/meal photo isn't available) points here; without this
    // route those image_url/thumbnail_url links 404.
    const demoMealImagePath = require("path").resolve(__dirname, "..", "assets", "default-demo-meal.png");
    app.get(
      ["/i/default-demo-meal.jpg", "/i/default-demo-meal", "/i/demo-food-photo.jpg"],
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!require("fs").existsSync(demoMealImagePath)) return next();
        res.type("png");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.sendFile(demoMealImagePath);
      },
    );

    // Uploaded meal photos (addMeal type 2 image recognition) — stored as
    // bytes in the `media_files` table (no disk/object storage wired in this
    // checkout), served back here. Filenames are randomUUID()-based, so a
    // strict basename match is enough to prevent path traversal.
    app.get("/media/:filename", async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const filename = req.params.filename;
      if (!/^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(filename)) return next();
      try {
        const file = await prismaSqlServer.media_files.findUnique({ where: { filename } });
        if (!file) return next();
        res.setHeader("Content-Type", file.mime);
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.send(Buffer.from(file.content));
      } catch (err) {
        return next(err);
      }
    });

    // Apply routes in correct order
    // Regular API routes WITHOUT session middleware
    app.use("/api/v1", allRoutes);

    // SSO routes with enhanced CORS and session middleware
    app.use(
      "/auth",
      authDebugMiddleware,
      cors(ssoCorsOptions),
      sessionMiddleware,
      sessionDebugMiddleware,
      ssoRoutes,
    );

    // Other middleware
    app.use(helmet());
    app.use("/wms/swagger", SwaggerUi.serve, SwaggerUi.setup(swaggerDocs));

    // Debug endpoints with session middleware
    app.get("/debug/sessions", sessionMiddleware, async (req, res) => {
      try {
        appLogger.debug("debug", "Debug sessions endpoint accessed");

        // Get database connection status and session info
        const dbConnected = dbManager.isConnectionAvailable();
        const sessionInfo = {
          currentSessionId: req.sessionID,
          sessionExists: !!req.session,
          sessionKeys: req.session ? Object.keys(req.session) : [],
          databaseConnected: dbConnected,
          storeType: "CrashProofSessionStore",
        };

        appLogger.info("debug", "Session debug info retrieved", sessionInfo);

        res.json({
          ...sessionInfo,
          message: "Debug session info retrieved successfully",
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        appLogger.error("debug", "Debug sessions endpoint failed", {
          error: error.message,
        });
        res.status(500).json({ error: error.message });
      }
    });

    app.get(
      "/debug/create-test-session",
      sessionMiddleware,
      sessionDebugMiddleware,
      (req, res) => {
        try {
          appLogger.debug("debug", "Creating test session");
          req.session.testData = {
            created: new Date().toISOString(),
            sessionId: req.sessionID,
            testValue: "Hello from session!",
          };

          req.session.save((err) => {
            if (err) {
              appLogger.error("debug", "Test session save failed", {
                error: err.message,
              });
              return res.status(500).json({ error: err.message });
            }

            appLogger.info("debug", "Test session created successfully");
            res.json({
              message: "Test session created",
              sessionID: req.sessionID,
              testData: req.session.testData,
            });
          });
        } catch (error: any) {
          appLogger.error("debug", "Test session creation failed", {
            error: error.message,
          });
          res.status(500).json({ error: error.message });
        }
      },
    );



    // Test by userId directly
    app.get('/test/challenge-notifications/:userId', async (req, res) => {
      const userId = Number(req.params.userId);
      console.log(`[TEST] Triggering processUserChallengeNotifications for userId: ${userId}`);
      await processUserChallengeNotifications(userId, true); // ← bypass
      res.json({ ok: true, message: `Processed userId ${userId} — check server logs` });
    });

    // Test by externalId (same as webhook flow)
    app.get('/test/challenge-notifications/external/:externalId', async (req, res) => {
      const { externalId } = req.params;
      const userId = await getUserIdByExternalId(externalId);
      if (!userId) return res.json({ ok: false, message: `No user found for externalId: ${externalId}` });

      console.log(`[TEST] Found userId ${userId} for externalId ${externalId}`);
      await processUserChallengeNotifications(userId);
      res.json({ ok: true, message: `Processed userId ${userId} — check server logs` });
    });


    const outputDirectory = path.join(__dirname, "../src", "generatedFile");

    if (!fs.existsSync(outputDirectory)) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      appLogger.info("system", "Generated file directory created", {
        path: outputDirectory,
      });
    }

    // Health check endpoint
    app.get("/health", (req, res) => {
      const healthData = {
        status: "ok",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV,
        sessionStore: "CrashProofSessionStore",
        databaseConnected: dbManager.isConnectionAvailable(),
        secretsLoaded: areSecretsLoaded(),
      };

      appLogger.debug("health", "Health check accessed", healthData);
      res.json(healthData);
    });

    // Root endpoint
    app.get("/", (req, res) => {
      appLogger.debug("system", "Root endpoint accessed");
      res.send("welcome to wms project!");
    });

    // Start server
    const server = app.listen(port, () => {
      const serverInfo = {
        port,
        url: `https://be-dev.pivvot.life/api/v1/fetch-countries/`,
        sessionStore: "CrashProofSessionStore",
        environment: process.env.NODE_ENV,
        secretsLoaded: areSecretsLoaded(),
      };

      console.log(`Server is running on ${serverInfo.url}`);
      console.log(`Session Store: ${serverInfo.sessionStore}`);
      console.log(`Secrets Loaded: ${serverInfo.secretsLoaded}`);

      appLogger.info("system", "Server started successfully", serverInfo);

      // Warm voucher cache immediately on startup (fire and forget)
      warmVoucherCache();

      // Start scheduled 55-min background refresh
      startVoucherCacheRefresh();


      console.log(config.enableWellnessCron, "enableWellnessCron value from config");
      if (config.enableWellnessCron === "true") {
        startChallengeReminderJob();
        startLeaderboardCron();
        startEodNotificationCron();
        startWellnessPromptCron();
        initTokenRefreshCron();
        startEventReminderJob();
        console.log("✅ All cron jobs started");
      } else {
        console.log("⏭️  Cron jobs disabled (ENABLE_CRONS != true)");
      }

    });

    process.on("SIGINT", async () => {
      console.log("🛑 SIGINT received. Shutting down gracefully...");

      stopTokenRefreshCron();
      stopEventReminderJob();
      stopVoucherCacheRefresh();

      // Stop accepting new requests
      server.close(async () => {
        console.log("✅ HTTP server closed.");

        try {
          // Disconnect both Prisma clients
          await prismaSqlServer.$disconnect();
          await prismaPostgres.$disconnect();

          console.log("✅ Database connections closed.");
        } catch (err) {
          console.error("❌ Error closing Prisma clients:", err);
        } finally {
          process.exit(0);
        }
      });
    });

    // Socket.io setup
    const io = new Server(server, {
      cors: {
        origin: "*",
      },
    });

    // Your existing socket.io code here...
    let timers: any = {};

    io.on("connection", (socket: any) => {
      console.log(`Client connected: ${socket.id}`);

      let userID: any = socket.handshake.query?.userID;
      socket.join(userID);
      console.log(`Socket connected: ${socket.id},${userID}`);

      // Your existing socket event handlers...
      socket.on("joinRoom", (userId: any) => {
        socket.join(userId);
        console.log(`User ${socket.id} joined room ${userId}`);
      });

      socket.on("startTimer", (userId: any) => {
        console.log("userId>", timers[userId]);
        if (!timers[userId]) {
          timers[userId] = {
            elapsedTime: 0,
            intervalId: null,
            timerRunning: true,
            timerStatus: 0,
          };
        }

        if (timers[userId].timerRunning) {
          const startTime = Date.now() - timers[userId].elapsedTime * 1000;
          console.log("startTime>>", startTime);
          timers[userId].intervalId = setInterval(() => {
            if (timers[userId].timerRunning) {
              timers[userId].elapsedTime = (Date.now() - startTime) / 1000;
              timers[userId].timerStatus = 1;
              console.log(Date.now(), startTime, timers[userId].elapsedTime);
              io.to(userId).emit("timerUpdate", timers[userId]);
            }
          }, 100);
        }
      });

      // ... rest of your socket event handlers

      socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });

    server.timeout = 120000;
    globalIO = io;
    return { app, server, io };
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// // Handle uncaught exceptions
// process.on("uncaughtException", (error) => {
//   console.error("🔴 [FATAL] Uncaught Exception:", error.message);
//   console.error("Stack:", error.stack);
//   // process.exit(1);
// });

process.on('uncaughtException', (err) => {
  if (err.message?.includes('GOAWAY') || err.message?.includes('server_shutting_down')) {
    console.warn('⚠️ Firebase HTTP/2 GOAWAY (transient) - keeping server alive:', err.message);
    return;
  }
  console.error('🔴 Fatal uncaught exception:', err);
  // process.exit(1); 
});

process.on("unhandledRejection", (reason: any, promise) => {
  console.error("🟠 [UnhandledRejection] Non-fatal, continuing.");
  console.error("Reason:", reason?.message ?? reason);
  console.error("Stack:", reason?.stack ?? "No stack available");
  console.error("Promise:", promise);
  // DO NOT process.exit() — pool timeouts from logsService must not crash the server
});

//ADD THESE 6 LINES RIGHT HERE
let globalIO: any = null;

export const getIO = () => {
  if (!globalIO) throw new Error("Socket.io not initialized");
  return globalIO;
};
// Start the server
startServer();
// // 🔽 ADD THIS FUNCTION TO UPDATE .ENV FILE
// async function updateEnvFile(config: any) {
//   const fs = await import('fs').then(m => m.default);
//   const path = await import('path').then(m => m.default);

//   const envPath = path.join(__dirname, '../.env');

//   let envContent = '';

//   // Read existing .env file if it exists
//   if (fs.existsSync(envPath)) {
//     envContent = fs.readFileSync(envPath, 'utf8');

//     // Remove existing DATABASE_URL lines
//     envContent = envContent
//       .split('\n')
//       .filter(line => !line.startsWith('DATABASE_URL=') && !line.startsWith('DATABASE_URL2='))
//       .join('\n');
//   }

//   // Add new database URLs
//   envContent += `\nDATABASE_URL="${config.prismaDbUrl}"`;
//   envContent += `\nDATABASE_URL2="${config.prismaPostgresDbUrl}"`;

//   // Write updated content back to .env
//   fs.writeFileSync(envPath, envContent.trim());
//   console.log('✅ Updated .env file with database URLs');
// }

#!/usr/bin/env node
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const tls = require('tls');
const pm2 = require('pm2');
const os = require('os');
const mime = require('mime-types');
const rateLimit = require('express-rate-limit');
//const sanitizer = require('./sanitizer');
//const sanitize = sanitizer.sanitize;
const winston = require('winston');
require('winston-daily-rotate-file');
const {
  RATE_LIMIT_WINDOW_SECS,
  RATE_LIMIT_WINDOW_MAX_REQUESTS,
  LOGS_DIR,
  isPM2,
  USE_HTTPS,
  HTTP_PORT,
  HTTPS_PORT,
  TITLE,
  ASSETS_DIR,
  ASSETS_MAGIC,
  WIKI_ENDPOINT,
  FILE_ENDPOINT,
  RSS_ENDPOINT,
} = require('./settings');

let pm2_currentProcess = undefined;

// Limit each IP to 10 file requests per minute
const fileDownloadLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_SECS * 1000, // x seconds
  max: RATE_LIMIT_WINDOW_MAX_REQUESTS, // x requests per minute per IP
  message: 'Too many download requests. Please try again later.'
});

// Ensure logs directory exists
fs.mkdirSync(LOGS_DIR, { recursive: true });

// Configure Winston Logger with Size-Based Log Rotation
const transport = new winston.transports.DailyRotateFile({
    filename: path.join(LOGS_DIR, 'server-%DATE%.log'),
    datePattern: 'YYYY-MM-DD', // Keeps separate files but with size limit
    maxSize: '5m',  // Each log file max 5MB
    maxFiles: '10', // Keep a maximum of 10 log files (i.e., ~50MB total storage)
    zippedArchive: true, // Compress old logs to save space
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({
        format: () => new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })
      }),
      //winston.format.timestamp(),
      winston.format.errors({ stack: true }), // Ensures stack traces are logged
      winston.format.json(),                                                // output json {"level":"info", "message":...., "timestamp":"3/18/2025, 10:46:13 AM"}
      winston.format.printf(({ level, message, label, timestamp }) => `${(level+":").toUpperCase().padEnd(6, " ")} [${message}]` ),
    ),
    transports: [transport, new winston.transports.Console()],
    exceptionHandlers: [transport, new winston.transports.Console()],
    rejectionHandlers: [transport, new winston.transports.Console()]
});

// Track new connections
let activeConnections = {};
const activeConnectionsTimeout = 60 * 1000; // minute
const uptimeTimer = 60 * 60 * 1000; // hour
function numActiveConnections() {
  return Object.keys(activeConnections).map( r=>activeConnections[r] ).reduce((accumulator, currentValue) => accumulator + currentValue, 0);
}
function reportConnections() {
  logger.info( `🔌 [connections] total:${numActiveConnections()}` )
  Object.keys(activeConnections).forEach( r=> logger.info( `🔌 [connections] ip:'${r}' count:${activeConnections[r]}` ) )
}
function reportMemory() {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  logger.info(`⏳ [uptime] Uptime: ${uptime.toFixed(2)}s`);
  logger.info(`🧠 [memory] Memory Usage: ${JSON.stringify(memoryUsage)}`);
}
function reportPM2(options={}) {
  if (isPM2) {
    //logger.info(`🕒 [pm2] Running under PM2: ${isPM2}`);

    if (options.signal == "SIGINT") {
      logger.info(`🕒 [pm2] Restart Reason: ${options.signal} with PM2, implies Ctrl+C or PM2 stop`);
    }
    if (options.signal == "SIGTERM") {
      logger.info(`🕒 [pm2] Restart Reason: ${options.signal} with PM2, implies PM2 restart or system shutdown`);
    }
    if (options.signal == "SIGQUIT") {
      logger.info(`🕒 [pm2] Restart Reason: ${options.signal} with PM2, Rare, but sometimes used`);
    }

    if (pm2_currentProcess) {
      logger.info(`🕒 [pm2] Process Name: ${pm2_currentProcess.name}`);
      logger.info(`🕒 [pm2] Restarts: ${pm2_currentProcess.pm2_env.restart_time}`);
      logger.info(`🕒 [pm2] Restarts (Unstable): ${pm2_currentProcess.pm2_env.unstable_restarts}`);
      logger.info(`🕒 [pm2] Uptime: ${Date.now() - pm2_currentProcess.pm2_env.pm_uptime}ms`);
      logger.info(`🕒 [pm2] Status: ${pm2_currentProcess.pm2_env.status}`);
      logger.info(`🕒 [pm2] axm_options: ${JSON.stringify( pm2_currentProcess.pm2_env.axm_options )}`);
      //logger.info(`🕒 [pm2] pm2_env: ${JSON.stringify( pm2_currentProcess.pm2_env )}`);
      //logger.info(`🕒 [pm2] Restart Reason: ${(pm2_currentProcess.pm2_env.axm_options && pm2_currentProcess.pm2_env.axm_options.restart_reason) ? pm2_currentProcess.pm2_env.axm_options.restart_reason : 'Unknown'}`);
      logger.info(`🕒 [pm2] Exit Code: ${pm2_currentProcess.pm2_env.exit_code ? pm2_currentProcess.pm2_env.exit_code : 'Unknown'}`);
      logger.info(`🕒 [pm2] Triggered By: ${pm2_currentProcess.pm2_env.triggered_by ? pm2_currentProcess.pm2_env.triggered_by : 'Unknown'}`);
    }
  }
}
function reportOnExit(options={}) {
  logger.info(`🚪 ------------------------------------------------------------------------------------------`);
  logger.info(`🚪 [Exit Report]`);
  reportPM2(options)
  reportMemory()
  reportConnections()
  logger.info(`🚪 ==========================================================================================`);
}

// Capture Unhandled Errors
process.on('uncaughtException', (err) => {
  logger.error(`🔥 [on uncaughtException] Unhandled Exception: ${err.stack || err.message} connections:${numActiveConnections()}`);
  //reportOnExit();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`⚠️ [on unhandledRejection] Unhandled Promise Rejection: ${reason}`);
  //reportOnExit();
  process.exit(1);
});

// Capture Process Signals (SIGTERM from PM2, etc.)
let onExitSignalHint
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].forEach((signal) => {
  process.on(signal, () => {
    logger.error(`🚦 [on ${signal}] Process exiting...`);
    onExitSignalHint = signal;
    //reportOnExit({signal});
    process.exit(0);
  });
});

process.on('exit', (code) => {
  logger.info(`👋 [on exit] Process exiting with code: ${code}`);
  reportOnExit(onExitSignalHint ? {signal: onExitSignalHint} : {});
  onExitSignalHint = undefined; // clear it...
});

if (isPM2) {
  pm2.connect(err => {
    logger.info(`🕒 [pm2] Connected to PM2...`);
    if (err) {
      console.error(err)
      process.exit(2)
    }

    // logger.info(`🕒 [pm2] PM2 detected process: registering exit handlers...`);
    pm2.launchBus((err, bus) => {
      if (err) return logger.error( err );

      bus.on('process:event', (data) => {
        logger.error(`🕒 [pm2] Process Event: ${data.process.name}: ${data.data}`);
        reportOnExit();
      });

      bus.on('process:exit', (data) => {
        logger.warn(`🕒 [pm2] PM2 detected process exit: ${data.process.name} (PID ${data.process.pm_id})`);
        reportOnExit();
      });

      bus.on('log:err', (data) => {
        logger.error(`🕒 [pm2] PM2 error log from ${data.process.name}: ${data.data}`);
        reportOnExit();
      });

      // Application Events
      bus.on('start', (proc) => logger.error(`🚀 [pm2] Process started: ${proc.process.name}`));
      bus.on('stop', (proc) => logger.error(`🛑 [pm2] Process stopped: ${proc.process.name}`));
      bus.on('restart', (proc) => logger.error(`🔄 [pm2] Process restarted: ${proc.process.name}`));
      bus.on('exit', (proc) => logger.error(`🚪 [pm2] Process exited: ${proc.process.name} (Code: ${proc.process.exit_code})`));
      bus.on('delete', (proc) => logger.error(`❌ [pm2] Process deleted: ${proc.process.name}`));
      bus.on('process:exit', (data) => logger.error(`🕒 [pm2] PM2 detected process exit: ${data.process.name} (PID ${data.process.pm_id})`));

      // // Log Events
      // bus.on('log:out', (data) => logger.error(`📜 [pm2] STDOUT: [${data.process.name}] ${data.data}`));
      bus.on('log:err', (data) => logger.error(`🔥 [pm2] STDERR: [${data.process.name}] ${data.data}`));

      // // Error & Exception Events
      bus.on('process:event', (data) => logger.error(`⚠️ [pm2] Process event: ${JSON.stringify(data)}`));
      bus.on('uncaughtException', (err) => logger.error(`💥 [pm2] Uncaught Exception: ${err}`));

      // // Special Restart Events
      bus.on('restart overlimit', (proc) => logger.error(`🚨 [pm2] Process restart over limit: ${proc.process.name}`));
      bus.on('exit:restart', (proc) => logger.error(`♻️ [pm2] Process exited and restarted: ${proc.process.name}`));

      // // PM2 System Events
      bus.on('pm2:kill', (data) => logger.error(`💀 [pm2] PM2 killed: ${data}`));
      bus.on('reload', (proc) => logger.error(`🔄 [pm2] PM2 reload triggered for: ${proc.process.name}`));
    });

    pm2.list((err, processList) => {
      if (err) {
        console.error('🕒 [pm2] Error retrieving PM2 process list:', err);
        return;
      }

      pm2_currentProcess = processList.find(p => p.pm_id == process.env.pm_id);
      reportPM2();
    });
  })
}

// Log Uptime & Memory Usage Periodically
setInterval(() => {
  reportMemory()
  reportConnections();
}, uptimeTimer); // Log every 30 seconds


///////////////////////////////////////////////////////////////////////////////
// app
///////////////////////////////////////////////////////////////////////////////

const app = express();
app.disable('x-powered-by'); // be more stealthy
app.set('etag', false); // be more stealthy, plus, we want the latest sent when working on organizing the library...

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// auth endpoints
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// populate some variables we'll use.
app.use( (req, res, next) => {
  req.canonicalUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  req.canonicalUrlRoot = `${req.protocol}://${req.get('host')}`;
  req.canonicalUrlDomain = `${req.get('host')}`;

  // also, these exist already, part of express:
  // req.url         // "/hello/world?foo=bar"
  // req.originalUrl // "/api/test"     (even when /path inside a sub router, mounted to /full, gives /full/path)
  // req.baseUrl     // "/api"          (just the base folder in the path, no rest of path)
  // req.path        // "/hello/world"  (no query string)
  // req.hostname    // "example.com"
  // req.get('host') // "example.com:3000"
  // req.protocol    // http or https
  next()
})

// AUTH
const public_rootpath_file_whitelist = [ "/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png" ]
const public_rootpath_folder_whitelist = [ `/${WIKI_ENDPOINT}/view`, `/${WIKI_ENDPOINT}/preview`, `/${RSS_ENDPOINT}`, `/${WIKI_ENDPOINT}/uploads`, `/${ASSETS_MAGIC}` ]
const public_routes = [ ...public_rootpath_file_whitelist.map( r => `^${r}` ), ...public_rootpath_folder_whitelist.map( r => `^${r}` ) ]
const authMiddleware = require("./router-auth");
authMiddleware.init( logger, public_routes );
app.use("/", authMiddleware.router);

// ROOT /favicon.ico (and friends) : expose certain assets onto root /
const rootassetsMiddleware = require("./router-fileserv")( { logger, browser_dir: ASSETS_DIR, cache: true, allowed_exts: [ "ico", "png" ], filelist: public_rootpath_file_whitelist });
app.use(`/`, rootassetsMiddleware.router);

// FILESERV the ASSETS_DIR
const staticassetsMiddleware = require("./router-fileserv")( {logger, browser_dir: ASSETS_DIR, cache: true, allowed_exts: [ "ico", "png", "svg", "jpg" ], filelist: "*" });
app.use(`/${ASSETS_MAGIC}`, staticassetsMiddleware.router);

// WIKI
const wikiMiddleware = require("./router-wiki");
wikiMiddleware.init( logger );
app.use(`/${WIKI_ENDPOINT}`, wikiMiddleware.router);

// BROWSER
const browserMiddleware = require("./router-browser");
browserMiddleware.init( logger );
app.use(`/${FILE_ENDPOINT}`, browserMiddleware.router);

// torrent RSS
const rssTorrentMiddleware = require("./router-rss-torrent");
rssTorrentMiddleware.init( logger );
app.use(`/${RSS_ENDPOINT}`, rssTorrentMiddleware.router);

// DEFAULT
app.use('/', (req, res, next) => {
  console.log( "default path!!!!!")
  res.redirect(`/${WIKI_ENDPOINT}/view`);
});

// custom 404 for anything we forgot to cover in our routes.
app.use((req, res, next) => {
  res.status(404).send("Sorry can't find that!")
})

// custom 500 error handler - for anything that falls through, server's broken!
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).send('Something broke!')
})


// quick reload certs if they change...
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_PATH = {
  privkey: path.join(CERT_DIR, 'privkey.pem'),
  cert: path.join(CERT_DIR, 'cert.pem')
};

// Function to load the cert files
function loadCerts() {
  return {
    key: fs.readFileSync(CERT_PATH.privkey),
    cert: fs.readFileSync(CERT_PATH.cert)
  };
}

// Watch the certs directory for changes
let currentCerts = loadCerts();
fs.watch(CERT_DIR, { encoding: 'utf8' }, (eventType, filename) => {
  if (filename === 'cert.pem' || filename === 'privkey.pem') {
    console.log(`[SERVER] Certificate file changed: ${filename}. Reloading...`);
    currentCerts = loadCerts();  // Update the certs on change
  }
});

// Create HTTPS server with dynamic cert loading using SNICallback
const options = {
  SNICallback: (servername, cb) => {
    // Dynamically load the certs when requested
    const certs = currentCerts;
    cb(null, tls.createSecureContext({
      key: certs.key,
      cert: certs.cert
    }));
  }
};



// Start server (pick https or http, https shouldn't have http because cert mgr runs on port 80)
let servers = USE_HTTPS ? {} : { [HTTP_PORT]: http.createServer(app) };
if (USE_HTTPS)
  servers[HTTPS_PORT] = https.createServer(options, app)

logger.info(`🚀 ==========================================================================================`);
logger.info(`🚀 Starting ${TITLE}...`)
logger.info(`🚀 ------------------------------------------------------------------------------------------`);
for (let PORT of Object.keys( servers )) {
  const server = servers[PORT]

  // track some connection stats
  server.on('connection', (socket) => {
    //logger.info( `[connection open] ${socket.remoteAddress}` )
    if (activeConnections[socket.remoteAddress] == undefined) activeConnections[socket.remoteAddress] = 0;
    activeConnections[socket.remoteAddress]++;
    socket.on('close', () => {
      //logger.info( `[connection close] ${socket.remoteAddress}` )
      setTimeout( () => {
        activeConnections[socket.remoteAddress]--;
        if (activeConnections[socket.remoteAddress] == 0) delete activeConnections[socket.remoteAddress];
        //logger.info( `[connection count] ${socket.remoteAddress} has ${activeConnections[socket.remoteAddress]} connections open` )
      }, activeConnectionsTimeout )
    });
  });

  server.listen(PORT, () => {
    //logger.info(`🚀 ------------------------------------------------------------------------------------------`);
    logger.info(`🚀 Server running at http${PORT != HTTP_PORT ? "s" : ""}://localhost:${PORT}`)
    reportPM2()
    reportMemory()
    logger.info(`🚀 ------------------------------------------------------------------------------------------`);
  });
}

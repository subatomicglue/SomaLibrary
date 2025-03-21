const fs = require("fs");
const path = require("path");
const express = require("express");
const router = express.Router();

const {
  TITLE,
  PORT_DEFAULT,
  PUBLIC_DIR,
  LOGS_DIR,
  ASSETS_DIR,
  ALLOWED_EXTENSIONS,
  RATE_LIMIT_WINDOW_SECS,
  RATE_LIMIT_WINDOW_MAX_REQUESTS,
  MAX_PATH_LENGTH,
  USE_HTTPS,
  HTTPS_CERT_CRT,
  HTTPS_CERT_CSR,
  HTTPS_CERT_KEY,
  ALLOW_DOTFILES,
  VERBOSE,
  USERS_WHITELIST,
  SECRET_PASSCODE,
  PORT,
  ASSETS_MAGIC,
  isPM2,
  WIKI_DIR,
} = require('./settings');


let logger;

// Ensure wiki directory exists
if (!fs.existsSync(WIKI_DIR)) {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
}

// Basic Markdown to HTML conversion using regex
function markdownToHtml(markdown, basepath) {
  return markdown
      .replace(/^# (.*$)/gim, "<h1>$1</h1>") // # Header
      .replace(/^## (.*$)/gim, "<h2>$1</h2>") // ## Sub-header
      .replace(/\*\*(.*?)\*\*/gim, "<b>$1</b>") // **bold**
      .replace(/\*(.*?)\*/gim, "<i>$1</i>") // *italic*
      .replace(/`(.*?)`/gim, "<code>$1</code>") // `code`
      .replace(/\n/g, "<br>") // New lines to <br>
      .replace(/\[([^\]]+)\]\(([^\]]+)\)/g, `<a href="${basepath}/view/$2">$1</a>`) // link
}

function wrapWithFrame(content, topic) {
  return `
    <html>
      <head>
        <title>Wiki - ${topic}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            min-height: 100vh;
            background-color: #f4f4f4;
          }
          header {
            background-color: #007BFF;
            color: white;
            padding: 10px 20px;
            text-align: center;
          }
          main {
            flex: 1;
            padding: 20px;
            background-color: white;
            margin: 20px;
            border-radius: 8px;
            box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
          }
          footer {
            background-color: #007BFF;
            color: white;
            padding: 10px 20px;
            text-align: center;
          }
          footer a {
            color: white;
            text-decoration: none;
            font-weight: bold;
          }
          footer a:hover {
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <header>
          <h1>Wiki: ${topic}</h1>
        </header>
        <main>
          ${content}
        </main>
        <footer>
          <p><a href="/wiki/edit?topic=${topic}">Click here to edit this page</a></p>
        </footer>
      </body>
    </html>
  `;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// endpoints
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// general guard, filter anything unexpected or unsupported by the app
router.use((req, res, next) => {
  const req_path = decodeURIComponent( req.path )
  logger.warn(`[guard] : ${req_path} - TODO set up the guards!`);

  // wiki under development... todo: set this section up.
  next();
  return

  if (req.params[0] && req.params[0].length > MAX_PATH_LENGTH) {
    return res.status(500).json({ error: "Path length exceeded the limit." });
  }

  if (Object.keys(req.query).length > 0) {
    // for (let key in req.query) {
    //   if (req.query[key] && req.query[key].length > MAX_PATH_LENGTH) {
    //     return res.status(500).json({ error: `Query parameter '${key}' is too long` });
    //   }
    // }
    return res.status(500).json({ error: `Query parameter '${Object.keys(req.query)}' is too long >0` });
  }

  if (req.body && Object.keys(req.body).length > 0) {
  //for (let key in req.body) {
  //  if (req.body[key] && typeof req.body[key] === 'string' && req.body[key].length > MAX_PATH_LENGTH) {
  //    return res.status(500).json({ error: `Body parameter '${key}' is too long` });
  //  }
    return res.status(500).json({ error: `Body parameter '${Object.keys(req.body)}' is too long` });
  }

  let acceptable_headers = { 'content-type': ["application/x-www-form-urlencoded"] }
  if (req.headers['content-type'] && !acceptable_headers['content-type'].includes( req.headers['content-type'] )) {
    logger.warn(`[content-type BLOCK] : Unexpected headers detected -> content-type:${req.headers['content-type']}`);
    return res.status(500).json({ error: `Unexpected headers detected. ${JSON.stringify( Object.keys( req.headers ) )} ${req.headers['content-type']}` });
  }

  next();
});

// GET /wiki/view?topic=<TOPICNAME>&version=<VERSION>
router.get("/view/:topicParam?/:versionParam?", (req, res) => {
  const { topicParam, versionParam } = req.params; // Accessing the parameters directly from the path
  logger.info(`[wiki] ${topicParam} ${versionParam}`);
  const topic = topicParam ? `${topicParam}` : "index";   // Default to index if no topic provided
  const version = versionParam ? `.${versionParam}` : ""; // Default to empty string if no version provided
  
  logger.info(`[wiki] ${topic} ${version}`);

  const filePath = path.join(WIKI_DIR, `${topic}${version}.md`);
  if (!fs.existsSync(filePath)) {
    //return res.status(404).send("Topic not found.");
    const editUrl = `${req.baseUrl}/edit?topic=${topic}`;
    return res.send(`
      <p>Topic "${topic}" not found.</p>
      <p><a href="${editUrl}">Click here</a> to create or edit this topic.</p>
    `);
  }

  const markdown = fs.readFileSync(filePath, "utf8");
  const html = wrapWithFrame(markdownToHtml(markdown, req.baseUrl), topic);
  res.send(html);
});

// GET /wiki/markdown?topic=<TOPICNAME>&version=<VERSION>
router.get("/markdown", (req, res) => {
  const topic = req.query.topic;
  const version = req.query.version ? `.${req.query.version}` : "";

  if (!topic) {
    return res.status(400).send("Missing topic name.");
  }

  const filePath = path.join(WIKI_DIR, `${topic}${version}.md`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Topic not found.");
  }

  res.sendFile(filePath);
});


// PUT /wiki (Body: { topic: "TOPICNAME", content: "Markdown content" })
router.put("/", express.json(), (req, res) => {
  const { topic, content } = req.body;
  if (!topic || !content) {
    return res.status(400).send("Missing topic or content.");
  }

  const latestFilePath = path.join(WIKI_DIR, `${topic}.md`);
  
  // Find the next version number
  let version = 1;
  while (fs.existsSync(path.join(WIKI_DIR, `${topic}.${version}.md`))) {
    version++;
  }
  
  const versionedFilePath = path.join(WIKI_DIR, `${topic}.${version}.md`);

  // Save new version
  fs.writeFileSync(versionedFilePath, content, "utf8");

  // Overwrite latest version
  fs.writeFileSync(latestFilePath, content, "utf8");

  res.json({ message: "Wiki page updated.", version });
});

// GET /wiki/edit?topic=<TOPICNAME>
router.get("/edit", (req, res) => {
  const topic = req.query.topic;
  if (!topic) {
    return res.status(400).send("Missing topic name.");
  }

  const filePath = path.join(WIKI_DIR, `${topic}.md`);
  const markdown = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";

  res.send(`
    <html>
    <head>
      <title>Edit Wiki: ${topic}</title>
      <script>
        function updatePreview() {
          let markdown = document.getElementById("markdown").value;
          fetch("/wiki/preview", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ content: markdown }) })
          .then(res => res.text())
          .then(html => document.getElementById("preview").innerHTML = html);
        }

        function saveWiki() {
          let markdown = document.getElementById("markdown").value;
          fetch("/wiki", { 
            method: "PUT", 
            headers: {"Content-Type": "application/json"}, 
            body: JSON.stringify({ topic: "${topic}", content: markdown }) 
          })
          .then(res => res.json())
          .then(data => {
            alert("Saved! Version: " + data.version);
            // Redirect to the view page for the updated topic
            window.location.href = "/wiki/view/${topic}";
          });
        }
      </script>
    </head>
    <body>
      <h1>Edit Wiki: ${topic}</h1>
      <textarea id="markdown" onkeyup="updatePreview()" rows="10" cols="50">${markdown}</textarea>
      <button onclick="saveWiki()">Save</button>
      <h2>Preview:</h2>
      <div id="preview"></div>
    </body>
    </html>
  `);
});


// POST /wiki/preview (used for live preview in edit page)
router.post("/preview", express.json(), (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).send("Missing content.");
  res.send(markdownToHtml(content));
});

////////////////////////////////////////////////////////////////////////////////

function init( l ) {
  logger = l;
}

// Plug into Express
module.exports.router = router;
module.exports.init = init;


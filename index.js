import express from "express"
import chalk from "chalk"
import fs from "fs"
import cors from "cors"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { createRequire } from "module"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

const app = express()
const PORT = process.env.PORT || 4000

// Load settings once
const settingsPath = path.join(__dirname, "src", "settings.json")
let settings = {}
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
} catch (error) {
  console.error("Failed to read settings.json:", error)
}

// Trust proxy & formatting
app.enable("trust proxy")
app.set("json spaces", 2)

// Middleware
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cors())

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("X-XSS-Protection", "1; mode=block")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  next()
})

// Simple rate limiter
const requestCounts = new Map()
const RATE_LIMIT_WINDOW = 60 * 1000
const RATE_LIMIT_MAX = 15

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress
  const now = Date.now()

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW })
  } else {
    const data = requestCounts.get(ip)
    if (now > data.resetTime) {
      data.count = 1
      data.resetTime = now + RATE_LIMIT_WINDOW
    } else {
      data.count++
      if (data.count > RATE_LIMIT_MAX) {
        console.warn(`Rate limit exceeded by ${ip}`)
        return res.status(429).sendFile(path.join(__dirname, "api-page", "429.html"))
      }
    }
  }
  next()
})

setInterval(() => {
  const now = Date.now()
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(ip)
    }
  }
}, RATE_LIMIT_WINDOW)

// Maintenance middleware
const skipPaths = [
  "/api/settings",
  "/assets/",
  "/src/",
  "/api/preview-image",
]

app.use((req, res, next) => {
  try {
    const shouldSkip = skipPaths.some((prefix) => req.path.startsWith(prefix))
    if (settings.maintenance?.enabled && !shouldSkip) {
      console.log(`Maintenance mode: Blocking ${req.path}`)
      if (req.path.startsWith("/api/") || req.path.startsWith("/ai/")) {
        return res.status(503).json({
          status: false,
          error: "Service temporarily unavailable",
          message: "The API is currently under maintenance.",
          maintenance: true,
          creator: settings.apiSettings?.creator || "End Team",
        })
      }
      return res.status(503).sendFile(path.join(__dirname, "api-page", "maintenance.html"))
    }
    next()
  } catch (err) {
    console.error("Maintenance check error:", err)
    next()
  }
})

// Static asset routes
app.get("/assets/styles.css", (req, res) => {
  res.type("text/css").sendFile(path.join(__dirname, "api-page", "styles.css"))
})

app.get("/assets/script.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "api-page", "script.js"))
})

// Preview image route
app.get("/api/preview-image", (req, res) => {
  const preview = path.join(__dirname, "src", "preview.png")
  const fallback = path.join(__dirname, "src", "banner.jpg")
  const icon = path.join(__dirname, "src", "icon.png")

  try {
    if (fs.existsSync(preview)) {
      return res.type("png").sendFile(preview)
    } else if (fs.existsSync(fallback)) {
      return res.type("jpeg").sendFile(fallback)
    } else if (fs.existsSync(icon)) {
      return res.type("png").sendFile(icon)
    } else {
      res.status(404).json({ error: "No image available" })
    }
  } catch (err) {
    console.error("Preview image error:", err)
    res.status(404).json({ error: "Preview image not found" })
  }
})

// API: Settings & Notifications
app.get("/api/settings", (req, res) => {
  try {
    res.json(settings)
  } catch (err) {
    res.status(500).sendFile(path.join(__dirname, "api-page", "500.html"))
  }
})

app.get("/api/notifications", (req, res) => {
  try {
    const notifications = JSON.parse(fs.readFileSync(path.join(__dirname, "api-page", "notifications.json"), "utf-8"))
    res.json(notifications)
  } catch (err) {
    res.status(500).sendFile(path.join(__dirname, "api-page", "500.html"))
  }
})

// Block access to protected files
const blockedPaths = [
  "/api-page/",
  "/src/settings.json",
  "/api-page/notifications.json",
  "/api-page/styles.css",
  "/api-page/script.js",
]

app.use((req, res, next) => {
  const isBlocked = blockedPaths.some((b) =>
    b.endsWith("/") ? req.path.startsWith(b) : req.path === b
  )
  if (isBlocked) {
    return res.status(403).sendFile(path.join(__dirname, "api-page", "403.html"))
  }
  next()
})

// Serve static images from /src (only image extensions allowed)
app.use("/src", (req, res, next) => {
  if (/\.(jpg|jpeg|png|gif|svg|ico)$/i.test(req.path)) {
    express.static(path.join(__dirname, "src"))(req, res, next)
  } else {
    res.status(403).sendFile(path.join(__dirname, "api-page", "403.html"))
  }
})

// JSON response formatter
app.use((req, res, next) => {
  const originalJson = res.json
  res.json = function (data) {
    if (data && typeof data === "object") {
      const response = {
        status: data.status ?? true,
        creator: settings.apiSettings?.creator || "End Team",
        ...data,
      }
      return originalJson.call(this, response)
    }
    return originalJson.call(this, data)
  }
  next()
})

// Dynamic API loader
let totalRoutes = 0
const apiFolder = path.join(__dirname, "src", "api")

const loadApiRoutes = async () => {
  const subfolders = fs.readdirSync(apiFolder)
  for (const folder of subfolders) {
    const folderPath = path.join(apiFolder, folder)
    if (fs.statSync(folderPath).isDirectory()) {
      const files = fs.readdirSync(folderPath)
      for (const file of files) {
        const filePath = path.join(folderPath, file)
        if (file.endsWith(".js")) {
          try {
            const module = await import(pathToFileURL(filePath).href)
            const handler = module.default
            if (typeof handler === "function") {
              handler(app)
              totalRoutes++
              console.log(
                chalk.bgHex("#FFFF99").hex("#333").bold(` Loaded Route: ${file} `)
              )
            }
          } catch (err) {
            console.error(`Error loading ${file}:`, err)
          }
        }
      }
    }
  }
}
await loadApiRoutes()

console.log(chalk.bgHex("#90EE90").hex("#333").bold(" Load Complete ✓ "))
console.log(chalk.bgHex("#90EE90").hex("#333").bold(` Total Routes Loaded: ${totalRoutes} `))

// Index & error pages
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "api-page", "index.html"))
})

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "api-page", "404.html"))
})

// General error handler
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err)
  const status = err.status || 500
  const errorPage = path.join(__dirname, "api-page", `${status}.html`)
  if (fs.existsSync(errorPage)) {
    return res.status(status).sendFile(errorPage)
  }
  res.status(status).sendFile(path.join(__dirname, "api-page", "500.html"))
})

app.listen(PORT, () => {
  console.log(chalk.bgHex("#90EE90").hex("#333").bold(` Server running on port ${PORT} `))
})

export default app

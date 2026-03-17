const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

// --- Configuration ---
const TOPLINE_EMAIL = process.env.TOPLINE_EMAIL;
const TOPLINE_PASSWORD = process.env.TOPLINE_PASSWORD;
const EXPORT_URL = "https://topline.futurimedia.com/admin/research/status_logs_export";
const DOWNLOAD_DIR = path.resolve(__dirname, "downloads");
const OUTPUT_DIR = path.resolve(__dirname, "../dashboard/public/data");

// Deliverable category mappings (normalized - will strip quotes and lowercase for matching)
const CATEGORY_MAP = {
  "topline personality prep": "PERSONALITY",
  "digital analysis": "DIGITAL ANALYSIS",
  "digital intelligence": "DIGITAL INTELLIGENCE",
  "mapit": "MAPIT",
  "insights": "INSIGHTS",
  "infographic": "INFOGRAPHICS",
  "presentation": "PRESENTATIONS",
  "snapshot": "SNAPSHOTS",
};

// Resource types are combined (starts with Resource_)
const RESOURCE_PATTERN = /^resource_/i;

// Excluded deliverables
const EXCLUDED = ["ai"];

// CSV column names (as they appear in the export)
const COL_DELIVERABLE = "Deliverable";
const COL_NEW_STATUS = "New Status";
const COL_TIMESTAMP = "Timestamp Of This Change (UTC)";
const STATUS_DELIVERED = "Designs Delivered";

// --- Date Utilities ---

// Get the Monday of a given week
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Get prior 4 weeks as Mon-Sun ranges
function getPrior4Weeks() {
  const today = new Date();
  const currentMonday = getMonday(today);

  // Go back to previous Monday (start of last complete week)
  const lastMonday = new Date(currentMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);

  const weeks = [];
  for (let i = 0; i < 4; i++) {
    const weekStart = new Date(lastMonday);
    weekStart.setDate(weekStart.getDate() - (i * 7));

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    weeks.unshift({
      start: weekStart,
      end: weekEnd,
      label: `${formatDate(weekStart)} - ${formatDate(weekEnd)}`,
    });
  }

  return weeks;
}

function formatDate(date) {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

function formatDateForInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// --- CSV Parsing ---

function parseCSV(csvText) {
  const lines = csvText.split("\n");
  if (lines.length === 0) return [];

  // Parse header
  const header = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    header.forEach((col, idx) => {
      row[col.trim()] = values[idx]?.trim() || "";
    });
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);

  return result;
}

// --- Data Processing ---

function normalizeValue(val) {
  // Remove surrounding quotes and trim
  return val.replace(/^["']|["']$/g, "").trim().toLowerCase();
}

function categorizeDeliverable(deliverable) {
  const normalized = normalizeValue(deliverable);
  if (EXCLUDED.includes(normalized)) return null;
  if (CATEGORY_MAP[normalized]) return CATEGORY_MAP[normalized];
  if (RESOURCE_PATTERN.test(normalized)) return "RESOURCES";
  return null; // Unknown deliverables are excluded
}

function processData(rows, weeks) {
  // Initialize stats structure
  const stats = {
    generatedAt: new Date().toISOString(),
    weeks: weeks.map(w => w.label),
    categories: {},
  };

  const categories = [
    "PERSONALITY",
    "DIGITAL ANALYSIS",
    "DIGITAL INTELLIGENCE",
    "MAPIT",
    "INSIGHTS",
    "INFOGRAPHICS",
    "PRESENTATIONS",
    "SNAPSHOTS",
    "RESOURCES",
    "TOTAL SENT TO DESIGN",
  ];

  // Initialize each category with weekly counts
  categories.forEach(cat => {
    stats.categories[cat] = {
      weekly: weeks.map(() => 0),
      fourWeekAvg: 0,
      weekOverWeek: null,
    };
  });

  // Track unique deliverables for debugging
  const seenDeliverables = new Set();
  let matchedRows = 0;
  let deliveredRows = 0;

  // Process each row
  rows.forEach(row => {
    const status = row[COL_NEW_STATUS];
    const timestamp = row[COL_TIMESTAMP];
    const deliverable = row[COL_DELIVERABLE];

    // Only count rows where status is "Designs Delivered"
    const normalizedStatus = normalizeValue(status || "");
    if (normalizedStatus !== normalizeValue(STATUS_DELIVERED)) return;

    deliveredRows++;

    if (!timestamp || !deliverable) return;

    seenDeliverables.add(deliverable);

    const category = categorizeDeliverable(deliverable);
    if (!category) return;

    matchedRows++;

    // Parse timestamp (format: "2026-03-09 00:16:06")
    const deliveredDate = new Date(timestamp.replace(" ", "T") + "Z");

    // Find which week this belongs to
    weeks.forEach((week, weekIdx) => {
      if (deliveredDate >= week.start && deliveredDate <= week.end) {
        stats.categories[category].weekly[weekIdx]++;
        stats.categories["TOTAL SENT TO DESIGN"].weekly[weekIdx]++;
      }
    });
  });

  console.log(`Delivered rows: ${deliveredRows}, Matched to categories: ${matchedRows}`);
  console.log(`Unique deliverables seen: ${[...seenDeliverables].slice(0, 10).join(", ")}...`);

  // Calculate averages and WoW change
  categories.forEach(cat => {
    const weekly = stats.categories[cat].weekly;
    const sum = weekly.reduce((a, b) => a + b, 0);
    stats.categories[cat].fourWeekAvg = Math.round((sum / 4) * 10) / 10;

    // Week over week change (comparing last week to previous week)
    const lastWeek = weekly[3];
    const prevWeek = weekly[2];
    if (prevWeek > 0) {
      stats.categories[cat].weekOverWeek = Math.round(((lastWeek - prevWeek) / prevWeek) * 100);
    }
  });

  return stats;
}

// --- Download Helper ---

async function downloadWeekData(page, client, week, filesBefore) {
  console.log(`\n--- Downloading: ${week.label} ---`);

  // Navigate to export page
  await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });

  // Set date range
  await page.waitForSelector('input[type="date"]', { timeout: 10000 });
  const dateInputs = await page.$$('input[type="date"]');

  const fromValue = formatDateForInput(week.start);
  const toValue = formatDateForInput(week.end);

  console.log(`Setting dates: ${fromValue} to ${toValue}`);

  await dateInputs[0].evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, fromValue);

  await dateInputs[1].evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, toValue);

  await new Promise(r => setTimeout(r, 500));

  // Click download
  const downloadButton = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button, input[type='submit']")];
    return buttons.find(el =>
      el.textContent?.includes("Download CSV") ||
      el.value?.includes("Download CSV")
    );
  });

  if (downloadButton && downloadButton.asElement()) {
    await downloadButton.asElement().click();
    console.log("Clicked Download CSV...");
  } else {
    throw new Error("Download CSV button not found");
  }

  // Wait for download
  let csvFile = null;
  const maxWait = 120000;
  const startTime = Date.now();

  while (!csvFile && Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 1000));
    const filesNow = fs.readdirSync(DOWNLOAD_DIR);
    const newFiles = filesNow.filter(
      f => !filesBefore.has(f) && f.endsWith(".csv")
    );
    if (newFiles.length > 0) {
      csvFile = newFiles[0];
      filesBefore.add(csvFile);
    }
  }

  if (!csvFile) {
    throw new Error(`Download timed out for ${week.label}`);
  }

  const csvPath = path.join(DOWNLOAD_DIR, csvFile);
  const stats = fs.statSync(csvPath);
  console.log(`Downloaded: ${csvFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  return csvPath;
}

// --- Main Scraper ---

async function run() {
  // Ensure directories exist
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const weeks = getPrior4Weeks();
  console.log("Fetching data for weeks:");
  weeks.forEach(w => console.log(`  ${w.label}`));

  console.log("\nLaunching browser...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Configure download behavior
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  });

  // Track download progress
  client.on("Browser.downloadProgress", (event) => {
    if (event.state === "inProgress") {
      process.stdout.write(".");
    } else if (event.state === "completed") {
      console.log(" Done!");
    }
  });

  try {
    // Step 1: Navigate to export page (redirects to login)
    console.log("Navigating to login...");
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Step 2: Login
    console.log("Logging in...");
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', { timeout: 10000 });

    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail"]');
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(TOPLINE_EMAIL, { delay: 50 });

    const passwordInput = await page.$('input[type="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(TOPLINE_PASSWORD, { delay: 50 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    console.log("Logged in successfully!");

    // Step 3: Download each week's data
    const filesBefore = new Set(fs.readdirSync(DOWNLOAD_DIR));
    const allRows = [];

    for (const week of weeks) {
      const csvPath = await downloadWeekData(page, client, week, filesBefore);

      // Parse and accumulate rows
      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const rows = parseCSV(csvContent);
      console.log(`Parsed ${rows.length} rows`);
      allRows.push(...rows);
    }

    console.log(`\nTotal rows: ${allRows.length}`);

    // Step 4: Process all data
    console.log("Processing data...");
    const stats = processData(allRows, weeks);

    // Step 5: Save JSON
    const outputPath = path.join(OUTPUT_DIR, "topline-stats.json");
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log(`\nOutput saved to: ${outputPath}`);

    // Print summary
    console.log("\n--- Summary ---");
    console.log(`Weeks: ${stats.weeks.join(" | ")}`);
    console.log("");
    Object.entries(stats.categories).forEach(([cat, data]) => {
      const wow = data.weekOverWeek !== null ? `${data.weekOverWeek}%` : "N/A";
      console.log(`${cat.padEnd(22)}: ${data.weekly.map(n => String(n).padStart(4)).join(" ")} | Avg: ${String(data.fourWeekAvg).padStart(5)} | WoW: ${wow}`);
    });

  } catch (err) {
    console.error("\nError:", err.message);
    await page.screenshot({
      path: path.join(DOWNLOAD_DIR, "error-screenshot.png"),
    });
    console.log("Error screenshot saved.");
    process.exit(1);
  } finally {
    await browser.close();
    console.log("\nBrowser closed.");
  }
}

run();

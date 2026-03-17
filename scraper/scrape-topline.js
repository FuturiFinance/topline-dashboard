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
  "one-sheet": "SNAPSHOTS",
};

// Resource types are combined (starts with Resource_)
const RESOURCE_PATTERN = /^resource_/i;

// Excluded deliverables
const EXCLUDED = ["ai"];

// CSV column names (as they appear in the export)
const COL_DELIVERABLE = "Deliverable";
const COL_NEW_STATUS = "New Status";
const COL_TIMESTAMP = "Timestamp Of This Change (UTC)";

// Valid "delivered" statuses
const STATUS_DESIGNS_DELIVERED = "Designs Delivered";
const STATUS_INSIGHTS_DELIVERED = "Insights Delivered";

// --- Date Utilities ---

// Get the Monday of a given week (in UTC)
function getMondayUTC(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Get prior 4 weeks as Mon-Sun ranges (using UTC)
function getPrior4Weeks() {
  const today = new Date();
  const currentMonday = getMondayUTC(today);

  // Go back to previous Monday (start of last complete week)
  const lastMonday = new Date(currentMonday);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);

  const weeks = [];
  for (let i = 0; i < 4; i++) {
    const weekStart = new Date(lastMonday);
    weekStart.setUTCDate(weekStart.getUTCDate() - (i * 7));
    weekStart.setUTCHours(0, 0, 0, 0);

    // End of Sunday = start of Sunday + 23:59:59.999
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    weeks.unshift({
      start: weekStart,
      end: weekEnd,
      label: `${formatDateUTC(weekStart)} - ${formatDateUTC(weekEnd)}`,
    });
  }

  return weeks;
}

function formatDateUTC(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

function formatDateForInput(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
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
  // Track processed rows to avoid duplicates (server returns overlapping date ranges)
  const processedRows = new Set();
  let matchedRows = 0;
  let deliveredRows = 0;
  let duplicateRows = 0;

  // Process each row
  rows.forEach(row => {
    const researchId = row["Research ID"];
    const status = row[COL_NEW_STATUS];
    const timestamp = row[COL_TIMESTAMP];
    const deliverable = row[COL_DELIVERABLE];

    // Create unique key for deduplication
    const rowKey = `${researchId}|${deliverable}|${timestamp}|${status}`;
    if (processedRows.has(rowKey)) {
      duplicateRows++;
      return;
    }
    processedRows.add(rowKey);

    // Only count rows where status indicates delivery
    const normalizedStatus = normalizeValue(status || "");
    const isDesignsDelivered = normalizedStatus === normalizeValue(STATUS_DESIGNS_DELIVERED);
    const isInsightsDelivered = normalizedStatus === normalizeValue(STATUS_INSIGHTS_DELIVERED);

    if (!isDesignsDelivered && !isInsightsDelivered) return;

    deliveredRows++;

    if (!timestamp || !deliverable) return;

    seenDeliverables.add(deliverable);

    const category = categorizeDeliverable(deliverable);
    if (!category) return;

    // INSIGHTS category uses "Insights Delivered" status
    // All other categories use "Designs Delivered" status
    if (category === "INSIGHTS" && !isInsightsDelivered) return;
    if (category !== "INSIGHTS" && !isDesignsDelivered) return;

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

  console.log(`Delivered rows: ${deliveredRows}, Matched: ${matchedRows}, Duplicates skipped: ${duplicateRows}`);
  console.log(`Unique deliverables: ${[...seenDeliverables].slice(0, 10).join(", ")}...`);

  // Calculate averages and WoW change
  categories.forEach(cat => {
    const weekly = stats.categories[cat].weekly;
    const sum = weekly.reduce((a, b) => a + b, 0);
    stats.categories[cat].fourWeekAvg = Math.round(sum / 4);

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

    // Step 3: Download and process each week's data independently
    const filesBefore = new Set(fs.readdirSync(DOWNLOAD_DIR));

    // Initialize stats structure
    const stats = {
      generatedAt: new Date().toISOString(),
      weeks: weeks.map(w => w.label),
      categories: {},
    };

    const categories = [
      "PERSONALITY", "DIGITAL ANALYSIS", "DIGITAL INTELLIGENCE", "MAPIT",
      "INSIGHTS", "INFOGRAPHICS", "PRESENTATIONS", "SNAPSHOTS", "RESOURCES",
      "TOTAL SENT TO DESIGN",
    ];

    categories.forEach(cat => {
      stats.categories[cat] = {
        weekly: weeks.map(() => 0),
        fourWeekAvg: 0,
        weekOverWeek: null,
      };
    });

    let totalRows = 0;
    let totalMatched = 0;

    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
      const week = weeks[weekIdx];
      const csvPath = await downloadWeekData(page, client, week, filesBefore);

      // Parse rows for this week only
      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const rows = parseCSV(csvContent);
      console.log(`Parsed ${rows.length} rows`);
      totalRows += rows.length;

      // Process rows for THIS week only (don't let rows cross into other weeks)
      let weekMatched = 0;
      rows.forEach(row => {
        const status = row[COL_NEW_STATUS];
        const timestamp = row[COL_TIMESTAMP];
        const deliverable = row[COL_DELIVERABLE];

        const normalizedStatus = normalizeValue(status || "");
        const isDesignsDelivered = normalizedStatus === normalizeValue(STATUS_DESIGNS_DELIVERED);
        const isInsightsDelivered = normalizedStatus === normalizeValue(STATUS_INSIGHTS_DELIVERED);

        if (!isDesignsDelivered && !isInsightsDelivered) return;
        if (!timestamp || !deliverable) return;

        const category = categorizeDeliverable(deliverable);
        if (!category) return;

        if (category === "INSIGHTS" && !isInsightsDelivered) return;
        if (category !== "INSIGHTS" && !isDesignsDelivered) return;

        // Parse timestamp and check it falls within THIS week's boundaries
        const deliveredDate = new Date(timestamp.replace(" ", "T") + "Z");
        if (deliveredDate >= week.start && deliveredDate <= week.end) {
          stats.categories[category].weekly[weekIdx]++;
          stats.categories["TOTAL SENT TO DESIGN"].weekly[weekIdx]++;
          weekMatched++;
        }
      });

      console.log(`Week ${weekIdx + 1} matched: ${weekMatched} rows`);
      totalMatched += weekMatched;
    }

    console.log(`\nTotal rows: ${totalRows}, Matched: ${totalMatched}`);

    // Calculate averages and WoW change
    categories.forEach(cat => {
      const weekly = stats.categories[cat].weekly;
      const sum = weekly.reduce((a, b) => a + b, 0);
      stats.categories[cat].fourWeekAvg = Math.round(sum / 4);

      const lastWeek = weekly[3];
      const prevWeek = weekly[2];
      if (prevWeek > 0) {
        stats.categories[cat].weekOverWeek = Math.round(((lastWeek - prevWeek) / prevWeek) * 100);
      }
    });

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

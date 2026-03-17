const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

// --- Configuration ---
const TOPLINE_EMAIL = process.env.TOPLINE_EMAIL;
const TOPLINE_PASSWORD = process.env.TOPLINE_PASSWORD;
const EXPORT_URL = "https://topline.futurimedia.com/admin/reports";
const DOWNLOAD_DIR = path.resolve(__dirname, "downloads");
const OUTPUT_DIR = path.resolve(__dirname, "../dashboard/public/data");

// Table 1: Weekly Research Stats - mapping from CSV labels
const RESEARCH_STATS_LABELS = [
  "Research Requests submitted - Analysts",
  "Reports created - Analysts",
  "TOTAL RESEARCH REQUESTS submitted",
  "TOTAL REPORTS created",
  "PERSONALITY completed",
  "DIGITAL ANALYSIS completed",
  "DIGITAL INTELLIGENCE completed",
  "MAPIT delivered",
  "INSIGHTS delivered",
  "INFOGRAPHICS delivered",
  "PRESENTATIONS delivered",
  "SNAPSHOTS delivered",
  "RESOURCES delivered",
  "Sent to Design",
];

// Table 2: Deliverables columns
const DELIVERABLES_COLUMNS = [
  "Personality prep",
  "Digital Allocation",
  "Map (A)",
  "Map Total",
  "Research by Analysts (Average minutes)",
];

// --- Date Utilities ---

function getMondayUTC(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function getPrior4Weeks() {
  const today = new Date();
  const currentMonday = getMondayUTC(today);
  const lastMonday = new Date(currentMonday);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);

  const weeks = [];
  for (let i = 0; i < 4; i++) {
    const weekStart = new Date(lastMonday);
    weekStart.setUTCDate(weekStart.getUTCDate() - (i * 7));
    weekStart.setUTCHours(0, 0, 0, 0);

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

function parseReportCSV(csvText) {
  const lines = csvText.split("\n");
  const data = {
    researchStats: {},
    deliverables: {
      total: {},
      hours: {},
    },
  };

  let inDeliverablesSection = false;
  let columnHeaders = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for section header
    if (line.includes("Deliverables and Total Hours")) {
      inDeliverablesSection = true;
      continue;
    }

    // Parse Deliverables section headers
    if (inDeliverablesSection && line.startsWith(",")) {
      // This is the header row: ,"Personality prep","Digital Allocation",...
      columnHeaders = line.split(",").slice(1).map(h => h.replace(/"/g, "").trim());
      continue;
    }

    // Parse Total row in Deliverables section
    if (inDeliverablesSection && line.startsWith("Total,")) {
      const values = line.split(",").slice(1);
      columnHeaders.forEach((col, idx) => {
        data.deliverables.total[col] = parseFloat(values[idx]) || 0;
      });
      continue;
    }

    // Parse Hours row in Deliverables section
    if (inDeliverablesSection && line.startsWith("Hours,")) {
      const values = line.split(",").slice(1);
      columnHeaders.forEach((col, idx) => {
        data.deliverables.hours[col] = parseFloat(values[idx]) || 0;
      });
      inDeliverablesSection = false; // Done with this section
      continue;
    }

    // Parse key-value pairs for Research Stats: "Label",value
    const match = line.match(/^"([^"]+)",(\d+(?:\.\d+)?)$/);
    if (match) {
      const label = match[1];
      const value = parseFloat(match[2]);
      if (RESEARCH_STATS_LABELS.includes(label)) {
        data.researchStats[label] = value;
      }
    }
  }

  return data;
}

// --- Download Helper ---

async function downloadWeekData(page, client, week, filesBefore, isFirstDownload = false) {
  console.log(`\n--- Downloading: ${week.label} ---`);

  if (!isFirstDownload) {
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });
  }

  await page.waitForSelector('input[type="date"]', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 500));

  const fromValue = formatDateForInput(week.start);
  const toValue = formatDateForInput(week.end);

  console.log(`Setting dates: ${fromValue} to ${toValue}`);

  // Set dates using JavaScript
  await page.evaluate(({ startDate, endDate }) => {
    const inputs = document.querySelectorAll('input[type="date"]');
    if (inputs[0]) {
      inputs[0].value = startDate;
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (inputs[1]) {
      inputs[1].value = endDate;
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[1].dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { startDate: fromValue, endDate: toValue });

  await new Promise(r => setTimeout(r, 1000));

  // Click download button
  console.log("Clicking Download button...");
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, a.btn')];
    const downloadBtn = buttons.find(btn =>
      btn.textContent?.toLowerCase().includes('download')
    );
    if (downloadBtn) downloadBtn.click();
  });

  await new Promise(r => setTimeout(r, 3000));

  // Wait for download
  let csvFile = null;
  const maxWait = 60000;
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
  const fileStats = fs.statSync(csvPath);
  console.log(`Downloaded: ${csvFile} (${(fileStats.size / 1024).toFixed(1)} KB)`);

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

  // Clean up old WeeklyReportData files
  const oldFiles = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith("WeeklyReportData_"));
  for (const file of oldFiles) {
    fs.unlinkSync(path.join(DOWNLOAD_DIR, file));
    console.log(`Cleaned up: ${file}`);
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
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });

  console.log(`Downloads will be saved to: ${DOWNLOAD_DIR}`);

  try {
    // Login
    console.log("Navigating to login...");
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });

    console.log("Logging in...");
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });

    const emailInput = await page.$('input[type="email"], input[name="email"]');
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

    // Navigate to reports page
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });

    const filesBefore = new Set(fs.readdirSync(DOWNLOAD_DIR));

    // Initialize stats structure
    const stats = {
      generatedAt: new Date().toISOString(),
      weeks: weeks.map(w => w.label),
      researchStats: {},
      deliverables: {
        total: {},
        hours: {},
      },
    };

    // Initialize research stats
    RESEARCH_STATS_LABELS.forEach(label => {
      stats.researchStats[label] = {
        weekly: weeks.map(() => 0),
        fourWeekAvg: 0,
        weekOverWeek: null,
      };
    });

    // Initialize deliverables
    DELIVERABLES_COLUMNS.forEach(col => {
      stats.deliverables.total[col] = {
        weekly: weeks.map(() => 0),
        fourWeekAvg: 0,
        weekOverWeek: null,
      };
      stats.deliverables.hours[col] = {
        weekly: weeks.map(() => 0),
        fourWeekAvg: 0,
        weekOverWeek: null,
      };
    });

    // Download and process each week
    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
      const week = weeks[weekIdx];
      const isFirstDownload = weekIdx === 0;
      const csvPath = await downloadWeekData(page, client, week, filesBefore, isFirstDownload);

      // Parse the CSV
      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const weekData = parseReportCSV(csvContent);

      // Store research stats for this week
      Object.entries(weekData.researchStats).forEach(([label, value]) => {
        if (stats.researchStats[label]) {
          stats.researchStats[label].weekly[weekIdx] = value;
        }
      });

      // Store deliverables for this week
      Object.entries(weekData.deliverables.total).forEach(([col, value]) => {
        if (stats.deliverables.total[col]) {
          stats.deliverables.total[col].weekly[weekIdx] = value;
        }
      });
      Object.entries(weekData.deliverables.hours).forEach(([col, value]) => {
        if (stats.deliverables.hours[col]) {
          stats.deliverables.hours[col].weekly[weekIdx] = value;
        }
      });

      console.log(`Parsed research stats:`, Object.keys(weekData.researchStats).length, "items");
      console.log(`Parsed deliverables:`, Object.keys(weekData.deliverables.total).length, "columns");
    }

    // Calculate averages and WoW change for research stats
    RESEARCH_STATS_LABELS.forEach(label => {
      const weekly = stats.researchStats[label].weekly;
      const sum = weekly.reduce((a, b) => a + b, 0);
      stats.researchStats[label].fourWeekAvg = Math.round(sum / 4);

      const lastWeek = weekly[3];
      const prevWeek = weekly[2];
      if (prevWeek > 0) {
        stats.researchStats[label].weekOverWeek = Math.round(((lastWeek - prevWeek) / prevWeek) * 100);
      }
    });

    // Calculate averages and WoW change for deliverables
    DELIVERABLES_COLUMNS.forEach(col => {
      // Total counts
      const totalWeekly = stats.deliverables.total[col].weekly;
      const totalSum = totalWeekly.reduce((a, b) => a + b, 0);
      stats.deliverables.total[col].fourWeekAvg = Math.round(totalSum / 4);
      if (totalWeekly[2] > 0) {
        stats.deliverables.total[col].weekOverWeek = Math.round(((totalWeekly[3] - totalWeekly[2]) / totalWeekly[2]) * 100);
      }

      // Hours
      const hoursWeekly = stats.deliverables.hours[col].weekly;
      const hoursSum = hoursWeekly.reduce((a, b) => a + b, 0);
      stats.deliverables.hours[col].fourWeekAvg = Math.round(hoursSum * 10 / 4) / 10; // One decimal place
      if (hoursWeekly[2] > 0) {
        stats.deliverables.hours[col].weekOverWeek = Math.round(((hoursWeekly[3] - hoursWeekly[2]) / hoursWeekly[2]) * 100);
      }
    });

    // Save JSON
    const outputPath = path.join(OUTPUT_DIR, "topline-stats.json");
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log(`\nOutput saved to: ${outputPath}`);

    // Print summary
    console.log("\n--- Table 1: Weekly Research Stats ---");
    RESEARCH_STATS_LABELS.forEach(label => {
      const data = stats.researchStats[label];
      const wow = data.weekOverWeek !== null ? `${data.weekOverWeek}%` : "N/A";
      console.log(`${label.padEnd(40)}: ${data.weekly.map(n => String(n).padStart(6)).join("")} | Avg: ${String(data.fourWeekAvg).padStart(6)} | WoW: ${wow}`);
    });

    console.log("\n--- Table 2: Deliverables (Total) ---");
    DELIVERABLES_COLUMNS.forEach(col => {
      const data = stats.deliverables.total[col];
      const wow = data.weekOverWeek !== null ? `${data.weekOverWeek}%` : "N/A";
      console.log(`${col.padEnd(40)}: ${data.weekly.map(n => String(n).padStart(6)).join("")} | Avg: ${String(data.fourWeekAvg).padStart(6)} | WoW: ${wow}`);
    });

    console.log("\n--- Table 2: Deliverables (Hours) ---");
    DELIVERABLES_COLUMNS.forEach(col => {
      const data = stats.deliverables.hours[col];
      const wow = data.weekOverWeek !== null ? `${data.weekOverWeek}%` : "N/A";
      console.log(`${col.padEnd(40)}: ${data.weekly.map(n => String(n).padStart(6)).join("")} | Avg: ${String(data.fourWeekAvg).padStart(6)} | WoW: ${wow}`);
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

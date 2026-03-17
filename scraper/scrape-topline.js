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

// Mapping from CSV labels to our dashboard categories
const CATEGORY_LABELS = {
  "PERSONALITY completed": "PERSONALITY",
  "DIGITAL ANALYSIS completed": "DIGITAL ANALYSIS",
  "DIGITAL INTELLIGENCE completed": "DIGITAL INTELLIGENCE",
  "MAPIT delivered": "MAPIT",
  "INSIGHTS delivered": "INSIGHTS",
  "INFOGRAPHICS delivered": "INFOGRAPHICS",
  "PRESENTATIONS delivered": "PRESENTATIONS",
  "SNAPSHOTS delivered": "SNAPSHOTS",
  "RESOURCES delivered": "RESOURCES",
};

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

// --- CSV Parsing for new /admin/reports format ---

function parseReportCSV(csvText) {
  const lines = csvText.split("\n");
  const data = {};

  for (const line of lines) {
    // Parse each line for key-value pairs like: "PERSONALITY completed",9196
    const match = line.match(/^"([^"]+)",(\d+)$/);
    if (match) {
      const label = match[1];
      const value = parseInt(match[2], 10);

      // Check if this label maps to one of our categories
      if (CATEGORY_LABELS[label]) {
        data[CATEGORY_LABELS[label]] = value;
      }
    }
  }

  return data;
}

// --- Download Helper ---

async function downloadWeekData(page, client, week, filesBefore, isFirstDownload = false) {
  console.log(`\n--- Downloading: ${week.label} ---`);

  // Only navigate if this is the first download (we're already on the page after login)
  if (!isFirstDownload) {
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });
  }

  // Wait for page to be ready
  await page.waitForSelector('input[type="date"]', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 500));

  const fromValue = formatDateForInput(week.start);
  const toValue = formatDateForInput(week.end);

  console.log(`Setting dates: ${fromValue} to ${toValue}`);

  // Set dates using JavaScript - HTML5 date inputs need programmatic value setting
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

  // Verify dates were set
  const setDates = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="date"]');
    return {
      start: inputs[0]?.value,
      end: inputs[1]?.value,
    };
  });
  console.log(`Dates verified: ${setDates.start} to ${setDates.end}`);

  // Find the Download button specifically (it contains "Download" text)
  const buttonInfo = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, a.btn')];
    const downloadBtn = buttons.find(btn =>
      btn.textContent?.toLowerCase().includes('download')
    );
    if (downloadBtn) {
      return {
        text: downloadBtn.textContent?.trim(),
        tagName: downloadBtn.tagName,
        href: downloadBtn.href || null,
        outerHTML: downloadBtn.outerHTML.slice(0, 500),
      };
    }
    return null;
  });
  console.log("Download button info:", buttonInfo);

  if (!buttonInfo) {
    throw new Error("Download button not found");
  }

  // Click download button
  console.log("Clicking Download button...");
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, a.btn')];
    const downloadBtn = buttons.find(btn =>
      btn.textContent?.toLowerCase().includes('download')
    );
    if (downloadBtn) downloadBtn.click();
  });

  await new Promise(r => setTimeout(r, 3000)); // Wait for download to start

  // Wait for download - look for WeeklyReportData_*.csv files
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

  // Clean up old WeeklyReportData files to avoid conflicts
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

  // Configure download behavior using Page-level CDP (more reliable)
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
  });

  console.log(`Downloads will be saved to: ${DOWNLOAD_DIR}`);

  try {
    // Step 1: Navigate to reports page (redirects to login)
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

    // Initialize stats structure
    const categories = [
      "PERSONALITY", "DIGITAL ANALYSIS", "DIGITAL INTELLIGENCE", "MAPIT",
      "INSIGHTS", "INFOGRAPHICS", "PRESENTATIONS", "SNAPSHOTS", "RESOURCES",
      "TOTAL SENT TO DESIGN",
    ];

    const stats = {
      generatedAt: new Date().toISOString(),
      weeks: weeks.map(w => w.label),
      categories: {},
    };

    categories.forEach(cat => {
      stats.categories[cat] = {
        weekly: weeks.map(() => 0),
        fourWeekAvg: 0,
        weekOverWeek: null,
      };
    });

    // Navigate to reports page once (after login redirect)
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Download and process each week
    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
      const week = weeks[weekIdx];
      const isFirstDownload = weekIdx === 0;
      const csvPath = await downloadWeekData(page, client, week, filesBefore, isFirstDownload);

      // Parse the new CSV format
      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const weekData = parseReportCSV(csvContent);

      console.log(`Parsed values:`, weekData);

      // Store values for this week
      let weekTotal = 0;
      Object.entries(weekData).forEach(([category, value]) => {
        if (stats.categories[category]) {
          stats.categories[category].weekly[weekIdx] = value;
          weekTotal += value;
        }
      });

      // Calculate total sent to design
      stats.categories["TOTAL SENT TO DESIGN"].weekly[weekIdx] = weekTotal;
    }

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

    // Step 4: Save JSON
    const outputPath = path.join(OUTPUT_DIR, "topline-stats.json");
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log(`\nOutput saved to: ${outputPath}`);

    // Print summary
    console.log("\n--- Summary ---");
    console.log(`Weeks: ${stats.weeks.join(" | ")}`);
    console.log("");
    Object.entries(stats.categories).forEach(([cat, data]) => {
      const wow = data.weekOverWeek !== null ? `${data.weekOverWeek}%` : "N/A";
      console.log(`${cat.padEnd(22)}: ${data.weekly.map(n => String(n).padStart(5)).join(" ")} | Avg: ${String(data.fourWeekAvg).padStart(5)} | WoW: ${wow}`);
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

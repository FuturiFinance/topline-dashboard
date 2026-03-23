const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

// --- Configuration ---
const TOPLINE_EMAIL = process.env.TOPLINE_EMAIL;
const TOPLINE_PASSWORD = process.env.TOPLINE_PASSWORD;
const EXPORT_URL = "https://topline.futurimedia.com/admin/reports";
const STATS_URL = "https://topline.futurimedia.com/admin/research/stats";
const DOWNLOAD_DIR = path.resolve(__dirname, "downloads");
const OUTPUT_DIR = path.resolve(__dirname, "../dashboard/public/data");

// Analysts for Pull 2 - exact dropdown names
const RADIO_ANALYSTS = [
  "Adam Town",
  "Alison D'Alessandro",
  "Amanda Grondolsky",
  "Anthony Alford",
  "Carly Brabander",
  "Cheryl Kanak",
  "Jenn Hoskins",
  "Jordan Frank",
  "Kyle Cornell",
  "Marina Nasonti",
  "Steve Nichols",
  "Terry Groden",
];

const TV_ANALYSTS = [
  "Damaris Parker",
  "Hayley Mitchell",
  "Jeff Suss",
  "Marta Barone",
  "Meghan Spezialetti",
  "Nicole Chisholm",
  "Rose Eppich",
];

const ALL_ANALYSTS = [...RADIO_ANALYSTS, ...TV_ANALYSTS];

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
    analystStats: [], // Array of { name, reportsCompleted, avgMinutes }
  };

  let currentSection = null;
  let columnHeaders = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section headers
    if (line.includes("Deliverables and Total Hours")) {
      currentSection = "deliverables";
      continue;
    }
    if (line.includes("Analyst Stats")) {
      currentSection = "analystStats";
      continue;
    }
    if (line.includes("TOPLINE Capacity Analysis")) {
      currentSection = null; // Stop parsing
      continue;
    }

    // Parse Deliverables section
    if (currentSection === "deliverables") {
      if (line.startsWith(",")) {
        // Header row
        columnHeaders = line.split(",").slice(1).map(h => h.replace(/"/g, "").trim());
        continue;
      }
      if (line.startsWith("Total,")) {
        const values = line.split(",").slice(1);
        columnHeaders.forEach((col, idx) => {
          data.deliverables.total[col] = parseFloat(values[idx]) || 0;
        });
        continue;
      }
      if (line.startsWith("Hours,")) {
        const values = line.split(",").slice(1);
        columnHeaders.forEach((col, idx) => {
          data.deliverables.hours[col] = parseFloat(values[idx]) || 0;
        });
        currentSection = null;
        continue;
      }
    }

    // Parse Analyst Stats section
    if (currentSection === "analystStats") {
      // Skip header row
      if (line.startsWith(",")) {
        continue;
      }
      // Parse analyst data: Name,ReportsCompleted,AvgMinutes
      // Handle BOM character and clean name
      const parts = line.split(",");
      if (parts.length >= 3) {
        const name = parts[0].replace(/[^\x20-\x7E]/g, "").trim(); // Remove non-printable chars
        const reportsCompleted = parseInt(parts[1], 10) || 0;
        const avgMinutes = parseInt(parts[2], 10) || 0;
        if (name && name.length > 0) {
          data.analystStats.push({ name, reportsCompleted, avgMinutes });
        }
      }
    }

    // Parse key-value pairs for Research Stats
    const match = line.match(/^"([^"]+)",(\d+(?:\.\d+)?)$/);
    if (match && currentSection !== "analystStats") {
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

  console.log("Clicking Download button...");
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, a.btn')];
    const downloadBtn = buttons.find(btn =>
      btn.textContent?.toLowerCase().includes('download')
    );
    if (downloadBtn) downloadBtn.click();
  });

  await new Promise(r => setTimeout(r, 3000));

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

// --- Pull 2: Per-Analyst Stats Scraper ---

async function scrapeAnalystStats(page, weeks) {
  console.log("\n\n=== PULL 2: Per-Analyst Stats ===");
  console.log(`Scraping ${ALL_ANALYSTS.length} analysts × ${weeks.length} weeks = ${ALL_ANALYSTS.length * weeks.length} pulls\n`);

  const analystUtilization = {};

  // Initialize structure for all analysts
  ALL_ANALYSTS.forEach(fullName => {
    // Extract first name for matching with dashboard
    const firstName = fullName.split(" ")[0];
    analystUtilization[firstName] = {
      fullName,
      team: RADIO_ANALYSTS.includes(fullName) ? "radio" : "tv",
      weekly: weeks.map(() => ({
        totalRequests: 0,
        totalReports: 0,
        totalDesigns: 0,
        avgRequestTime: 0,
        avgReportTime: 0,
        avgDesignTime: 0,
      })),
    };
  });

  // Navigate to stats page
  console.log("Navigating to Research Stats page...");
  await page.goto(STATS_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));

  // Set Date Type to 'Insights/Design Delivered'
  console.log("Setting Date Type to 'Insights/Design Delivered'...");
  const dateTypeSet = await page.evaluate(() => {
    const selects = document.querySelectorAll("select");
    for (const select of selects) {
      const options = [...select.options];
      // Log all options for debugging
      console.log("Select options:", options.map(o => o.text).join(", "));

      // Look specifically for "Insights/Design Delivered" - must have all three words
      const deliveredOption = options.find(opt =>
        opt.text.toLowerCase().includes("insights") &&
        opt.text.toLowerCase().includes("design") &&
        opt.text.toLowerCase().includes("delivered")
      );

      if (deliveredOption) {
        select.value = deliveredOption.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return { found: true, text: deliveredOption.text, value: deliveredOption.value };
      }
    }
    return { found: false };
  });

  if (dateTypeSet.found) {
    console.log(`Date Type set to: "${dateTypeSet.text}" (value: ${dateTypeSet.value})`);
  } else {
    console.log("WARNING: Could not find 'Insights/Design Delivered' option!");
    // Take screenshot to debug
    const debugPath = path.join(DOWNLOAD_DIR, "debug-date-type.png");
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log(`Debug screenshot saved: ${debugPath}`);
  }

  await new Promise(r => setTimeout(r, 500));

  // Take verification screenshot of the page with Date Type set
  const dateTypeScreenshot = path.join(DOWNLOAD_DIR, "date-type-verification.png");
  await page.screenshot({ path: dateTypeScreenshot, fullPage: true });
  console.log(`Date Type verification screenshot saved: ${dateTypeScreenshot}`);

  let isFirstSearch = true;

  // Loop through each analyst and each week
  for (const fullName of ALL_ANALYSTS) {
    const firstName = fullName.split(" ")[0];
    console.log(`\n--- Analyst: ${fullName} ---`);

    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
      const week = weeks[weekIdx];
      const fromValue = formatDateForInput(week.start);
      const toValue = formatDateForInput(week.end);

      console.log(`  Week ${weekIdx + 1}: ${week.label}`);

      // Set date range
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

      await new Promise(r => setTimeout(r, 300));

      // First clear any existing analyst selections
      await page.evaluate(() => {
        // Click any X buttons to clear existing selections
        const closeButtons = document.querySelectorAll('[class*="multiValue"] [class*="remove"], .react-select__multi-value__remove, [aria-label="Remove"]');
        closeButtons.forEach(btn => btn.click());
      });
      await new Promise(r => setTimeout(r, 200));

      // Select analyst - try multiple methods
      const analystSelected = await page.evaluate((analystName) => {
        // Method 1: Try regular select
        const selects = document.querySelectorAll("select");
        for (const select of selects) {
          const options = [...select.options];
          const analystOption = options.find(opt =>
            opt.text.trim() === analystName || opt.text.includes(analystName)
          );
          // Skip Date Type and Research Type dropdowns
          if (analystOption &&
              !analystOption.text.toLowerCase().includes("submitted") &&
              !analystOption.text.toLowerCase().includes("delivered") &&
              !analystOption.text.toLowerCase().includes("insights")) {
            select.value = analystOption.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return { found: true, method: "select", text: analystOption.text };
          }
        }

        // Method 2: Try clicking on the Analysts input to open dropdown
        const labels = document.querySelectorAll("label, td, th");
        for (const label of labels) {
          if (label.textContent.toLowerCase().includes("analyst")) {
            // Find the closest input or select-like element
            const container = label.closest("tr") || label.parentElement;
            const input = container.querySelector("input[type='text'], [class*='select'], [class*='Select']");
            if (input) {
              input.click();
              return { found: true, method: "click", needsType: true };
            }
          }
        }

        return { found: false };
      }, fullName);

      // If we need to type the analyst name
      if (analystSelected.needsType) {
        await page.keyboard.type(fullName);
        await new Promise(r => setTimeout(r, 300));
        await page.keyboard.press("Enter");
        await new Promise(r => setTimeout(r, 200));
      }

      if (!analystSelected.found) {
        console.log(`    WARNING: Could not find analyst "${fullName}" in dropdown`);
        // Take debug screenshot
        const debugPath = path.join(DOWNLOAD_DIR, `debug-analyst-${firstName}.png`);
        await page.screenshot({ path: debugPath });
        continue;
      }

      await new Promise(r => setTimeout(r, 300));

      // Re-verify and set Date Type before each search (in case page reset it)
      const dateTypeStatus = await page.evaluate(() => {
        const selects = document.querySelectorAll("select");
        for (const select of selects) {
          const options = [...select.options];
          const deliveredOption = options.find(opt =>
            opt.text.toLowerCase().includes("insights") &&
            opt.text.toLowerCase().includes("design") &&
            opt.text.toLowerCase().includes("delivered")
          );
          if (deliveredOption) {
            const wasCorrect = select.value === deliveredOption.value;
            if (!wasCorrect) {
              select.value = deliveredOption.value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            const selectedText = select.options[select.selectedIndex]?.text || "unknown";
            return { wasCorrect, selectedText, value: select.value };
          }
        }
        return { found: false };
      });

      if (isFirstSearch) {
        console.log(`    Date Type check: "${dateTypeStatus.selectedText}" (was already correct: ${dateTypeStatus.wasCorrect})`);
      } else if (!dateTypeStatus.wasCorrect) {
        console.log(`    Date Type was reset, re-selected: "${dateTypeStatus.selectedText}"`);
      }
      await new Promise(r => setTimeout(r, 200));

      // Get current values before clicking Search (to detect when they change)
      const previousValues = await page.evaluate(() => {
        const tables = document.querySelectorAll("table");
        for (const table of tables) {
          const headerRow = table.querySelector("tr");
          if (!headerRow) continue;
          const headers = [...headerRow.querySelectorAll("th, td")].map(h => h.textContent.trim().toLowerCase());
          if (headers.some(h => h.includes("total requests"))) {
            const rows = table.querySelectorAll("tr");
            if (rows.length >= 2) {
              const cells = [...rows[1].querySelectorAll("td")];
              return cells.map(c => c.textContent.trim()).join("|");
            }
          }
        }
        return "";
      });

      // Click Search button
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll("button, input[type='submit']")];
        const searchBtn = buttons.find(btn =>
          btn.textContent?.toLowerCase().includes("search") ||
          btn.value?.toLowerCase().includes("search")
        );
        if (searchBtn) searchBtn.click();
      });

      // Wait for data to change (up to 10 seconds)
      let dataChanged = false;
      const maxWaitTime = 10000;
      const startTime = Date.now();

      while (!dataChanged && Date.now() - startTime < maxWaitTime) {
        await new Promise(r => setTimeout(r, 500));

        const currentValues = await page.evaluate(() => {
          const tables = document.querySelectorAll("table");
          for (const table of tables) {
            const headerRow = table.querySelector("tr");
            if (!headerRow) continue;
            const headers = [...headerRow.querySelectorAll("th, td")].map(h => h.textContent.trim().toLowerCase());
            if (headers.some(h => h.includes("total requests"))) {
              const rows = table.querySelectorAll("tr");
              if (rows.length >= 2) {
                const cells = [...rows[1].querySelectorAll("td")];
                return cells.map(c => c.textContent.trim()).join("|");
              }
            }
          }
          return "";
        });

        // Check if values changed OR if this is the first analyst (no previous values)
        if (currentValues !== previousValues || previousValues === "") {
          dataChanged = true;
        }
      }

      if (!dataChanged) {
        console.log(`    WARNING: Data may not have refreshed (waited ${maxWaitTime}ms)`);
      }

      // Extra wait to ensure data is fully loaded
      await new Promise(r => setTimeout(r, 1000));

      // Take screenshot on first search for verification
      if (isFirstSearch) {
        const screenshotPath = path.join(DOWNLOAD_DIR, "first-analyst-search.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`\n>>> Verification screenshot saved: ${screenshotPath}\n`);
        isFirstSearch = false;
      }

      // Scrape the summary row from the stats table
      const summaryData = await page.evaluate(() => {
        // Find the table with summary stats - it has headers like "Total Requests", "Total Reports", etc.
        const tables = document.querySelectorAll("table");

        for (const table of tables) {
          const headerRow = table.querySelector("tr");
          if (!headerRow) continue;

          const headers = [...headerRow.querySelectorAll("th, td")].map(h => h.textContent.trim().toLowerCase());

          // Check if this is the summary stats table
          if (headers.some(h => h.includes("total requests")) || headers.some(h => h.includes("total reports"))) {
            // Find the data row (usually the second row)
            const rows = table.querySelectorAll("tr");
            if (rows.length >= 2) {
              const dataRow = rows[1];
              const cells = [...dataRow.querySelectorAll("td")];

              // Map headers to values
              const result = {
                totalRequests: 0,
                avgRequestTime: "",
                totalReports: 0,
                avgReportTime: "",
                totalDesigns: 0,
                avgDesignTime: "",
              };

              headers.forEach((header, idx) => {
                const cellText = cells[idx]?.textContent.trim() || "";

                if (header.includes("total requests")) {
                  result.totalRequests = parseInt(cellText) || 0;
                } else if (header.includes("average request") || header.includes("avg request")) {
                  result.avgRequestTime = cellText;
                } else if (header.includes("total reports")) {
                  result.totalReports = parseInt(cellText) || 0;
                } else if (header.includes("average report") || header.includes("avg report")) {
                  result.avgReportTime = cellText;
                } else if (header.includes("total designs")) {
                  result.totalDesigns = parseInt(cellText) || 0;
                } else if (header.includes("average design") || header.includes("avg design")) {
                  result.avgDesignTime = cellText;
                }
              });

              return { found: true, ...result };
            }
          }
        }

        return { found: false };
      });

      // Parse time strings like "4 hours, 13 minutes 32 seconds" or "16 minutes 54 seconds" to minutes
      const parseTimeToMinutes = (timeStr) => {
        if (!timeStr || timeStr === "0") return 0;

        let totalMinutes = 0;
        const hourMatch = timeStr.match(/(\d+)\s*hour/i);
        const minMatch = timeStr.match(/(\d+)\s*minute/i);
        const secMatch = timeStr.match(/(\d+)\s*second/i);

        if (hourMatch) totalMinutes += parseInt(hourMatch[1]) * 60;
        if (minMatch) totalMinutes += parseInt(minMatch[1]);
        if (secMatch) totalMinutes += parseInt(secMatch[1]) / 60;

        return Math.round(totalMinutes * 10) / 10; // Round to 1 decimal
      };

      // Parse the summary data
      let weekData = {
        totalRequests: 0,
        totalReports: 0,
        totalDesigns: 0,
        avgRequestTime: 0,
        avgReportTime: 0,
        avgDesignTime: 0,
      };

      if (summaryData.found) {
        weekData.totalRequests = summaryData.totalRequests || 0;
        weekData.totalReports = summaryData.totalReports || 0;
        weekData.totalDesigns = summaryData.totalDesigns || 0;
        weekData.avgRequestTime = parseTimeToMinutes(summaryData.avgRequestTime);
        weekData.avgReportTime = parseTimeToMinutes(summaryData.avgReportTime);
        weekData.avgDesignTime = parseTimeToMinutes(summaryData.avgDesignTime);
      }

      analystUtilization[firstName].weekly[weekIdx] = weekData;
      console.log(`    >>> SCRAPED: ${fullName} | Week ${weekIdx + 1} | Requests: ${weekData.totalRequests}, Reports: ${weekData.totalReports}, Designs: ${weekData.totalDesigns} | AvgReqTime: ${weekData.avgRequestTime}min, AvgDesignTime: ${weekData.avgDesignTime}min`);

      // Clear analyst filter for next iteration - click the X on the tag
      await page.evaluate(() => {
        // Find and click the X button next to the analyst name tag
        const removeButtons = document.querySelectorAll('[class*="remove"], [aria-label*="Remove"], .close, .btn-close');
        removeButtons.forEach(btn => {
          // Only click if it's in the Analysts section
          const parent = btn.closest('tr, div');
          if (parent && parent.textContent.includes('Analyst')) {
            btn.click();
          }
        });

        // Also try clicking the × character directly
        const spans = document.querySelectorAll('span');
        spans.forEach(span => {
          if (span.textContent.trim() === '×' || span.textContent.trim() === 'x') {
            span.click();
          }
        });
      });

      await new Promise(r => setTimeout(r, 300));
    }
  }

  return analystUtilization;
}

// --- Main Scraper ---

async function run() {
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
      analystStats: {}, // { analystName: { reportsCompleted: [...], avgMinutes: [...], pctOfTotal: [...], weekOverWeek: null } }
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

    // Track all analysts across weeks
    const allAnalysts = new Set();
    const weeklyAnalystData = []; // Array of arrays, one per week

    // Download and process each week
    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
      const week = weeks[weekIdx];
      const isFirstDownload = weekIdx === 0;
      const csvPath = await downloadWeekData(page, client, week, filesBefore, isFirstDownload);

      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const weekData = parseReportCSV(csvContent);

      // Store research stats
      Object.entries(weekData.researchStats).forEach(([label, value]) => {
        if (stats.researchStats[label]) {
          stats.researchStats[label].weekly[weekIdx] = value;
        }
      });

      // Store deliverables
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

      // Store analyst stats
      weekData.analystStats.forEach(a => allAnalysts.add(a.name));
      weeklyAnalystData[weekIdx] = weekData.analystStats;

      console.log(`Parsed research stats: ${Object.keys(weekData.researchStats).length} items`);
      console.log(`Parsed deliverables: ${Object.keys(weekData.deliverables.total).length} columns`);
      console.log(`Parsed analysts: ${weekData.analystStats.length} analysts`);
    }

    // Build analyst stats structure
    const analystNames = [...allAnalysts].sort();
    analystNames.forEach(name => {
      stats.analystStats[name] = {
        reportsCompleted: weeks.map(() => 0),
        avgMinutes: weeks.map(() => 0),
        pctOfTotal: weeks.map(() => 0),
        fourWeekAvg: 0,
        weekOverWeek: null,
      };
    });

    // Fill in analyst data per week and calculate % of total
    for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
      const weekAnalysts = weeklyAnalystData[weekIdx] || [];
      const totalReports = weekAnalysts.reduce((sum, a) => sum + a.reportsCompleted, 0);

      weekAnalysts.forEach(a => {
        if (stats.analystStats[a.name]) {
          stats.analystStats[a.name].reportsCompleted[weekIdx] = a.reportsCompleted;
          stats.analystStats[a.name].avgMinutes[weekIdx] = a.avgMinutes;
          stats.analystStats[a.name].pctOfTotal[weekIdx] = totalReports > 0
            ? Math.round((a.reportsCompleted / totalReports) * 1000) / 10 // One decimal
            : 0;
        }
      });
    }

    // Calculate averages and WoW for research stats
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

    // Calculate averages and WoW for deliverables
    DELIVERABLES_COLUMNS.forEach(col => {
      const totalWeekly = stats.deliverables.total[col].weekly;
      const totalSum = totalWeekly.reduce((a, b) => a + b, 0);
      stats.deliverables.total[col].fourWeekAvg = Math.round(totalSum / 4);
      if (totalWeekly[2] > 0) {
        stats.deliverables.total[col].weekOverWeek = Math.round(((totalWeekly[3] - totalWeekly[2]) / totalWeekly[2]) * 100);
      }

      const hoursWeekly = stats.deliverables.hours[col].weekly;
      const hoursSum = hoursWeekly.reduce((a, b) => a + b, 0);
      stats.deliverables.hours[col].fourWeekAvg = Math.round(hoursSum * 10 / 4) / 10;
      if (hoursWeekly[2] > 0) {
        stats.deliverables.hours[col].weekOverWeek = Math.round(((hoursWeekly[3] - hoursWeekly[2]) / hoursWeekly[2]) * 100);
      }
    });

    // Calculate averages and WoW for analysts
    analystNames.forEach(name => {
      const data = stats.analystStats[name];
      const sum = data.reportsCompleted.reduce((a, b) => a + b, 0);
      data.fourWeekAvg = Math.round(sum / 4);

      const lastWeek = data.reportsCompleted[3];
      const prevWeek = data.reportsCompleted[2];
      if (prevWeek > 0) {
        data.weekOverWeek = Math.round(((lastWeek - prevWeek) / prevWeek) * 100);
      } else if (lastWeek > 0) {
        data.weekOverWeek = 100; // New this week
      }
    });

    // ========== PULL 2: Per-Analyst Utilization Stats ==========
    const analystUtilization = await scrapeAnalystStats(page, weeks);
    stats.utilization = analystUtilization;

    // Save JSON
    const outputPath = path.join(OUTPUT_DIR, "topline-stats.json");
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log(`\nOutput saved to: ${outputPath}`);

    // Print summaries
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

    console.log("\n--- Table 3: Analyst Stats (Reports Completed) ---");
    analystNames.forEach(name => {
      const data = stats.analystStats[name];
      const wow = data.weekOverWeek !== null ? `${data.weekOverWeek}%` : "N/A";
      console.log(`${name.padEnd(20)}: ${data.reportsCompleted.map(n => String(n).padStart(5)).join("")} | Avg: ${String(data.fourWeekAvg).padStart(4)} | WoW: ${wow}`);
    });

    console.log("\n--- Pull 2: Utilization by Analyst (Most Recent Week) ---");
    console.log("\nRadio Team:");
    RADIO_ANALYSTS.forEach(fullName => {
      const firstName = fullName.split(" ")[0];
      const data = stats.utilization[firstName];
      if (data) {
        const week = data.weekly[3];
        console.log(`  ${firstName.padEnd(12)}: Req=${week.totalRequests}, Reports=${week.totalReports}, Designs=${week.totalDesigns}`);
      }
    });
    console.log("\nTV Team:");
    TV_ANALYSTS.forEach(fullName => {
      const firstName = fullName.split(" ")[0];
      const data = stats.utilization[firstName];
      if (data) {
        const week = data.weekly[3];
        console.log(`  ${firstName.padEnd(12)}: Req=${week.totalRequests}, Reports=${week.totalReports}, Designs=${week.totalDesigns}`);
      }
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

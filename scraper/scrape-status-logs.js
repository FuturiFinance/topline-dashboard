const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

// --- Configuration ---
const TOPLINE_EMAIL = process.env.TOPLINE_EMAIL;
const TOPLINE_PASSWORD = process.env.TOPLINE_PASSWORD;
const EXPORT_URL =
  "https://topline.futurimedia.com/admin/research/status_logs_export";
const DOWNLOAD_DIR = path.resolve(__dirname, "downloads");

// Optional: override date range via CLI args (format: MM/DD/YYYY)
// Usage: node scrape-status-logs.js 01/01/2026 03/17/2026
// Default: first of current month to today
function getDefaultFromDate() {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}/01/${now.getFullYear()}`;
}
function getDefaultToDate() {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
}
const FROM_DATE = process.argv[2] || getDefaultFromDate();
const THROUGH_DATE = process.argv[3] || getDefaultToDate();

async function run() {
  // Ensure download directory exists
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Configure download behavior using Browser.setDownloadBehavior (newer API)
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  });

  try {
    // Step 1: Navigate to the export page (will redirect to login)
    console.log("Navigating to export page...");
    await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Step 2: Fill in login credentials
    console.log("Logging in...");
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', { timeout: 10000 });
    
    // Clear and type email
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail"]');
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(TOPLINE_EMAIL, { delay: 50 });

    // Clear and type password
    const passwordInput = await page.$('input[type="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(TOPLINE_PASSWORD, { delay: 50 });

    // Click login button
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    console.log("Logged in. Current URL:", page.url());

    // Step 3: Navigate to export page if not already there
    if (!page.url().includes("status_logs_export")) {
      console.log("Navigating to export page...");
      await page.goto(EXPORT_URL, { waitUntil: "networkidle2", timeout: 30000 });
    }

    // Step 4: Set date range
    // Wait for date inputs to be present
    await page.waitForSelector('input[type="date"]', { timeout: 10000 });
    const dateInputs = await page.$$('input[type="date"]');

    if (dateInputs.length >= 2) {
      // Convert MM/DD/YYYY to YYYY-MM-DD for HTML date input
      const fromParts = FROM_DATE.split('/');
      const fromValue = `${fromParts[2]}-${fromParts[0]}-${fromParts[1]}`;
      console.log(`Setting Start date: ${FROM_DATE} -> ${fromValue}`);

      // Set value and dispatch events to trigger any listeners
      await dateInputs[0].evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, fromValue);

      const toParts = THROUGH_DATE.split('/');
      const toValue = `${toParts[2]}-${toParts[0]}-${toParts[1]}`;
      console.log(`Setting End date: ${THROUGH_DATE} -> ${toValue}`);

      await dateInputs[1].evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, toValue);

      // Small delay to let any JS handlers process
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log("Could not find both date inputs, proceeding anyway...");
    }

    // Take screenshot before clicking download
    await page.screenshot({
      path: path.join(DOWNLOAD_DIR, "before-download.png"),
    });
    console.log("Screenshot taken before download.");
    console.log("Current URL before download:", page.url());

    // Step 5: Click "Download CSV" and wait for download
    console.log("Clicking Download CSV...");

    // Get list of files before download
    const filesBefore = new Set(fs.readdirSync(DOWNLOAD_DIR));

    // Set up download event listener
    let downloadStarted = false;
    client.on('Browser.downloadProgress', (event) => {
      console.log(`Download progress: ${event.state}`);
      if (event.state === 'completed') {
        downloadStarted = true;
      }
    });

    // Find the Download CSV button specifically
    const downloadButton = await page.evaluateHandle(() => {
      const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
      return buttons.find(el => el.textContent?.includes('Download CSV') || el.value?.includes('Download CSV'));
    });

    if (downloadButton) {
      // Click using Puppeteer's click which handles form submissions properly
      await downloadButton.asElement()?.click();
      console.log("Clicked Download CSV button.");
    } else {
      throw new Error("Download CSV button not found");
    }

    // Wait for navigation or download
    await new Promise(r => setTimeout(r, 3000));
    console.log("Current URL after download click:", page.url());

    // Wait for the CSV file to appear in downloads
    console.log("Waiting for download to complete...");
    let csvFile = null;
    const maxWait = 60000; // 60 seconds
    const startTime = Date.now();

    while (!csvFile && Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 1000));
      const filesNow = fs.readdirSync(DOWNLOAD_DIR);
      const newFiles = filesNow.filter(
        (f) => !filesBefore.has(f) && !f.endsWith(".crdownload")
      );
      if (newFiles.length > 0) {
        csvFile = newFiles[0];
      }
    }

    if (csvFile) {
      const fullPath = path.join(DOWNLOAD_DIR, csvFile);
      const stats = fs.statSync(fullPath);
      console.log(`Download complete: ${csvFile} (${stats.size} bytes)`);
      console.log(`Saved to: ${fullPath}`);
    } else {
      console.error("Download timed out. Check the page manually.");
      // Take a screenshot for debugging
      await page.screenshot({
        path: path.join(DOWNLOAD_DIR, "debug-screenshot.png"),
      });
      console.log("Debug screenshot saved.");
    }
  } catch (err) {
    console.error("Error:", err.message);
    await page.screenshot({
      path: path.join(DOWNLOAD_DIR, "error-screenshot.png"),
    });
    console.log("Error screenshot saved.");
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

run();

import { spawn, spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

// Verify Python interpreter meets minimum version required by pyairbnb
function checkPythonVersion() {
  const pythonCmd = process.env.PYTHON_PATH || 'python3';
  try {
  const proc = spawnSync(pythonCmd, ['--version']);
    const out = (proc.stdout || proc.stderr || '').toString().trim();
    const m = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
    if (!m) return { ok: true };
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    if (major < 3 || (major === 3 && minor < 10)) {
      return { ok: false, message: `Python ${major}.${minor} found — pyairbnb requires Python >= 3.10` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Could not determine python version using ${process.env.PYTHON_PATH || 'python3'}: ${err.message}` };
  }
}

/**
 * Execute Python scraper script
 * @param {string} scriptPath - Path to Python script
 * @param {object} data - Data to pass to Python script
 * @returns {Promise<object>} - Scraped data
 */
export async function executePythonScript(scriptPath, data) {
  return new Promise((resolve, reject) => {
    const vcheck = checkPythonVersion();
    if (!vcheck.ok) {
      return reject(new Error(`Python version check failed: ${vcheck.message}`));
    }
    // Create temp file for input data
    const tempId = crypto.randomBytes(8).toString('hex');
    const inputFile = join(process.env.TEMP_DIR || '/tmp', `input_${tempId}.json`);
    const outputFile = join(process.env.TEMP_DIR || '/tmp', `output_${tempId}.json`);

    try {
      // Write input data
      writeFileSync(inputFile, JSON.stringify(data));

      // Spawn Python process
      const pythonProcess = spawn(process.env.PYTHON_PATH || 'python3', [
        scriptPath,
        inputFile,
        outputFile
      ]);

      let stderr = '';

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        try {
          // Clean up input file
          unlinkSync(inputFile);

          if (code !== 0) {
            console.error('Python script error:', stderr);
            reject(new Error(`Python script exited with code ${code}: ${stderr}`));
            return;
          }

          // Read output
          const output = readFileSync(outputFile, 'utf-8');
          unlinkSync(outputFile);

          const result = JSON.parse(output);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      pythonProcess.on('error', (error) => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Search Airbnb listings
 */
export async function searchAirbnb(params) {
  const scriptPath = join(process.cwd(), 'src', 'python', 'search_listings.py');
  return await executePythonScript(scriptPath, params);
}

/**
 * Get listing details
 */
export async function getListingDetails(listingId) {
  const scriptPath = join(process.cwd(), 'src', 'python', 'get_listing.py');
  return await executePythonScript(scriptPath, { listing_id: listingId });
}

/**
 * Get calendar availability
 */
export async function getCalendar(listingId) {
  const scriptPath = join(process.cwd(), 'src', 'python', 'get_calendar.py');
  return await executePythonScript(scriptPath, { listing_id: listingId });
}

import express from "express";
import {promises as fs} from "fs";
import {spawn} from "child_process";
import {tmpdir} from "os";
import {join} from "path";
import {v4 as uuidv4} from "uuid";

const app = express();
app.use(express.json({limit: "100kb"}));

const NSJAIL_BIN = "/usr/bin/nsjail";
const NODE_BIN = "/usr/bin/node";
const JOB_TIMEOUT_MS = 5000;
const JOB_MEMORY_LIMIT_MB = 256;

app.get("/health", (req, res) => res.status(200).json({status: "ok"}));

app.post("/run", async (req, res) => {
    const {script, functionName, input} = req.body;
    console.log("Received job request:");
    console.log("Function:", functionName);
    console.log("Input:", input);
    console.log("Script:\n", script);

    if (!script) {
        console.error("No script provided in request");
        return res.status(400).json({error: "script is required"});
    }

    const jobId = uuidv4();
    const workDir = join(tmpdir(), `job-${jobId}`);
    console.log("Creating temporary work directory:", workDir);

    try {
        await fs.mkdir(workDir, {mode: 0o700});

        const scriptFile = join(workDir, "script.js");
        const runnerFile = join(workDir, "runner.js");

        console.log("Writing user script to:", scriptFile);
        await fs.writeFile(scriptFile, script, {mode: 0o600});

        // Create wrapper to run function or full script
        let runnerContent;
        if (functionName) {
            runnerContent = `
import('${scriptFile}').then(mod => {
  console.log("Module loaded successfully");
  const fn = mod['${functionName}'] || global['${functionName}'];
  if (typeof fn !== 'function') {
    console.error('Function not found:', '${functionName}');
    process.exit(1);
  }
  console.log('Running function:', '${functionName}', 'with input:', ${JSON.stringify(input ?? {})});
  const result = fn(${JSON.stringify(input ?? {})});
  console.log('Function result:', JSON.stringify(result));
}).catch(e => { console.error('Error loading module:', e); process.exit(1); });
`;
        } else {
            runnerContent = `
console.log("Running full script: ${scriptFile}");
import('${scriptFile}').catch(e => { console.error('Error running script:', e); process.exit(1); });
`;
        }

        console.log("Writing runner wrapper to:", runnerFile);
        await fs.writeFile(runnerFile, runnerContent, {mode: 0o600});

        console.log("Starting nsjail execution");
        const result = await runWithNsJail({workDir, scriptFile: runnerFile});
        console.log("Execution finished with result:", result);

        res.status(200).json(result);
    } catch (err) {
        console.error("Job failed with error:", err);
        res.status(500).json({error: err.message});
    } finally {
        console.log("Cleaning up work directory:", workDir);
        fs.rm(workDir, {recursive: true, force: true}).catch(() => {
            console.warn("Failed to clean temporary directory:", workDir);
        });
    }
});

function runWithNsJail({workDir, scriptFile}) {
    return new Promise((resolve, reject) => {
        const args = [
            "--chroot", "/var/empty",
            "--cwd", workDir,
            "--user", "65534", "--group", "65534",
            "--disable_proc",
            "--time_limit", String(Math.ceil(JOB_TIMEOUT_MS / 1000)),
            "--rlimit_as", String(JOB_MEMORY_LIMIT_MB * 1024 * 1024),
            "--rlimit_fsize", String(1024 * 1024), // e.g., 1MB output limit
            "--",
            NODE_BIN, scriptFile
        ];

        console.log("Spawning nsjail process:", NSJAIL_BIN, args.join(" "));

        const child = spawn(NSJAIL_BIN, args, {cwd: workDir});
        let stdout = "", stderr = "";

        const timer = setTimeout(() => {
            console.error("Job exceeded time limit, killing process");
            child.kill("SIGKILL");
        }, JOB_TIMEOUT_MS + 1000);

        child.stdout.on("data", d => {
            const str = d.toString();
            stdout += str;
            console.log("[NSJAIL STDOUT]", str);
        });

        child.stderr.on("data", d => {
            const str = d.toString();
            stderr += str;
            console.error("[NSJAIL STDERR]", str);
        });

        child.on("close", code => {
            clearTimeout(timer);
            console.log(`nsjail exited with code ${code}`);
            resolve({success: code === 0, exitCode: code, stdout, stderr});
        });

        child.on("error", err => {
            clearTimeout(timer);
            console.error("Failed to start nsjail process:", err);
            reject(err);
        });
    });
}

app.listen(8080, () => console.log("Node runner listening on 8080"));

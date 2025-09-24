import express from "express";
import {promises as fs} from "fs";
import {spawn} from "child_process";
import {tmpdir} from "os";
import {join} from "path";
import {v4 as uuidv4} from "uuid";

const app = express();
app.use(express.json({limit: "100kb"}));

const NSJAIL_BIN = "/usr/bin/nsjail";
const NODE_BIN = "/usr/local/bin/node";
const JOB_TIMEOUT_MS = 5000;
const JOB_MEMORY_LIMIT_MB = 256;

app.get("/health", (req, res) => res.status(200).json({status: "ok"}));

app.post("/kratos.runtime.nodejs/22-latest/script/run", async (req, res) => {
    const {script, 'function': functionName, input} = req.body.data;
    const verbose = !!req.body.data.verbose;

    console.log("Received job request:");
    console.log("Function:", functionName);
    console.log("Input:", input);
    console.log("Script:\n", script);
    console.log("Verbose:\n", verbose);

    if (!script) {
        console.error("No script provided in request");
        return res.status(400).json({error: "script is required"});
    }

    const jobId = uuidv4();
    const workDir = join(tmpdir(), `job-${jobId}`);
    const chrootDir = join(tmpdir(), `nsjail-chroot-${jobId}`);
    console.log("Creating temporary work directory:", workDir);
    console.log("Creating temporary NSJail chroot:", chrootDir);

    try {
        await fs.mkdir(workDir, {mode: 0o700, recursive: true});
        await fs.mkdir(chrootDir, {mode: 0o755, recursive: true});

        const scriptFile = join(workDir, "script.js");
        const runnerFile = join(workDir, "runner.js");

        console.log("Writing user script to:", scriptFile);
        await fs.writeFile(scriptFile, script, {mode: 0o600});

        let runnerContent;
        if (functionName) {
            runnerContent = `
import('/work/script.js').then(mod => {
  if (${verbose}) console.log("Module loaded successfully");
  const fn = mod['${functionName}'] || global['${functionName}'];
  if (typeof fn !== 'function') {
    console.error('Function not found:', '${functionName}');
    process.exit(1);
  }
  if (${verbose}) console.log('Running function:', '${functionName}', 'with input:', ${JSON.stringify(input ?? {})});
  const result = fn(${JSON.stringify(input ?? {})});
  if (${verbose}) console.log("Function result:", JSON.stringify(result));
  process.stdout.write(JSON.stringify(result));
}).catch(e => { console.error('Error loading module:', e); process.exit(1); });
`;
        } else {
            runnerContent = `
if (${verbose}) console.log("Running full script: /work/script.js");
import('/work/script.js').catch(e => { console.error('Error running script:', e); process.exit(1); });
`;
        }

        console.log("Writing runner wrapper to:", runnerFile);
        await fs.writeFile(runnerFile, runnerContent, {mode: 0o600});
        console.log("Runner wrapper content:\n", runnerContent);

        console.log("Starting nsjail execution");
        const result = await runWithNsJail({workDir, runnerFile, chrootDir});
        console.log("Execution finished with result:", result);
        res.status(200).json({
            data: result
        });
    } catch (err) {
        console.error("Job failed with error:", err);
        res.status(500).json({
            data: {
                error: err.message
            }
        });
    } finally {
        console.log("Cleaning up work directory:", workDir);
        fs.rm(workDir, {recursive: true, force: true}).catch(() => {
            console.warn("Failed to clean temporary directory:", workDir);
        });
        fs.rm(chrootDir, {recursive: true, force: true}).catch(() => {
            console.warn("Failed to clean chroot directory:", chrootDir);
        });
    }
});

function runWithNsJail({workDir, runnerFile, chrootDir}) {
    return new Promise((resolve, reject) => {
        const args = [
            "--chroot", chrootDir,
            "--cwd", "/work",
            "--user", "65534", "--group", "65534",
            "--disable_proc",
            "--time_limit", String(Math.ceil(JOB_TIMEOUT_MS / 1000)),
            "--rlimit_as", String(JOB_MEMORY_LIMIT_MB * 1024 * 1024),
            "--rlimit_fsize", String(1024 * 1024),
            "--bindmount", `${workDir}:/work`,           // job scripts
            "--bindmount", "/usr/lib:/usr/lib",         // libs required by node
            "--bindmount", "/lib:/lib",
            "--bindmount", "/lib64:/lib64",
            "--bindmount", "/usr/bin:/usr/bin",
            "--bindmount", "/usr/local/bin:/usr/local/bin",
            "--",
            NODE_BIN, "/work/runner.js"
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
            resolve({exitCode: code, stdout, stderr});
        });

        child.on("error", err => {
            clearTimeout(timer);
            console.error("Failed to start nsjail process:", err);
            reject(err);
        });
    });
}

app.listen(8080, () => console.log("Node runner listening on 8080"));

// Bundled by esbuild from src/; do not edit.

// src/main.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readdirSync, statSync } from "node:fs";
import { join as join2, relative as relative2, sep } from "node:path";

// ../bitinz-js/dist/client.js
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ../bitinz-js/dist/version.js
var VERSION = "1.0.0";

// ../bitinz-js/dist/client.js
var BitinzError = class extends Error {
  status;
  code;
  retryAfter;
  constructor(status, code, message, retryAfter) {
    super(message);
    this.name = "BitinzError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
  /** Errors that end a batch: every following request would fail the same way. */
  get fatal() {
    return ["unauthorized", "invalid_key", "email_not_verified", "quota_exceeded"].includes(this.code);
  }
};
var DEFAULT_BASE_URL = "https://bitinz.com";
var FAILURE_CODES = {
  unsupported: "unsupported_image",
  invalid: "invalid_image",
  too_large: "image_too_large",
  abandoned: "busy"
};
function sniffFormat(head) {
  const ascii = (from, to) => String.fromCharCode(...head.subarray(from, to));
  if (head.length >= 8 && head[0] === 137 && ascii(1, 4) === "PNG")
    return "png";
  if (head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255)
    return "jpeg";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "webp";
  if (head.length >= 12 && ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12)))
    return "avif";
  return void 0;
}
function parseRetryAfter(value) {
  if (!value)
    return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? void 0 : Math.max(0, (date - Date.now()) / 1e3);
}
async function errorFrom(response) {
  let code = response.status >= 500 ? "internal" : "bad_request", message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body.error?.code)
      code = body.error.code;
    if (body.error?.message)
      message = body.error.message;
  } catch {
  }
  return new BitinzError(response.status, code, message, parseRetryAfter(response.headers.get("retry-after")));
}
var Bitinz = class {
  baseUrl;
  #apiKey;
  #retries;
  #pollTimeout;
  #fetch;
  constructor(options) {
    if (!options?.apiKey)
      throw new BitinzError(0, "unauthorized", "An API key is required");
    this.#apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#retries = options.retries ?? 3;
    this.#pollTimeout = options.pollTimeout ?? 10 * 6e4;
    this.#fetch = options.fetch ?? fetch;
  }
  /** Compresses one image: a file path, bytes or a Blob. */
  async compress(input2, options = {}) {
    const body = typeof input2 === "string" ? await openAsBlob(input2) : input2 instanceof Blob ? input2 : new Blob([input2]);
    const filename = options.filename ?? (typeof input2 === "string" ? basename(input2) : void 0);
    let format = options.format ?? "same", keptFormat = false;
    if (format === "webp" && sniffFormat(new Uint8Array(await body.slice(0, 16).arrayBuffer())) === "avif") {
      format = "same";
      keptFormat = true;
    }
    const url = new URL("/api/v1/shrink", this.baseUrl);
    if (options.level)
      url.searchParams.set("level", options.level);
    if (format !== "same")
      url.searchParams.set("format", format);
    if (filename)
      url.searchParams.set("filename", filename);
    const response = await this.#submit(url, body, options.signal);
    const count = Number(response.headers.get("compression-count"));
    const compressionCount = Number.isInteger(count) && response.headers.has("compression-count") ? count : void 0;
    const view = await response.json();
    if (response.status === 201 && view.output) {
      const location = response.headers.get("location") ?? view.output.url;
      return {
        id: view.id,
        filename: view.filename,
        data: await this.#download(location, options.signal),
        inputSize: view.input.size,
        outputSize: view.output.size,
        ratio: view.output.ratio,
        format: view.output.format ?? view.output.type?.replace("image/", ""),
        unchanged: !!view.unchanged,
        notes: view.output.notes ?? [],
        keptFormat,
        compressionCount,
        expiresAt: view.expiresAt
      };
    }
    const done = await this.#follow(view.id, options.signal);
    return {
      id: done.id,
      filename: done.filename,
      data: await this.#download(done.downloadUrl, options.signal),
      inputSize: done.inputSize,
      outputSize: done.outputSize,
      ratio: done.ratio,
      format: done.format,
      unchanged: done.unchanged,
      notes: done.notes ?? [],
      keptFormat,
      compressionCount,
      expiresAt: done.expiresAt
    };
  }
  // Results and downloads need no key; it goes with uploads only.
  #agent = { "user-agent": `bitinz-js/${VERSION} node/${process.versions.node}` };
  async #request(url, init) {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (error.name === "AbortError")
        throw error;
      throw new BitinzError(0, "network", `Could not reach ${this.baseUrl}: ${error.message}`);
    }
  }
  async #submit(url, body, signal) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#request(url, {
        method: "POST",
        body,
        signal,
        headers: { ...this.#agent, authorization: `Bearer ${this.#apiKey}`, "content-type": "application/octet-stream" }
      });
      if (response.status === 201 || response.status === 202)
        return response;
      const error = await errorFrom(response);
      if (error.code !== "busy" || attempt >= this.#retries)
        throw error;
      await sleep(Math.min(error.retryAfter ?? 30, 60) * 1e3, void 0, { signal });
    }
  }
  async #follow(id, signal) {
    const started = Date.now();
    const url = new URL(`/api/v1/results/${encodeURIComponent(id)}`, this.baseUrl);
    for (let polls = 0; ; polls++) {
      await sleep(polls < 10 ? 1e3 : 2e3, void 0, { signal });
      const response = await this.#request(url, { headers: this.#agent, signal }).catch((error) => {
        if (error instanceof BitinzError)
          return void 0;
        throw error;
      });
      if (response?.ok) {
        const view = await response.json();
        if (view.status === "done" && view.downloadUrl)
          return view;
        if (view.status === "done")
          throw new BitinzError(410, "expired", "The result is no longer available");
        if (view.status === "failed") {
          throw new BitinzError(422, FAILURE_CODES[view.failure ?? ""] ?? "internal", view.note ?? "The image could not be compressed");
        }
      } else if (response && response.status < 500 && response.status !== 429) {
        throw await errorFrom(response);
      } else if (response) {
        const { retryAfter } = await errorFrom(response);
        if (retryAfter)
          await sleep(Math.min(retryAfter, 60) * 1e3, void 0, { signal });
      }
      if (Date.now() - started > this.#pollTimeout) {
        throw new BitinzError(504, "timeout", `The image is still queued after ${Math.round(this.#pollTimeout / 6e4)} minutes`);
      }
    }
  }
  async #download(location, signal) {
    const response = await this.#request(new URL(location, this.baseUrl), { headers: this.#agent, signal });
    if (!response.ok)
      throw await errorFrom(response);
    return new Uint8Array(await response.arrayBuffer());
  }
};

// ../bitinz-js/dist/batch.js
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";

// ../bitinz-js/dist/files.js
import { basename as basename2, dirname, extname, join, relative, resolve } from "node:path";
var CONVERTIBLE = [".png", ".jpg", ".jpeg"];
var OUTPUT_DIR = "bitinz-compressed";
function planOutputs(files, { outDir = OUTPUT_DIR, inPlace = false, webp = false } = {}) {
  const target = (file, stem) => {
    const name = stem(basename2(file.path));
    return inPlace ? join(dirname(file.path), name) : join(resolve(outDir), relative(file.root, dirname(file.path)), name);
  };
  const plain = (name) => webp && CONVERTIBLE.includes(extname(name).toLowerCase()) ? name.slice(0, -extname(name).length) + ".webp" : name;
  const first = files.map((file) => target(file, plain));
  const counts = /* @__PURE__ */ new Map();
  for (const path of first)
    counts.set(path, (counts.get(path) ?? 0) + 1);
  return new Map(files.map((file, i) => [file.path, counts.get(first[i]) > 1 ? target(file, (name) => `${name}.webp`) : first[i]]));
}

// ../bitinz-js/dist/batch.js
async function writeAtomic(path, data) {
  await mkdir(dirname2(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
async function compressFiles(client, files, options = {}) {
  const outputs = planOutputs(files, options);
  const reports = new Array(files.length);
  const report = { files: reports, inputBytes: 0, outputBytes: 0 };
  const concurrency = Math.min(8, Math.max(1, Math.floor(options.concurrency ?? 3)));
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let next = 0;
  const one = async (index) => {
    const file = files[index], output = outputs.get(file.path);
    const inputSize = (await stat(file.path)).size;
    const done = (entry) => {
      reports[index] = entry;
      options.onFile?.(entry);
    };
    if (report.stopped)
      return done({ path: file.path, output, status: "skipped", inputSize, error: report.stopped });
    if (options.dryRun || !client)
      return done({ path: file.path, output, status: "planned", inputSize });
    try {
      const result = await client.compress(file.path, { level: options.level, format: options.webp ? "webp" : "same", signal });
      if (result.compressionCount !== void 0)
        report.compressionCount = Math.max(report.compressionCount ?? 0, result.compressionCount);
      const larger = result.outputSize >= result.inputSize && !result.unchanged;
      const slight = !larger && !result.unchanged && !options.webp && (1 - result.outputSize / result.inputSize) * 100 < (options.minSavings ?? 0);
      const entry = {
        path: file.path,
        output,
        inputSize: result.inputSize,
        outputSize: slight ? result.inputSize : result.outputSize,
        notes: slight ? [...result.notes, { code: "below_min_savings", args: { saved: result.inputSize - result.outputSize } }] : result.notes,
        keptFormat: result.keptFormat,
        status: result.unchanged || slight ? "unchanged" : larger ? "larger" : "compressed"
      };
      const skipWrite = entry.status === "unchanged" && output === file.path || entry.status === "larger" && !options.keepLarger;
      if (skipWrite)
        entry.output = output === file.path ? file.path : void 0;
      else if (slight)
        await mkdir(dirname2(output), { recursive: true }).then(() => copyFile(file.path, output));
      else
        await writeAtomic(output, result.data);
      report.inputBytes += entry.inputSize;
      report.outputBytes += entry.status === "larger" && !options.keepLarger ? entry.inputSize : entry.outputSize;
      done(entry);
    } catch (error) {
      if (error.name === "AbortError" && report.stopped)
        return done({ path: file.path, output, status: "skipped", inputSize, error: report.stopped });
      if (error.name === "AbortError")
        throw error;
      const { code, message } = error instanceof BitinzError ? error : { code: "write_failed", message: error.message };
      if (error instanceof BitinzError && error.fatal && !report.stopped) {
        report.stopped = { code, message };
        stop.abort();
      }
      done({ path: file.path, output, status: "failed", inputSize, error: { code, message } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length)
      await one(next++);
  }));
  return report;
}

// ../bitinz-js/dist/format.js
function formatBytes(bytes) {
  if (bytes < 1024)
    return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
function savedPercent(input2, output) {
  return input2 ? Math.round((1 - output / input2) * 100) : 0;
}

// src/github.ts
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
function input(name, fallback = "") {
  return (process.env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "").trim() || fallback;
}
function booleanInput(name, fallback) {
  const value = input(name).toLowerCase();
  if (!value) return fallback;
  if (["true", "yes", "1"].includes(value)) return true;
  if (["false", "no", "0"].includes(value)) return false;
  throw new Error(`Input "${name}" must be true or false, not "${value}"`);
}
function listInput(name, fallback = []) {
  const values = input(name).split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
  return values.length ? values : fallback;
}
var escape = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
var log = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`::notice::${escape(message)}`),
  warning: (message, file) => console.log(`::warning${file ? ` file=${file}` : ""}::${escape(message)}`),
  error: (message) => console.log(`::error::${escape(message)}`),
  mask: (secret) => console.log(`::add-mask::${secret}`)
};
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `bitinz_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown + "\n");
}
function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : void 0;
}
async function api(path, token) {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(base + path, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bitinz-compress-action" }
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}
async function pullRequestFiles(repo, number, token) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
    files.push(...batch.filter((file) => file.status !== "removed").map((file) => file.filename));
    if (batch.length < 100) return files;
  }
}
async function pushedFiles(repo, before, after, token) {
  const { files = [] } = await api(`/repos/${repo}/compare/${before}...${after}`, token);
  return files.length >= 300 ? void 0 : files.filter((file) => file.status !== "removed").map((file) => file.filename);
}

// src/glob.ts
function globToRegExp(pattern) {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!/[*?{]/.test(clean)) return new RegExp(`^${escape2(clean)}(?:/.*)?$`);
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === "*" && clean[i + 1] === "*") {
      if (clean[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = clean.indexOf("}", i);
      if (end < 0) {
        source += "\\{";
        continue;
      }
      source += `(?:${clean.slice(i + 1, end).split(",").map(escape2).join("|")})`;
      i = end;
    } else source += escape2(char);
  }
  return new RegExp(`^${source}$`);
}
function escape2(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
function matcher(patterns) {
  const expressions = patterns.map(globToRegExp);
  return (path) => expressions.some((expression) => expression.test(path));
}

// src/main.ts
var DEFAULT_PATHS = ["**/*.{png,jpg,jpeg,webp}"];
var IMAGE = /\.(png|jpe?g|webp|avif)$/i;
var SKIPPED = /* @__PURE__ */ new Set([".git", "node_modules"]);
var ZERO_SHA = /^0+$/;
var posix = (path) => path.split(sep).join("/");
function allImages(root, dir = root, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join2(dir, entry.name);
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) allImages(root, path, found);
    else if (entry.isFile() && IMAGE.test(entry.name)) found.push(posix(relative2(root, path)));
  }
  return found;
}
async function candidates(workspace, changedOnly, token) {
  const name = process.env.GITHUB_EVENT_NAME ?? "";
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  if (changedOnly && token && name.startsWith("pull_request")) {
    const event = readEvent();
    if (event?.pull_request) return { files: await pullRequestFiles(repo, event.pull_request.number, token), scope: `changed in pull request #${event.pull_request.number}` };
  }
  if (changedOnly && token && name === "push") {
    const event = readEvent();
    if (event && !ZERO_SHA.test(event.before)) {
      const files = await pushedFiles(repo, event.before, event.after, token);
      if (files) return { files, scope: "changed in this push" };
      log.notice("The push changes too many files to list; checking every image instead.");
    }
  }
  return { files: allImages(workspace), scope: "in the repository" };
}
function table(report, workspace) {
  const written = report.files.filter((file) => file.status === "compressed");
  const saved = report.inputBytes - report.outputBytes;
  const lines = [
    "### Bitinz image compression",
    "",
    written.length ? `Compressed **${written.length}** of ${report.files.length} image${report.files.length === 1 ? "" : "s"}, saving **${formatBytes(saved)}** (${savedPercent(report.inputBytes, report.outputBytes)}%).` : `None of the ${report.files.length} image${report.files.length === 1 ? "" : "s"} could be made meaningfully smaller.`
  ];
  if (written.length) {
    lines.push("", "| Image | Before | After | Saved |", "|---|---:|---:|---:|");
    for (const file of written.slice(0, 100)) {
      lines.push(`| \`${posix(relative2(workspace, file.path))}\` | ${formatBytes(file.inputSize)} | ${formatBytes(file.outputSize)} | ${savedPercent(file.inputSize, file.outputSize)}% |`);
    }
    if (written.length > 100) lines.push(`| \u2026 and ${written.length - 100} more | | | |`);
  }
  const unchanged = report.files.filter((file) => file.status === "unchanged").length;
  const failed = report.files.filter((file) => file.status === "failed" || file.status === "skipped");
  if (unchanged) lines.push("", `${unchanged} already optimized or below the minimum saving; left as they were.`);
  if (failed.length) lines.push("", `${failed.length} not compressed: ${failed.slice(0, 10).map((f) => `\`${posix(relative2(workspace, f.path))}\` (${f.error?.message})`).join(", ")}`);
  if (report.compressionCount !== void 0) lines.push("", `<sub>API compressions used this month: ${report.compressionCount}</sub>`);
  return lines.join("\n");
}
function git(workspace, ...args) {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
}
function commit(workspace, files, message) {
  const name = process.env.GITHUB_EVENT_NAME ?? "";
  let branch;
  if (name.startsWith("pull_request")) {
    const event = readEvent();
    if (event.pull_request.head.repo?.full_name !== event.repository.full_name) {
      log.warning("This pull request comes from a fork, so the action cannot push to it. The compressed images were not committed.");
      return;
    }
    if (git(workspace, "rev-parse", "HEAD") !== event.pull_request.head.sha) {
      throw new Error('To commit to a pull request, check out its branch: actions/checkout with "ref: ${{ github.head_ref }}".');
    }
    branch = event.pull_request.head.ref;
  } else if (process.env.GITHUB_REF?.startsWith("refs/heads/")) {
    branch = process.env.GITHUB_REF.slice("refs/heads/".length);
  }
  if (!branch) {
    log.warning("Not on a branch, so the compressed images were not committed.");
    return;
  }
  git(workspace, "add", "--", ...files.map((file) => relative2(workspace, file.path)));
  git(workspace, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "--quiet", "-m", message);
  git(workspace, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  log.info(`Committed ${files.length} compressed image${files.length === 1 ? "" : "s"} to ${branch}.`);
}
async function run() {
  const apiKey = input("api-key");
  if (!apiKey) throw new Error("The api-key input is required. Add your Bitinz API key as a repository secret and pass it: api-key: ${{ secrets.BITINZ_API_KEY }}");
  log.mask(apiKey);
  const level = input("level");
  if (level && !["fast", "default", "best"].includes(level)) throw new Error("level must be fast, default or best");
  const minSavings = Number(input("min-savings", "2"));
  if (!Number.isFinite(minSavings) || minSavings < 0 || minSavings >= 100) throw new Error("min-savings must be a percentage from 0 to 99");
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const wanted = matcher(listInput("paths", DEFAULT_PATHS)), ignored = matcher(listInput("ignore"));
  const { files: listed, scope } = await candidates(workspace, booleanInput("changed-only", true), input("github-token"));
  const files = listed.filter((path) => IMAGE.test(path) && wanted(path) && !ignored(path) && existsSync2(join2(workspace, path)) && statSync(join2(workspace, path)).isFile());
  log.info(`${files.length} image${files.length === 1 ? "" : "s"} to compress (${scope}).`);
  if (!files.length) {
    setOutput("files", 0);
    setOutput("bytes-saved", 0);
    setOutput("markdown", "");
    appendSummary(`### Bitinz image compression

No images to compress (${scope}).`);
    return;
  }
  const client = new Bitinz({ apiKey, baseUrl: process.env.BITINZ_BASE_URL || void 0 });
  const report = await compressFiles(client, files.map((path) => ({ path: join2(workspace, path), root: workspace })), {
    inPlace: true,
    level: level || void 0,
    minSavings,
    onFile: (file) => {
      const path = posix(relative2(workspace, file.path));
      if (file.status === "compressed") log.info(`\u2713 ${path}  ${formatBytes(file.inputSize)} \u2192 ${formatBytes(file.outputSize)}  \u2212${savedPercent(file.inputSize, file.outputSize)}%`);
      else if (file.status === "unchanged") log.info(`= ${path}  unchanged`);
      else if (file.status === "failed") log.warning(file.error?.message ?? "could not be compressed", path);
    }
  });
  const written = report.files.filter((file) => file.status === "compressed");
  const markdown = table(report, workspace);
  setOutput("files", written.length);
  setOutput("bytes-saved", report.inputBytes - report.outputBytes);
  setOutput("markdown", markdown);
  appendSummary(markdown);
  if (report.stopped) throw new Error(`Stopped: ${report.stopped.message}`);
  if (written.length && booleanInput("commit", false)) commit(workspace, written, input("commit-message", "Compress images with Bitinz"));
}
run().catch((error) => {
  log.error(error.message);
  process.exitCode = 1;
});

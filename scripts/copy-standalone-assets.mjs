import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const buildDirectory = path.join(projectRoot, ".next");
const standaloneDirectory = path.join(buildDirectory, "standalone");

async function copyIfPresent(source, destination) {
  try {
    await access(source);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

await access(path.join(standaloneDirectory, "server.js"));
await copyIfPresent(path.join(buildDirectory, "static"), path.join(standaloneDirectory, ".next", "static"));
await copyIfPresent(path.join(projectRoot, "public"), path.join(standaloneDirectory, "public"));
console.log("Copied Next.js static assets into the standalone runtime.");

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (command !== "dev" && command !== "build") {
    throw new Error("使用 bun run desktop:dev 或 bun run desktop:build");
}
const version = (await readFile(resolve(webDirectory, "../VERSION"), "utf8")).trim().replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("VERSION 不是有效的桌面应用版本号");
}
const configPath = resolve(webDirectory, "src-tauri/tauri.conf.json");
const configText = await readFile(configPath, "utf8");
const config = JSON.parse(configText);
if (config.version !== version) {
    config.version = version;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
const cargoPath = resolve(webDirectory, "src-tauri/Cargo.toml");
const cargoText = await readFile(cargoPath, "utf8");
const updatedCargo = cargoText.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
if (updatedCargo !== cargoText) await writeFile(cargoPath, updatedCargo);

const args = ["x", "tauri", command, ...process.argv.slice(3)];
if (command === "build" && !args.includes("--target")) args.push("--target", "x86_64-pc-windows-msvc");
const child = spawn(process.execPath, args, { cwd: webDirectory, stdio: "inherit", env: process.env });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });

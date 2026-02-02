import { rm, exists } from "node:fs/promises";
import path from "node:path";

// --- USER CONFIGURATION ---
const ENTRY_POINT = "./src/index.ts"; // Change this to your main file
const OUTPUT_DIR = "./dist";
const APP_NAME = "webview-app";        // The base name of your executable
// --------------------------

// Using type from Bun.Build.Target
const TARGETS = {
  // Linux targets
  "linux-x64": {
    target: "bun-linux-x64",
    suffix: "linux-x64",
    icon: undefined,
  },
  "linux-x64-baseline": {
    target: "bun-linux-x64-baseline-musl",
    suffix: "linux-x64-baseline",
    icon: undefined,
  },
  "linux-x64-modern": {
    target: "bun-linux-x64-modern-musl",
    suffix: "linux-x64-modern",
    icon: undefined,
  },
  "linux-arm64": {
    target: "bun-linux-arm64",
    suffix: "linux-arm64",
    icon: undefined,
  },
  "linux-x64-musl": {
    target: "bun-linux-x64-musl",
    suffix: "linux-x64-musl",
    icon: undefined,
  },
  "linux-arm64-musl": {
    target: "bun-linux-arm64-musl",
    suffix: "linux-arm64-musl",
    icon: undefined,
  },
  // Windows targets
  "windows-x64": {
    target: "bun-windows-x64",
    suffix: "windows-x64.exe",
    icon: undefined,
  },
  "windows-x64-baseline": {
    target: "bun-windows-x64-baseline",
    suffix: "windows-x64-baseline.exe",
    icon: undefined,
  },
  "windows-x64-modern": {
    target: "bun-windows-x64-modern",
    suffix: "windows-x64-modern.exe",
    icon: undefined,
  },
  // macOS targets
  "darwin-x64": {
    target: "bun-darwin-x64",
    suffix: "darwin-x64",
    icon: undefined,
  },
  "darwin-x64-baseline": {
    target: "bun-darwin-x64-baseline",
    suffix: "darwin-x64-baseline",
    icon: undefined,
  },
  "darwin-arm64": {
    target: "bun-darwin-arm64",
    suffix: "darwin-arm64",
    icon: undefined,
  },
} as const;

type TargetKey = keyof typeof TARGETS;

/**
 * Get the current platform and architecture
 */
function getCurrentPlatform(): { os: string; arch: string } {
  const platform = process.platform;
  const arch = process.arch;

  const osMap: Record<string, string> = {
    linux: "linux",
    win32: "windows",
    darwin: "darwin",
  };

  return {
    os: osMap[platform] || platform,
    arch: arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch,
  };
}

// --- BUILD LOGIC ---

async function buildBinary(key: TargetKey) {
  const config = TARGETS[key];
  const outputFileName = `${APP_NAME}-${config.suffix}`;
  
  console.log(`Building ${key} -> ${outputFileName}...`);

  try {
    const result = await Bun.build({
      entrypoints: [ENTRY_POINT],
      outdir: OUTPUT_DIR,
      target: "bun", 
      minify: true,
      bytecode: true,
      compile: {
        target: config.target, 
        outfile: outputFileName,
      },
      naming: outputFileName, // Custom naming schema
    });

    if (!result.success) {
      console.error(`${key}:`);
      console.error(result.logs);
      return false;
    }

    console.log(`Success: ${path.join(OUTPUT_DIR, outputFileName)}`);
    return true;
  } catch (error) {
    console.error(`${key}:`, error);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const buildAll = args.includes("--all");

  // 1. Clean output directory
  if (await exists(OUTPUT_DIR)) {
    console.log("Cleaning output directory...");
    await rm(OUTPUT_DIR, { recursive: true, force: true });
  }

  const start = performance.now();
  let keysToBuild: TargetKey[] = [];

  // 2. Determine which targets to build
  if (buildAll) {
    // Build everything
    keysToBuild = Object.keys(TARGETS) as TargetKey[];
  } else {
    // Default: Build only for the current OS/Arch
    const { os, arch } = getCurrentPlatform();
    console.log(`Detected platform: ${os}-${arch}`);
    
    // Attempt to match current platform to our list
    const defaultKey = `${os}-${arch}` as TargetKey;
    
    if (TARGETS[defaultKey]) {
      keysToBuild.push(defaultKey);
    } else {
      console.warn(`No exact match found for ${defaultKey}. Building all targets instead.`);
      keysToBuild = Object.keys(TARGETS) as TargetKey[];
    }
  }

  console.log(`Starting build for ${keysToBuild.length} targets...`);

  // 3. Run builds
  const results = await Promise.all(keysToBuild.map(buildBinary));
  
  const end = performance.now();
  const duration = ((end - start) / 1000).toFixed(2);
  const successCount = results.filter(Boolean).length;

  console.log(`Done in ${duration}s! (${successCount}/${keysToBuild.length} successful)`);
}

main();
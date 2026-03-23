#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function run(cmd, opts = {}) {
  const res = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.ignoreError) {
    process.exit(res.status ?? 1);
  }
  return res.status ?? 0;
}

function runCapture(cmd, opts = {}) {
  const res = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.ignoreError) {
    throw new Error((res.stderr || "").trim() || `Command failed: ${cmd}`);
  }
  return (res.stdout || "").trim();
}

function isJetsonPlatform() {
  try {
    const nvTegra = runCapture("test -f /etc/nv_tegra_release && echo yes", {
      ignoreError: true,
    });
    if (nvTegra && nvTegra.trim() === "yes") return true;
  } catch {}

  try {
    const compat = runCapture("tr '\\0' '\\n' < /proc/device-tree/compatible", {
      ignoreError: true,
    });
    if (compat && /nvidia,tegra|nvidia,thor/i.test(compat)) return true;
  } catch {}

  try {
    const model = runCapture("tr '\\0' '\\n' < /proc/device-tree/model", {
      ignoreError: true,
    });
    if (model && /jetson|thor|nvidia/i.test(model)) return true;
  } catch {}

  return false;
}

export function detectGpu() {
  function getSystemMemoryMB() {
    try {
      const memLine = runCapture("awk '/MemTotal:/ {print $2}' /proc/meminfo", {
        ignoreError: true,
      });
      if (memLine) {
        const memKB = parseInt(memLine.trim(), 10);
        if (!isNaN(memKB) && memKB > 0) return Math.floor(memKB / 1024);
      }
    } catch {}
    return 0;
  }

  // 1) Standard NVIDIA path — query VRAM with nvidia-smi
  try {
    const output = runCapture(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (output) {
      const lines = output.split("\n").filter((l) => l.trim());
      const perGpuMB = lines
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);

      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a, b) => a + b, 0);
        return {
          type: "nvidia",
          count: perGpuMB.length,
          totalMemoryMB,
          perGpuMB: perGpuMB[0],
          nimCapable: true,
        };
      }
    }
  } catch {}

  // 2) Jetson / Thor fallback
  try {
    if (process.platform === "linux" && isJetsonPlatform()) {
      let gpuCount = 1;

      try {
        const listOutput = runCapture("nvidia-smi -L", { ignoreError: true });
        if (listOutput) {
          const lines = listOutput.split("\n").filter((l) => l.trim());
          if (lines.length > 0) gpuCount = lines.length;
        }
      } catch {}

      const totalMemoryMB = Math.floor(getSystemMemoryMB() / 2);

      if (totalMemoryMB > 0) {
        return {
          type: "nvidia",
          name: "NVIDIA Jetson",
          count: gpuCount,
          totalMemoryMB,
          perGpuMB: Math.floor(totalMemoryMB / gpuCount),
          nimCapable: true,
          jetson: true,
          unifiedMemory: true,
        };
      }

      return {
        type: "nvidia",
        name: "NVIDIA Jetson",
        count: gpuCount,
        totalMemoryMB: 0,
        perGpuMB: 0,
        nimCapable: false,
        jetson: true,
        unifiedMemory: true,
      };
    }
  } catch {}

  // 3) Fallback: DGX Spark (GB10)
  try {
    const nameOutput = runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (nameOutput && nameOutput.includes("GB10")) {
      const totalMemoryMB = getSystemMemoryMB();
      return {
        type: "nvidia",
        count: 1,
        totalMemoryMB,
        perGpuMB: totalMemoryMB,
        nimCapable: true,
        spark: true,
        unifiedMemory: true,
      };
    }
  } catch {}

  // 4) macOS: detect Apple Silicon or discrete GPU
  if (process.platform === "darwin") {
    try {
      const spOutput = runCapture("system_profiler SPDisplaysDataType", {
        ignoreError: true,
      });
      if (spOutput) {
        const chipMatch = spOutput.match(/Chipset Model:\s*(.+)/);
        const vramMatch = spOutput.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        const coresMatch = spOutput.match(/Total Number of Cores:\s*(\d+)/);

        if (chipMatch) {
          const name = chipMatch[1].trim();
          let memoryMB = 0;

          if (vramMatch) {
            memoryMB = parseInt(vramMatch[1], 10);
            if (vramMatch[2].toUpperCase() === "GB") memoryMB *= 1024;
          } else {
            try {
              const memBytes = runCapture("sysctl -n hw.memsize", {
                ignoreError: true,
              });
              if (memBytes) {
                memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
              }
            } catch {}
          }

          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            perGpuMB: memoryMB,
            nimCapable: false,
          };
        }
      }
    } catch {}
  }

  return null;
}

function containerName(sandboxName) {
  return `nim-${sandboxName}`;
}

function getImageForModel(model) {
  const map = {
    llama: "nvcr.io/nim/meta/llama-3.1-8b-instruct:latest",
    mistral: "nvcr.io/nim/mistralai/mistral-7b-instruct-v0.3:latest",
  };
  return map[model] || null;
}

export function startNimContainer(sandboxName, model, port = 8000) {
  const name = containerName(sandboxName);
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  const qn = shellQuote(name);

  // Stop any existing container with same name
  run(`docker rm -f ${qn} || true`, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);

  const runtimeArgs = isJetsonPlatform() ? "--runtime nvidia " : "";
  run(
    `docker run -d --gpus all ${runtimeArgs}-p ${Number(port)}:8000 --name ${qn} --shm-size 16g ${shellQuote(image)}`
  );

  return name;
}

function usage() {
  console.log(`Usage:
  nim.js detect-gpu
  nim.js start <sandboxName> <model> [port]`);
}

function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "detect-gpu": {
      const gpu = detectGpu();
      console.log(JSON.stringify(gpu, null, 2));
      break;
    }

    case "start": {
      const [sandboxName, model, port] = args;
      if (!sandboxName || !model) {
        usage();
        process.exit(1);
      }
      startNimContainer(sandboxName, model, port ? Number(port) : 8000);
      break;
    }

    default:
      usage();
      process.exit(1);
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main();
}

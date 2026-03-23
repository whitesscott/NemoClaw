// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const { run, runCapture, shellQuote } = require("./runner");
const nimImages = require("./nim-images.json");

function containerName(sandboxName) {
  return `nemoclaw-nim-${sandboxName}`;
}

function getImageForModel(modelName) {
  const entry = nimImages.models.find((m) => m.name === modelName);
  return entry ? entry.image : null;
}

function listModels() {
  return nimImages.models.map((m) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
  }));
}

function detectGpu() {
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
        nimCapable: true,
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

function pullNimImage(model) {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }
  console.log(`  Pulling NIM image: ${image}`);
  run(`docker pull ${shellQuote(image)}`);
  return image;
}

function startNimContainer(sandboxName, model, port = 8000) {
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

function waitForNimHealth(port = 8000, timeout = 300) {
  const start = Date.now();
  const interval = 5000;
  const safePort = Number(port);
  console.log(`  Waiting for NIM health on port ${safePort} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runCapture(`curl -sf http://localhost:${safePort}/v1/models`, {
        ignoreError: true,
      });
      if (result) {
        console.log("  NIM is healthy.");
        return true;
      }
    } catch {}
    // Synchronous sleep via spawnSync
    require("child_process").spawnSync("sleep", ["5"]);
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

function stopNimContainer(sandboxName) {
  const name = containerName(sandboxName);
  const qn = shellQuote(name);
  console.log(`  Stopping NIM container: ${name}`);
  run(`docker stop ${qn} 2>/dev/null || true`, { ignoreError: true });
  run(`docker rm ${qn} 2>/dev/null || true`, { ignoreError: true });
}

function nimStatus(sandboxName) {
  const name = containerName(sandboxName);
  try {
    const state = runCapture(
      `docker inspect --format '{{.State.Status}}' ${shellQuote(name)} 2>/dev/null`,
      { ignoreError: true }
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      const health = runCapture(`curl -sf http://localhost:8000/v1/models 2>/dev/null`, {
        ignoreError: true,
      });
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}

module.exports = {
  containerName,
  getImageForModel,
  listModels,
  detectGpu,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
};

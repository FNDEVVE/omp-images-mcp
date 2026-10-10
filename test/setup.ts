import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll } from "vitest";

// OMP eagerly reads home/profile .env files during imports. Redirect every
// default root before native Bun loads OMP, including its unavoidable temp writes.
const root = await mkdtemp("/dev/shm/omp-images-runtime-");

const temporaryDirectory = join(root, "tmp");

await mkdir(temporaryDirectory);

process.env.HOME = root;

process.env.TMPDIR = temporaryDirectory;

process.env.PI_CODING_AGENT_DIR = join(root, "agent");

process.env.OMP_PROFILE = "";

process.env.PI_PROFILE = "";

process.env.PI_CONFIG_DIR = ".omp";

process.env.OMP_CONFIG_DIR = ".omp";

process.env.PI_CONFIG_FILES = "";

process.env.OMP_CONFIG_FILES = "";

process.env.OPENAI_API_KEY = "";

process.env.XDG_DATA_HOME = join(root, "data");

process.env.XDG_STATE_HOME = join(root, "state");

process.env.XDG_CACHE_HOME = join(root, "cache");

// The setup file runs in the test worker, never in the service or listener.
afterAll(() => rm(root, { recursive: true, force: true }));

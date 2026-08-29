import { homedir } from "node:os";
import { join } from "node:path";

// Everything nithi writes lives under one root. NITHI_HOME relocates it, which
// keeps tests (and throwaway daemons) off the real cache.
export const CACHE = process.env.NITHI_HOME || join(homedir(), ".cache", "nithi");

export const STATE_FILE = join(CACHE, "state.json"); // cookies + Cloudflare clearance
export const SESS_DIR = join(CACHE, "sessions");
export const SOCK = join(CACHE, "daemon.sock");
export const DPID = join(CACHE, "daemon.pid");
export const DLOG = join(CACHE, "daemon.log");

// The cache holds conversation transcripts and a live Cloudflare clearance, so
// it is ours alone; the socket is a capability to ask questions as this user.
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

// Terminal theme. Colour is decided once from the environment but stays
// settable, because --raw is only known after arguments are parsed and the
// renderer is imported before that happens.

const ESC = "\x1b[";

let useColor =
  !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
let hyperlinks = useColor && !process.env.NO_HYPERLINKS && process.env.TERM !== "dumb";

const TRUECOLOR = process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";

/** Force plain output (used by --raw and --json). */
export function setPlain(plain: boolean): void {
  if (!plain) return;
  useColor = false;
  hyperlinks = false;
}

export const colorEnabled = () => useColor;

/** Terminal width, read live so a mid-session resize is picked up. */
export const cols = () => process.stdout.columns || 80;

const attr = (open: string, close: string) => (s: string) =>
  useColor ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const bold = attr("1", "22");
export const italic = attr("3", "23");
export const dim = attr("2", "22");
export const underline = attr("4", "24");

export function to256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const colorFn = (layer: 38 | 48, reset: 39 | 49) => (rgb: [number, number, number]) => {
  const [r, g, b] = rgb;
  return (s: string) => {
    if (!useColor) return s;
    const code = TRUECOLOR ? `${layer};2;${r};${g};${b}` : `${layer};5;${to256(r, g, b)}`;
    return `${ESC}${code}m${s}${ESC}${reset}m`;
  };
};
const fg = colorFn(38, 39);
const bg = colorFn(48, 49);

export const T = {
  h1: fg([245, 158, 66]),
  h2: fg([234, 179, 8]),
  accent: fg([245, 158, 66]),
  tag: fg([250, 204, 21]),
  muted: fg([130, 130, 145]),
  link: fg([96, 165, 250]),
  code: fg([236, 186, 120]),
  codeBg: bg([38, 38, 48]),
};

// SGR, then any OSC string (terminated by BEL or ST). The general OSC form
// matters because prompt marking (OSC 133) and hyperlinks (OSC 8) both live
// there, and a sequence left in the text would be counted as visible width and
// silently misalign every table it appeared in.
export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

/** Visible width, ignoring colour and hyperlink escapes. */
export const vlen = (s: string) => [...stripAnsi(s)].length;

export function osc8(url: string, text: string): string {
  if (!hyperlinks) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function renderLink(url: string, text: string): string {
  if (hyperlinks) return T.link(underline(osc8(url, text)));
  if (text === url) return T.link(underline(url));
  return T.link(underline(text)) + T.muted(" (" + url + ")");
}

/**
 * OSC 133;A, the "a prompt starts here" marker.
 *
 * Terminals that understand it (foot, ghostty, kitty, WezTerm, iTerm2, VS Code,
 * Windows Terminal) can then jump between prompts from the keyboard, which in a
 * REPL means jumping between turns. Terminals that do not simply ignore it.
 *
 * Deliberately not tied to the colour setting: this is navigation metadata, not
 * decoration, and NO_COLOR asks for plain text rather than a terminal stripped
 * of the things that make it navigable. It is gated on writing to a terminal at
 * all, so it never lands in a redirected file.
 */
export const PROMPT_MARK = "\x1b]133;A\x1b\\";
export const promptMark = () => (process.stdout.isTTY ? PROMPT_MARK : "");

export { ESC };

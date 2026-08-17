/**
 * What kind of file an attachment is, for display only.
 *
 * Attachments are stored as extracted text, so the transcript would otherwise
 * show every file as an identical grey chip. This drives the icon, the accent
 * colour and the badge label — nothing here decides what can be read (that is
 * byte-sniffed in `attachments.ts`); a wrong guess costs a wrong icon.
 */

/** Display families. `image` renders as a picture; the rest as a file card. */
export type FileKind =
  | "image"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "code"
  | "data"
  | "archive"
  | "audio"
  | "video"
  | "text";

const BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  heic: "image",
  svg: "image",
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  odt: "doc",
  pages: "doc",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ppt: "slides",
  pptx: "slides",
  key: "slides",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  py: "code",
  rs: "code",
  go: "code",
  java: "code",
  rb: "code",
  php: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  sh: "code",
  html: "code",
  css: "code",
  sql: "code",
  json: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  xml: "data",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  rar: "archive",
  "7z": "archive",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  mp4: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
};

/**
 * Classify by extension, falling back to plain text.
 *
 * The saved name of an extracted file ends in `.txt` (`report.pdf.txt`), so the
 * *second* extension is checked too — otherwise every PDF and photo in the
 * transcript would show as a text file.
 */
export function fileKind(name: string): FileKind {
  const parts = name.toLowerCase().split(".");
  // `report.pdf.txt` → try "txt" (unknown, so it falls through), then "pdf".
  // A real `.txt` matches neither and lands on the "text" default below.
  for (const extension of [parts.at(-1), parts.at(-2)]) {
    const kind = extension === undefined ? undefined : BY_EXTENSION[extension];
    if (kind !== undefined) {
      return kind;
    }
  }
  return "text";
}

/** Short label for the icon badge, e.g. the "PDF" on a red tile. */
export function fileBadge(name: string): string {
  const parts = name.toLowerCase().split(".");
  // No dot at all (a `Makefile`, a `LICENSE`): the whole name is not an
  // extension, and printing it across a 38px tile would be a smear.
  if (parts.length < 2) {
    return "FILE";
  }
  // Prefer the real extension over the family name — "XLSX" beats "SHEET" — and
  // skip the `.txt` we appended, which is never what the user attached.
  const extension = parts.at(-1) === "txt" && parts.length > 2 ? parts.at(-2) : parts.at(-1);
  return (extension === undefined || extension === "" ? "FILE" : extension)
    .slice(0, 4)
    .toUpperCase();
}

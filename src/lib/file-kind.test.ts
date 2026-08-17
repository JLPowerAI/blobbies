import { describe, expect, it } from "vitest";
import { fileBadge, fileKind } from "@/lib/file-kind";

describe("fileKind", () => {
  it("classifies by extension", () => {
    expect(fileKind("photo.png")).toBe("image");
    expect(fileKind("report.pdf")).toBe("pdf");
    expect(fileKind("books.xlsx")).toBe("sheet");
    expect(fileKind("main.rs")).toBe("code");
  });

  it("looks past the .txt we append to an extracted file", () => {
    // Saved names are `report.pdf.txt`; without this every PDF and photo in
    // the transcript would render as a plain text file.
    expect(fileKind("report.pdf.txt")).toBe("pdf");
    expect(fileKind("photo.png.txt")).toBe("image");
  });

  it("falls back to text for anything unknown", () => {
    expect(fileKind("notes.txt")).toBe("text");
    expect(fileKind("LICENSE")).toBe("text");
    expect(fileKind("weird.qqq")).toBe("text");
  });
});

describe("fileBadge", () => {
  it("shows the extension the user actually attached", () => {
    expect(fileBadge("books.xlsx")).toBe("XLSX");
    expect(fileBadge("report.pdf.txt")).toBe("PDF");
    expect(fileBadge("notes.txt")).toBe("TXT");
  });

  it("never smears a whole filename across the tile", () => {
    // No extension to show, and a 38px tile cannot hold a name.
    expect(fileBadge("Makefile")).toBe("FILE");
    expect(fileBadge("archive.")).toBe("FILE");
    // Long extensions are cut rather than overflowing.
    expect(fileBadge("thing.superlongext")).toHaveLength(4);
  });
});

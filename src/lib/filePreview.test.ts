import { describe, expect, it } from "vitest";
import {
  fileExtension,
  isAudioFile,
  isImageFile,
  isMarkdownFile,
  isPdfFile,
  isSvgFile,
  isVideoFile,
  previewKindForPath,
} from "./filePreview";

describe("fileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(fileExtension("/a/b/README.MD")).toBe("md");
    expect(fileExtension("clip.MP4")).toBe("mp4");
  });

  it("returns empty for dotfiles and extensionless names", () => {
    expect(fileExtension("/a/b/.env")).toBe("");
    expect(fileExtension("/a/b/Makefile")).toBe("");
  });

  it("uses only the last segment", () => {
    expect(fileExtension("/a.b/archive.tar.gz")).toBe("gz");
  });
});

describe("previewKindForPath", () => {
  it("maps binary media to a preview", () => {
    expect(previewKindForPath("/x/photo.PNG")).toBe("image");
    expect(previewKindForPath("/x/doc.pdf")).toBe("pdf");
    expect(previewKindForPath("/x/clip.mp4")).toBe("video");
    expect(previewKindForPath("/x/song.flac")).toBe("audio");
  });

  it("leaves text and toggled previews to the editor", () => {
    expect(previewKindForPath("/x/main.ts")).toBeNull();
    expect(previewKindForPath("/x/notes.md")).toBeNull();
    expect(previewKindForPath("/x/icon.svg")).toBeNull();
  });
});

describe("predicates", () => {
  it("classifies the same set", () => {
    expect(isImageFile("a.jpeg")).toBe(true);
    expect(isPdfFile("a.pdf")).toBe(true);
    expect(isVideoFile("a.webm")).toBe(true);
    expect(isAudioFile("a.m4a")).toBe(true);
    expect(isMarkdownFile("a.markdown")).toBe(true);
    expect(isSvgFile("a.svg")).toBe(true);
  });

  it("does not treat unsupported containers as media", () => {
    expect(isVideoFile("a.mkv")).toBe(false);
    expect(isVideoFile("a.avi")).toBe(false);
  });
});

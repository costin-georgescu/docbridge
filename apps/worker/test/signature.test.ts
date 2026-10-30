import { describe, expect, it } from "@jest/globals";
import {
  matchesSignature,
  SIGNATURE_HEAD_BYTES,
} from "../src/delivery/signature";

const head = (bytes: number[]) => Uint8Array.from(bytes);

describe("matchesSignature", () => {
  it("accepts each allowlisted type's magic bytes", () => {
    expect(
      matchesSignature(
        "application/pdf",
        head([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
      ),
    ).toBe(true);
    expect(
      matchesSignature(
        "image/png",
        head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(true);
    expect(matchesSignature("image/jpeg", head([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      true,
    );
    for (const type of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]) {
      expect(matchesSignature(type, head([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    }
  });

  it("rejects bytes that do not match the declared type", () => {
    expect(
      matchesSignature(
        "application/pdf",
        head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(false);
    // A zip renamed to .pdf is still a zip.
    expect(
      matchesSignature("application/pdf", head([0x50, 0x4b, 0x03, 0x04])),
    ).toBe(false);
    expect(matchesSignature("image/jpeg", head([0xff, 0xd8, 0x00]))).toBe(
      false,
    );
  });

  it("rejects a head shorter than the signature", () => {
    expect(matchesSignature("image/png", head([0x89, 0x50, 0x4e]))).toBe(false);
    expect(matchesSignature("application/pdf", head([]))).toBe(false);
  });

  it("rejects unknown content types", () => {
    expect(matchesSignature("text/plain", head([0x25, 0x50, 0x44, 0x46]))).toBe(
      false,
    );
  });

  it("reads at most SIGNATURE_HEAD_BYTES", () => {
    expect(SIGNATURE_HEAD_BYTES).toBe(8);
  });
});

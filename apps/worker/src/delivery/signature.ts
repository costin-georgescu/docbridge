import { ALLOWED_UPLOAD_TYPES } from "@docbridge/contracts";

/**
 * Magic bytes per declared content type (TDD 2.7). DOCX and XLSX share the
 * zip signature and are told apart by the declared type only.
 */
const SIGNATURES: Record<string, readonly number[]> = {
  [ALLOWED_UPLOAD_TYPES.pdf]: [0x25, 0x50, 0x44, 0x46],
  [ALLOWED_UPLOAD_TYPES.png]: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [ALLOWED_UPLOAD_TYPES.jpg]: [0xff, 0xd8, 0xff],
  [ALLOWED_UPLOAD_TYPES.docx]: [0x50, 0x4b, 0x03, 0x04],
  [ALLOWED_UPLOAD_TYPES.xlsx]: [0x50, 0x4b, 0x03, 0x04],
};

export const SIGNATURE_HEAD_BYTES = 8;

export function matchesSignature(
  contentType: string,
  head: Uint8Array,
): boolean {
  const sig = SIGNATURES[contentType];
  if (!sig || head.length < sig.length) return false;
  return sig.every((byte, i) => head[i] === byte);
}

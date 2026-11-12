export const MAX_PROVIDER_IMAGE_BYTES = 5_000_000;

export type ProviderImageType = {
  mime: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
};

function bytes(value: Uint8Array, start: number, text: string) {
  if (start + text.length > value.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (value[start + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

export function detectProviderImage(value: Uint8Array): ProviderImageType | null {
  if (value.length === 0 || value.length > MAX_PROVIDER_IMAGE_BYTES) return null;
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (
    value.length >= 8 &&
    value[0] === 0x89 &&
    value[1] === 0x50 &&
    value[2] === 0x4e &&
    value[3] === 0x47 &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  ) {
    return { mime: "image/png", extension: "png" };
  }
  if (value.length >= 12 && bytes(value, 0, "RIFF") && bytes(value, 8, "WEBP")) {
    return { mime: "image/webp", extension: "webp" };
  }
  return null;
}

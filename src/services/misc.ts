export function encodeCursor(cursor: string): string {
  return Buffer.from(cursor).toString("base64");
}

export function decodeCursor(encodedCursor: string): string {
  return Buffer.from(encodedCursor, "base64").toString("ascii");
}

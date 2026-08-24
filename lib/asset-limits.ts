/**
 * The size ceiling for an uploaded image, in one place.
 *
 * It is needed on both sides of the wire — the route refuses anything larger, and the
 * editor shrinks a photo to fit before sending it — and the two must not be able to
 * disagree. A client that believed in a larger budget would produce uploads the server
 * rejects; a client that believed in a smaller one would degrade pictures nobody asked
 * it to touch.
 *
 * Its own module because of where the two sides live: `lib/server/request-limits.ts`
 * imports `next/server`, and `components/workspace/image-drop.ts` runs in a browser.
 * Neither can import the other, so the constant lives below both.
 *
 * The number is Vercel's, not a judgement: a serverless function refuses a request
 * body over roughly 4.5 MB before any of this code runs, and a limit enforced there
 * surfaces as an opaque platform error rather than a message naming the file. Four
 * megabytes sits under that with room for multipart framing.
 */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024

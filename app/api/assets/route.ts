import { NextRequest, NextResponse } from 'next/server'
import { resolveStore } from '@/lib/server/resolve-store'
import { InvalidPathError } from '@/lib/file-store'
import {
  MAX_ASSET_BYTES,
  assertDeclaredSize,
  enforceWriteRate,
  limitErrorResponse,
} from '@/lib/server/request-limits'
import { captureError } from '@/lib/server/observability'
import { IMAGE_CONTENT_TYPES, sniffImageType } from '@/lib/server/assets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Image upload and delivery.
 *
 *   POST /api/assets                     multipart/form-data, field `file`
 *   GET  /api/assets?path=assets/…       the bytes, typed and cacheable
 *
 * Both sit behind the session gate in middleware.ts. The public counterpart — the
 * same bytes reachable through a share token — is a separate route under
 * `/api/share/`, because the moment an unauthenticated reader can ask this one
 * anything, the answer becomes an existence oracle for the whole vault.
 *
 * What an upload is allowed to be is decided from the bytes, never from the request:
 * see sniffImageType. What it is stored as is decided by the store, never by the
 * client: the caller does not choose a path, so there is no path to escape from.
 */

function errorResponse(err: unknown): NextResponse {
  const limited = limitErrorResponse(err)
  if (limited) return limited

  if (err instanceof InvalidPathError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
  }

  captureError(err, { scope: 'api/assets', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

export async function POST(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    // Cheap refusal before the body is buffered at all.
    assertDeclaredSize(request, MAX_ASSET_BYTES)

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json(
        { error: 'Body must be multipart/form-data with a "file" field', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const file = form.get('file')
    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: 'Body must be multipart/form-data with a "file" field', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const bytes = new Uint8Array(await file.arrayBuffer())

    // The measurement, as opposed to the claim checked above.
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      return NextResponse.json(
        {
          error: `That image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ASSET_BYTES / 1024 / 1024} MB.`,
          code: 'PAYLOAD_TOO_LARGE',
        },
        { status: 413 }
      )
    }
    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: 'That file is empty', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const contentType = sniffImageType(bytes)
    if (!contentType) {
      // 415 rather than 400: the request is well-formed, its content is not something
      // this route will store. The accepted list is named so the message is actionable
      // — in particular for SVG, which is refused on purpose and not by oversight.
      return NextResponse.json(
        {
          error: `That file is not an image this workspace can store. Accepted: ${Object.values(
            IMAGE_CONTENT_TYPES
          )
            .filter((type, i, all) => all.indexOf(type) === i)
            .join(', ')}.`,
          code: 'UNSUPPORTED_MEDIA_TYPE',
        },
        { status: 415 }
      )
    }

    const filename = file instanceof File ? file.name : undefined
    const result = await (await resolveStore(request)).writeAsset({ bytes, contentType, filename })

    return NextResponse.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(request: NextRequest) {
  try {
    const path = request.nextUrl.searchParams.get('path')
    if (!path) throw new InvalidPathError('', 'missing "path" query parameter')

    const asset = await (await resolveStore(request)).readAsset(path)
    if (!asset) {
      return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    return new NextResponse(Buffer.from(asset.bytes), {
      headers: {
        'Content-Type': asset.contentType,
        'Content-Length': String(asset.bytes.byteLength),
        /**
         * Immutable, and safe to be: the key contains a hash of the bytes, so a given
         * path can never come to mean different content. `private` because this route
         * is behind a session — a shared cache holding the response would serve one
         * workspace's images to whoever asked next.
         */
        'Cache-Control': 'private, max-age=31536000, immutable',
        /**
         * These bytes came from a user and are served same-origin. `nosniff` stops a
         * browser from deciding for itself that something declared `image/png` is
         * really HTML and running it — which is the whole attack that keeping SVG out
         * of the allowlist also guards against.
         */
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

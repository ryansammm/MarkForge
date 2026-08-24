import { createHash } from 'crypto'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { BinaryObject, Bucket } from './bucket'
import { contentTypeForKey } from './assets'

/**
 * Cloudflare R2 bucket, over the S3-compatible API.
 *
 * Two things object storage does not have, and how they are handled:
 *
 * **No directories.** The keyspace is flat; a "folder" is a key prefix. Sprint 4
 * made empty folders first-class, so an empty folder is recorded as a zero-byte
 * `<prefix>/.keep` marker. Markers are filtered out of `listKeys`, so they never
 * reach the index or a reindex. They are visible to anyone browsing the bucket
 * directly, which is the standard cost of this convention.
 *
 * **No atomic rename.** A move is copy-then-delete. The store performs moves inside
 * its serialized queue and re-reads content, so a half-completed move leaves the
 * source intact rather than losing it.
 *
 * Known limitation, stated plainly: the store's write queue serializes operations
 * *within one process*. On serverless there are many processes, so two instances
 * writing the same document can still interleave. The If-Match precondition catches
 * the common case; closing it fully needs conditional writes at the bucket layer,
 * and that belongs with Sprint 5's conflict handling rather than here.
 */

const FOLDER_MARKER = '.keep'

export interface R2BucketOptions {
  accountId?: string
  accessKeyId?: string
  secretAccessKey?: string
  bucket?: string
  /** Overrides the derived R2 endpoint. Useful for S3-compatible alternatives. */
  endpoint?: string
  /** Key prefix for documents. Metadata is stored alongside, not beneath it. */
  documentPrefix?: string
  /**
   * Key prefix for metadata — index.json, shares.json, the trash.
   *
   * Defaults to `_meta`, which is **shared by every prefix in the bucket**. That is
   * fine for a deployment, where one workspace owns the bucket, and actively
   * dangerous for a test: pointing `documentPrefix` somewhere scratch isolates the
   * documents and nothing else, so a suite run against real credentials writes its
   * index over the live one. Anything that is not the deployment should set this.
   */
  metaPrefix?: string
}

export function r2ConfigFromEnv(): Required<
  Pick<R2BucketOptions, 'accountId' | 'accessKeyId' | 'secretAccessKey' | 'bucket'>
> | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null
  return { accountId, accessKeyId, secretAccessKey, bucket }
}

export class R2Bucket implements Bucket {
  readonly kind = 'r2'

  private readonly client: S3Client
  private readonly bucket: string
  private readonly documentPrefix: string
  private readonly metaPrefix: string

  /** The endpoint actually in use. Exposed for diagnostics; contains no secrets. */
  readonly endpoint: string

  constructor(options: R2BucketOptions = {}) {
    // Trimmed because environment variables pasted into a dashboard routinely
    // arrive with a trailing newline, and an untrimmed account id produces a
    // hostname that fails in ways that look nothing like "you have a typo".
    const accountId = trim(options.accountId ?? process.env.R2_ACCOUNT_ID)
    const accessKeyId = trim(options.accessKeyId ?? process.env.R2_ACCESS_KEY_ID)
    const secretAccessKey = trim(options.secretAccessKey ?? process.env.R2_SECRET_ACCESS_KEY)
    const bucket = trim(options.bucket ?? process.env.R2_BUCKET)

    if (!accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        'R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.'
      )
    }

    this.endpoint = resolveEndpoint({
      explicit: trim(options.endpoint ?? process.env.R2_ENDPOINT),
      accountId,
      jurisdiction: trim(process.env.R2_JURISDICTION),
    })

    this.bucket = bucket
    this.documentPrefix = (trim(options.documentPrefix ?? process.env.R2_PREFIX) ?? 'notes').replace(
      /\/+$/,
      ''
    )
    // Default unchanged, deliberately: an existing deployment's index.json and
    // shares.json are at `_meta/`, and shares.json holds live tokens. Moving them
    // would break every link already sent.
    this.metaPrefix = (trim(options.metaPrefix ?? process.env.R2_META_PREFIX) ?? '_meta').replace(
      /\/+$/,
      ''
    )

    this.client = new S3Client({
      // R2 ignores the region but the SDK insists on one.
      region: 'auto',
      endpoint: this.endpoint,
      credentials: { accessKeyId, secretAccessKey },

      /**
       * REQUIRED for R2, and the cause of a real outage if omitted.
       *
       * With the SDK default (virtual-hosted style) a request goes to
       * `<bucket>.<account>.r2.cloudflarestorage.com`. Cloudflare serves a wildcard
       * certificate for `*.r2.cloudflarestorage.com`, and a wildcard matches exactly
       * one label — so that two-label host is not covered, the server aborts the
       * handshake, and every single request dies with:
       *
       *   Error: write EPROTO … ssl3_read_bytes:tls alert handshake failure … alert number 40
       *
       * which reads like a network or credentials problem and is neither. Path style
       * keeps the host at `<account>.r2.cloudflarestorage.com` and puts the bucket in
       * the path, where the certificate matches.
       */
      forcePathStyle: true,
    })
  }

  private documentKey(key: string): string {
    return this.documentPrefix ? `${this.documentPrefix}/${key}` : key
  }

  private stripPrefix(key: string): string {
    if (!this.documentPrefix) return key
    return key.startsWith(`${this.documentPrefix}/`)
      ? key.slice(this.documentPrefix.length + 1)
      : key
  }

  private metaKey(name: string): string {
    return `${this.metaPrefix}/${name}`
  }

  /**
   * ETag of the last body read back for a metadata key, keyed by a hash of that body.
   *
   * This is what lets `writeMetaIfUnchanged` express its precondition as "the object
   * still holds the bytes I read" without assuming anything about how the service
   * derives an ETag. Only two short strings per key are kept, never the body.
   */
  private readonly metaEtags = new Map<string, { bodyHash: string; etag: string }>()

  private async getText(key: string, remember = false): Promise<string | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      )
      const body = (await result.Body?.transformToString()) ?? null

      if (remember && body !== null && result.ETag) {
        this.metaEtags.set(key, { bodyHash: md5(body), etag: result.ETag })
      }
      return body
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  private async putText(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        // Stated rather than inferred. Folder markers have an empty body, and the SDK
        // cannot measure one — it warns "Are you using a Stream of unknown length as
        // the Body of a PutObject request?" and falls back to chunked encoding, which
        // some S3-compatible endpoints reject outright.
        ContentLength: Buffer.byteLength(body, 'utf8'),
        ContentType: key.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8',
      })
    )
  }

  /** Every key under a prefix, paginating until the listing is exhausted. */
  private async listAll(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined

    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        })
      )
      for (const item of result.Contents ?? []) {
        if (item.Key) keys.push(item.Key)
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (token)

    return keys
  }

  // --- documents ------------------------------------------------------------

  async readText(key: string): Promise<string | null> {
    return this.getText(this.documentKey(key))
  }

  async writeText(key: string, body: string): Promise<void> {
    await this.putText(this.documentKey(key), body)
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.documentKey(key) })
    )
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.documentKey(key) })
      )
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    // Folder markers are bookkeeping, not documents. If they leaked into the index a
    // reindex would invent a note called ".keep" in every folder.
    return this.listObjects(prefix, (key) => key.endsWith('.md'))
  }

  // --- binary objects -------------------------------------------------------

  /**
   * Reads bytes.
   *
   * `transformToByteArray`, not `transformToString`. The string path decodes as UTF-8
   * and replaces anything invalid with U+FFFD, so an image read through it comes back
   * silently corrupted at roughly the right length — a failure that survives a casual
   * "did the download work?" and shows up as a broken picture later.
   */
  async readBinary(key: string): Promise<BinaryObject | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.documentKey(key) })
      )
      const bytes = await result.Body?.transformToByteArray()
      if (!bytes) return null

      // What the bucket recorded, falling back to the extension for objects written
      // before this method existed or by something other than this app.
      return { bytes, contentType: result.ContentType || contentTypeForKey(key) }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async writeBinary(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.documentKey(key),
        Body: bytes,
        // Stated for the same reason putText states it — see the note there.
        ContentLength: bytes.byteLength,
        ContentType: contentType,
      })
    )
  }

  async listBinaryKeys(prefix?: string): Promise<string[]> {
    return this.listObjects(prefix, (key) => !key.endsWith('.md'))
  }

  async statObject(key: string): Promise<{ size: number; modifiedAt: string } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.documentKey(key) })
      )
      return {
        size: result.ContentLength ?? 0,
        modifiedAt: (result.LastModified ?? new Date(0)).toISOString(),
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  /** Keys under `prefix`, stripped of the document prefix, minus folder markers. */
  private async listObjects(
    prefix: string | undefined,
    accept: (key: string) => boolean
  ): Promise<string[]> {
    const search = prefix
      ? this.documentKey(prefix.replace(/\/+$/, ''))
      : this.documentPrefix || ''

    const keys = await this.listAll(search)
    return keys
      .map((key) => this.stripPrefix(key))
      .filter((key) => accept(key) && !key.endsWith(`/${FOLDER_MARKER}`))
      .sort()
  }

  // --- folders --------------------------------------------------------------

  async createFolder(prefix: string): Promise<void> {
    const clean = prefix.replace(/\/+$/, '')
    // Every ancestor gets a marker too, so listFolders can reconstruct the tree
    // even when only a deep folder was created.
    const segments = clean.split('/').filter(Boolean)
    let walked = ''
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment
      await this.putText(this.documentKey(`${walked}/${FOLDER_MARKER}`), '')
    }
  }

  async deleteFolder(prefix: string): Promise<void> {
    const clean = prefix.replace(/\/+$/, '')
    const keys = await this.listAll(this.documentKey(clean))
    if (keys.length === 0) return

    // DeleteObjects caps at 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        })
      )
    }
  }

  async folderExists(prefix: string): Promise<boolean> {
    const clean = prefix.replace(/\/+$/, '')
    if (await this.markerExists(clean)) return true
    // A folder that only ever held documents has no marker; its existence is
    // implied by anything living under it.
    const keys = await this.listAll(`${this.documentKey(clean)}/`)
    return keys.length > 0
  }

  private async markerExists(prefix: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.documentKey(`${prefix}/${FOLDER_MARKER}`),
        })
      )
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async listFolders(): Promise<string[]> {
    const keys = await this.listAll(this.documentPrefix || '')
    const folders = new Set<string>()

    for (const raw of keys) {
      const key = this.stripPrefix(raw)
      const segments = key.split('/')
      segments.pop() // the object itself
      let walked = ''
      for (const segment of segments) {
        walked = walked ? `${walked}/${segment}` : segment
        folders.add(walked)
      }
    }

    return Array.from(folders).sort()
  }

  // --- metadata -------------------------------------------------------------

  async readMeta(name: string): Promise<string | null> {
    return this.getText(this.metaKey(name), true)
  }

  async writeMeta(name: string, body: string): Promise<void> {
    await this.putText(this.metaKey(name), body)
  }

  async listMeta(prefix: string): Promise<string[]> {
    const keys = await this.listAll(this.metaKey(prefix))
    return keys.map((key) => key.slice(this.metaPrefix.length + 1)).sort()
  }

  async deleteMeta(name: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.metaKey(name) }))
  }

  /**
   * Compare-and-set, over R2's conditional PUT.
   *
   * The precondition has to mean **"the object still holds the bytes I read"**, and
   * HTTP can only express it as an ETag. The two are bridged by remembering the ETag
   * that came back with the body on read: if the caller is passing that same body
   * back as `expected`, its ETag is known exactly, and nothing is assumed about how
   * the service computes one.
   *
   * The fallback — MD5, which is what S3 and R2 return for a single-part upload —
   * only applies when that memory is missing, such as after a cold start. Getting the
   * fallback wrong is safe in the direction that matters: the PUT is refused, the
   * caller re-reads and retries, and the retry has the remembered ETag.
   *
   * Asking for the ETag with a HEAD instead would be subtly wrong. It would bind the
   * precondition to whatever the object holds *now* rather than to what was read, so
   * a write landing between the read and the HEAD would be silently overwritten —
   * which is the exact lost update this method exists to prevent.
   *
   * A failed precondition comes back as 412. That is a normal outcome, not an error.
   */
  async writeMetaIfUnchanged(name: string, body: string, expected: string | null): Promise<boolean> {
    const key = this.metaKey(name)

    let condition: { IfNoneMatch: string } | { IfMatch: string }
    if (expected === null) {
      condition = { IfNoneMatch: '*' }
    } else {
      const remembered = this.metaEtags.get(key)
      const expectedHash = md5(expected)
      condition = {
        IfMatch:
          remembered && remembered.bodyHash === expectedHash ? remembered.etag : `"${expectedHash}"`,
      }
    }

    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: name.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8',
          ...condition,
        })
      )

      // Remember what we just wrote, so the next update in this process has an exact
      // ETag without re-reading.
      if (result.ETag) this.metaEtags.set(key, { bodyHash: md5(body), etag: result.ETag })
      else this.metaEtags.delete(key)

      return true
    } catch (err) {
      if (isPreconditionFailed(err)) {
        // Our idea of the current ETag was wrong by definition. Drop it rather than
        // retrying against the same bad value.
        this.metaEtags.delete(key)
        return false
      }
      throw err
    }
  }
}

function md5(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('hex')
}

function trim(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Works out the endpoint, and refuses the configurations that fail confusingly.
 *
 * Every rejection here corresponds to something that otherwise surfaces as a TLS
 * or signature error hundreds of milliseconds away from its cause.
 */
export function resolveEndpoint(input: {
  explicit?: string
  accountId?: string
  jurisdiction?: string
}): string {
  if (input.explicit) {
    let url: URL
    try {
      url = new URL(input.explicit)
    } catch {
      throw new Error(
        `R2_ENDPOINT is not a valid URL: ${JSON.stringify(input.explicit)}. ` +
          'Expected something like https://<account-id>.r2.cloudflarestorage.com'
      )
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      // The dashboard shows an "S3 API" URL with the bucket appended. Pasting that
      // whole string produces requests to /<bucket>/<bucket>/<key>.
      throw new Error(
        `R2_ENDPOINT must not include a path (got ${JSON.stringify(url.pathname)}). ` +
          'The bucket belongs in R2_BUCKET, not the endpoint.'
      )
    }
    return url.origin
  }

  if (!input.accountId) {
    throw new Error('R2 endpoint could not be derived. Set R2_ACCOUNT_ID or R2_ENDPOINT.')
  }

  if (/[:/]/.test(input.accountId)) {
    throw new Error(
      `R2_ACCOUNT_ID looks like a URL (${JSON.stringify(input.accountId)}). ` +
        'It should be just the account id. Use R2_ENDPOINT for a full URL.'
    )
  }

  // EU-jurisdiction buckets live on a different host, and using the default one
  // against them fails at the TLS layer rather than with a helpful 404.
  const prefix = input.jurisdiction ? `${input.accountId}.${input.jurisdiction}` : input.accountId
  return `https://${prefix}.r2.cloudflarestorage.com`
}

/**
 * A conditional PUT whose precondition did not hold.
 *
 * R2 answers 412 for a failed `If-Match` and 412 for a failed `If-None-Match: *`;
 * S3-compatible services also use 409 for the latter under concurrent creation.
 * Both mean the same thing to the caller: someone else got there first.
 */
function isPreconditionFailed(err: unknown): boolean {
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    error?.name === 'PreconditionFailed' ||
    error?.$metadata?.httpStatusCode === 412 ||
    error?.$metadata?.httpStatusCode === 409
  )
}

function isNotFound(err: unknown): boolean {
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    error?.name === 'NoSuchKey' ||
    error?.name === 'NotFound' ||
    error?.$metadata?.httpStatusCode === 404
  )
}

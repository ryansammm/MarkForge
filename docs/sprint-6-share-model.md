# Share model (PRD R8, Sprint 6 P0)

**Status:** Built. Replaces a share route that had no share model.

---

## What was wrong

The previous route resolved a URL segment against every document in the index by id,
title, alias or filename, and `middleware.ts` exempted `/share` and `/api/share` from
the password gate. Together that published the whole corpus: any note was readable by
anyone who could guess its name. Nothing was opt-in and nothing could be revoked.

Verified before the fix, on a document created and never shared:

```
/share/Salary%20Review%202026  ->  200
    "# Salary Review 2026   Alex: 120k. Never shared with anyone."
```

The gate was closed first (commit `859cc91`), turning sharing off. This restores it
properly.

## The model

`shares.json`, beside the index:

```jsonc
{
  "shares": [
    {
      "token": "3xK9pQ...",      // 128 random bits, base64url — the only resolution key
      "path": "Guide",           // document path, or folder path for subtree
      "scope": "subtree",        // "document" | "subtree"
      "createdAt": "2026-08-06T...",
      "revokedAt": null,         // ISO timestamp once revoked
      "label": "Guide"           // for the manage list only, never for resolution
    }
  ]
}
```

It lives beside `index.json` rather than inside it because the index is explicitly
disposable — Sprint 5 wipes and rebuilds it from the bucket. A rebuilt index must
never invalidate a link someone already sent. There is a test for that.

`shares.json` is gitignored: it holds live credentials.

## The properties that matter

**Resolution is by token and nothing else.** Not title, not path, not document id.
Possession of the token is the authorization, which is what makes the middleware
exemption safe. Nothing in `ShareStore` should ever grow a lookup taking a
human-readable name as input.

**Every failure is the same 404.** Unknown token, revoked token, a path outside the
share's scope, a deleted file, an internal fault — one response, one body. PRD R8: a
403 confirms the resource exists, which turns a revoked link into an existence oracle
and tells an attacker when a guess was structurally right. The route even answers 404
on an internal error, because a 500 on a valid token and a 404 on an invalid one are
distinguishable, and that difference is the leak.

**Scope is enforced with a trailing slash.** `isPathInScope` requires
`path === base || path.startsWith(base + '/')`. Without the slash, sharing `Guide`
would also publish `Guide-Private/`. Tested directly.

**Out-of-scope links are never named.** `inScopeLinks` is computed against the
in-scope documents only, not by resolving against the whole index and filtering. The
absence of a link is information too — a reader must not be able to tell whether a
document they cannot reach exists. Out-of-scope wikilinks render as plain text, never
as broken links.

**The plural trap.** `/api/share/<token>` is public; `/api/shares` is the private
management route that lists every share with its live tokens. `"/api/shares"
.startsWith("/api/share")` is `true`, so a prefix test without the trailing slash
would exempt the management route and hand every token to anyone who asked.
`middleware.ts` matches `/api/share/` with the slash, and there is a test named after
the trap.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/share/<token>` | **public** | Read a shared document. `?path=` selects a document inside a subtree share. |
| `GET /share/<token>` | **public** | The reader page. No editor bundle. |
| `GET /api/shares` | gated | List all shares, live and revoked |
| `POST /api/shares` | gated | Create — `{ path, scope }` |
| `DELETE /api/shares?token=` | gated | Revoke |

Subtree shares land on `Index.md`, `README.md` or `Home.md` at the folder root, then
fall back to the first document in path order — a folder is not a document, and the
link should lead somewhere.

Responses set `Cache-Control: no-store` so a revocation takes effect immediately
rather than being outlived by a cached copy, and `X-Robots-Tag: noindex`.

## Not done

- **Custom domains and SEO control.** The competitive brief argues this is where the
  real differentiation sits; it is not built.
- **Analytics.** No view counts.
- **Expiring links.** Revocation is manual.
- **Password-protected shares.** A token is all-or-nothing.
- **`<1.5s` cold load measured.** The DoD asks for a number; none has been taken. The
  reader page imports no editor code, but that has not been measured either — this
  Next version's build output does not emit per-route sizes.

## Storage

Shares go through the same `Bucket` as documents — `shares.json` is metadata beside
the index, not a local file. Writing tokens to the local filesystem would mean a
share created on one serverless instance was invisible to the next, so links would
work intermittently, which is worse than not working at all.

The R2 backend now exists (see [storage-backends.md](./storage-backends.md)), so
sharing works on the deployment target once R2 is configured. Without that
configuration on Vercel, `backendHealth()` reports `durable: false` — the app says
so rather than silently forgetting writes.

**Caveat:** the R2 backend has never run against real Cloudflare credentials. Treat
it as untested integration until it has.

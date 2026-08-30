# encrypted-r2 Specification

## Purpose

Specifies how MarkForge encrypts note bodies and the password-vault
blob before they are stored in Cloudflare R2, and how the master
password unlocks them. The R2 bucket never sees plaintext bodies or
the password-vault plaintext.

## Requirements

### Requirement: Master password derives the encryption key

The client SHALL derive a 32-byte AES-GCM key from the master
password using Argon2id (`t=3`, `m=64MB`, `p=1`). The salt SHALL be
16 random bytes generated on first vault creation and stored at
`R2 key vaults/.salt` in plaintext (Argon2id salt is not a secret).

#### Scenario: First unlock

- **WHEN** the user sets a master password for the first time
- **THEN** a salt is generated and stored, a key is derived, and
  the key is held in memory only (no persistence in
  `localStorage`, `sessionStorage`, or cookies)

#### Scenario: Subsequent unlock

- **WHEN** the user re-enters the master password
- **THEN** the salt is read from `R2 key vaults/.salt`, the key
  is re-derived, and the same in-memory key is reproduced

### Requirement: Note bodies are encrypted client-side

The client SHALL encrypt note bodies with AES-GCM using the
derived key before sending them to `PUT /api/files`. The server
SHALL store the ciphertext verbatim and SHALL NOT inspect it.

#### Scenario: Write a note

- **WHEN** the client saves a document
- **THEN** the wire body is `base64url(iv) + "." + base64url(ciphertext+tag)`,
  the IV is 12 random bytes, and the server stores the string
  without modification

#### Scenario: Read a note

- **WHEN** the client reads a document
- **THEN** the client decrypts the blob with the in-memory key
  and renders the plaintext

### Requirement: Index metadata stays plaintext

The client SHALL keep the document index (path, title, parent_id,
mtime, etag, word count) in plaintext in R2 so the sidebar can
render without an unlocked vault.

#### Scenario: Vault locked, sidebar still works

- **WHEN** the user has not entered the master password
- **THEN** the sidebar still lists all documents, the search
  box still matches against titles, and clicking a document
  shows a placeholder body ("Unlock to read")

### Requirement: Password vault uses the same key

The existing password-vault blob SHALL be encrypted with the same
derived key. Unlocking the master password unlocks both the
password-vault items and the note bodies.

#### Scenario: Single unlock

- **WHEN** the user enters the master password once
- **THEN** the password-vault dialog becomes usable AND the
  note bodies become readable AND the note body editor
  becomes writable

### Requirement: Lost master password means lost data

The system SHALL provide no recovery path for the master password.
The lock screen SHALL display a one-line warning to that effect
before the user submits the password for the first time.

#### Scenario: User forgets the master password

- **WHEN** the user cannot remember the master password
- **THEN** there is no server-side or client-side fallback to
  read the note bodies or the password-vault items

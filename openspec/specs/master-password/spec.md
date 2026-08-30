# master-password Specification

## Purpose

Specifies the length floor and validation behaviour for the vault master
password that encrypts every note in the active workspace.

## Requirements

### Requirement: Vault master password must be at least 8 characters

The vault master password is the secret that derives the per-note AES-GCM
key. The minimum length is 8 characters. Shorter input is rejected before
any key derivation runs, with a distinct error from the wrong-password
case so the UI can show a different message.

#### Scenario: An 8-character password is accepted

- **WHEN** the user creates or opens a vault with a password of exactly
  8 characters
- **THEN** `deriveKey` returns a 256-bit key
- **AND** the existing `createEnvelope` / `openRecord` round-trip works
  unchanged against that key

#### Scenario: A 7-character password is rejected

- **WHEN** the user submits a password shorter than 8 characters
- **THEN** `deriveKey` throws `VaultPasswordTooShortError`
- **AND** no key material is derived or stored

#### Scenario: The wrong-password error remains distinct

- **WHEN** the user submits a password of valid length that does not
  match the vault's master
- **THEN** `openRecord` throws `VaultUnlockError`
- **AND** that error class is not `VaultPasswordTooShortError`
- **SO** the UI can show "wrong password" instead of "password too short"

### Requirement: `MIN_VAULT_MASTER_LENGTH` is the single source of truth

The length floor lives in `lib/vault/record.ts` as
`MIN_VAULT_MASTER_LENGTH = 8`. The `isValidVaultMaster` predicate reads
this constant; the UI floor reads the same constant; the `deriveKey`
length check reads the same constant. The number 8 must not appear as a
literal in the call sites.

#### Scenario: Call sites do not hardcode 8

- **WHEN** the validation paths in `lib/vault/crypto.ts` and
  `components/workspace/passwords-dialog.tsx` are inspected
- **THEN** the length comparison references `MIN_VAULT_MASTER_LENGTH`
- **AND** no comparison against a literal `8` exists in those files
